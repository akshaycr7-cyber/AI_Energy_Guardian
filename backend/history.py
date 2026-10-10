"""Dashboard history storage with Supabase and safe local-demo fallback.

Supabase keys are read only by this backend process. The browser talks
exclusively to FastAPI's public dashboard/history endpoint.
"""
from __future__ import annotations

import os
import logging
import re
from collections import deque
from threading import Lock
from typing import Any, Protocol
from uuid import uuid4

import httpx

# Load the project-root .env before this module selects its storage
# implementation below.
from backend.config import load_project_environment

load_project_environment()


logger = logging.getLogger(__name__)
_REST_API_SUFFIX = "/rest/v1"
_ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,15}$")


class StorageError(RuntimeError):
    """Raised when configured persistent storage cannot complete a request."""


class HistoryStore(Protocol):
    storage_name: str

    def add(self, item: dict[str, Any]) -> str: ...

    def recent(self, limit: int) -> list[dict[str, Any]]: ...


class DemoHistory:
    """Short-lived process-local history for no-credential simulation mode."""

    storage_name = "process-local demo history"

    def __init__(self, maximum_items: int = 200) -> None:
        self._items: deque[dict[str, Any]] = deque(maxlen=maximum_items)
        self._lock = Lock()

    def add(self, item: dict[str, Any]) -> str:
        record = {"id": str(uuid4()), **item}
        with self._lock:
            self._items.append(record)
        return record["id"]

    def recent(self, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            return list(reversed(list(self._items)[-limit:]))

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


class SupabaseHistory:
    """Supabase PostgreSQL adapter using its server-side REST/RPC interface."""

    storage_name = "Supabase PostgreSQL"

    def __init__(
        self,
        url: str,
        api_key: str,
        client: httpx.Client | None = None,
        *,
        use_legacy_bearer_auth: bool = True,
    ) -> None:
        # Supabase supplies a project URL, while this adapter owns the REST API
        # path. Accept an accidentally pasted REST endpoint without making a
        # duplicated /rest/v1/rest/v1 request.
        supplied_url = url.rstrip("/")
        if supplied_url.lower().endswith(_REST_API_SUFFIX):
            supplied_url = supplied_url[: -len(_REST_API_SUFFIX)]
        self.base_url = supplied_url
        self._client = client or httpx.Client(timeout=10.0)
        self._headers = {
            "apikey": api_key,
            "Content-Type": "application/json",
        }
        # Legacy service_role keys are JWTs. New sb_secret_ keys are not JWTs
        # and must be sent only in the apikey header.
        if use_legacy_bearer_auth:
            self._headers["Authorization"] = f"Bearer {api_key}"

    def _rpc(self, function: str, payload: dict[str, Any]) -> Any:
        response: httpx.Response | None = None
        try:
            response = self._client.post(
                f"{self.base_url}/rest/v1/rpc/{function}", headers=self._headers, json=payload
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            self._log_rpc_failure(function, exc.response.status_code, self._response_error_message(exc.response))
            raise StorageError(
                "Supabase storage request failed. Confirm SUPABASE_URL, the backend-only "
                "SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), and the applied migration."
            ) from exc
        except httpx.HTTPError as exc:
            self._log_rpc_failure(function, None, f"Network error: {exc.__class__.__name__}")
            raise StorageError(
                "Supabase storage request failed. Confirm SUPABASE_URL, the backend-only "
                "SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), and the applied migration."
            ) from exc
        except ValueError as exc:
            self._log_rpc_failure(
                function,
                response.status_code if response is not None else None,
                "Response JSON could not be decoded.",
            )
            raise StorageError(
                "Supabase storage request failed. Confirm SUPABASE_URL, the backend-only "
                "SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), and the applied migration."
            ) from exc

    @staticmethod
    def _response_error_message(response: httpx.Response) -> str:
        """Extract only a safe structured code, never a raw API error body."""
        try:
            body = response.json()
        except ValueError:
            return "HTTP error response without a JSON diagnostic."
        if not isinstance(body, dict):
            return "HTTP error response without a structured diagnostic."
        code = body.get("code")
        if isinstance(code, str) and _ERROR_CODE_PATTERN.fullmatch(code):
            return f"Supabase error code {code}."
        return "HTTP error response without a safe structured code."

    @staticmethod
    def _log_rpc_failure(function: str, status: int | None, message: str) -> None:
        logger.warning(
            "Supabase RPC failed operation=%s status=%s message=%s",
            function,
            status if status is not None else "unavailable",
            message,
        )

    def add(self, item: dict[str, Any]) -> str:
        result = self._rpc(
            "record_evaluation",
            {
                "p_timestamp": item["timestamp"],
                "p_reading": item["reading"],
                "p_prediction": item["prediction"],
                "p_decision": item["decision"],
                "p_sensor_data_status": item["sensor_data_status"],
                "p_power_status": item["power_status"],
            },
        )
        if not isinstance(result, str):
            raise StorageError("Supabase record_evaluation returned an unexpected response.")
        return result

    def recent(self, limit: int) -> list[dict[str, Any]]:
        result = self._rpc("dashboard_history", {"p_limit": limit})
        if not isinstance(result, list):
            raise StorageError("Supabase dashboard_history returned an unexpected response.")
        try:
            return [row["record"] for row in result]
        except (KeyError, TypeError) as exc:
            raise StorageError("Supabase dashboard_history returned an invalid record.") from exc


def create_history_from_environment() -> HistoryStore:
    """Choose durable storage from one backend-only Supabase credential."""
    url = os.getenv("SUPABASE_URL", "").strip()
    secret_key = os.getenv("SUPABASE_SECRET_KEY", "").strip()
    legacy_service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if secret_key and legacy_service_role_key:
        raise StorageError(
            "Both SUPABASE_SECRET_KEY and legacy SUPABASE_SERVICE_ROLE_KEY are configured. "
            "Set exactly one key."
        )
    key = secret_key or legacy_service_role_key
    if not url and not key:
        return DemoHistory()
    if not url or not key:
        raise StorageError(
            "Supabase is partially configured. Set SUPABASE_URL and exactly one of "
            "SUPABASE_SECRET_KEY or legacy SUPABASE_SERVICE_ROLE_KEY, or remove all "
            "three variables for local simulation mode."
        )
    if not url.startswith(("https://", "http://")):
        raise StorageError("SUPABASE_URL must be an http(s) URL.")
    if secret_key and not secret_key.startswith("sb_secret_"):
        raise StorageError("SUPABASE_SECRET_KEY must use the Supabase Secret key format (sb_secret_...).")
    return SupabaseHistory(url, key, use_legacy_bearer_auth=bool(legacy_service_role_key))


# Tests can replace this object; production resolves configuration at startup.
history: HistoryStore = create_history_from_environment()
