from __future__ import annotations

from typing import Any

import httpx
import pytest

from backend import config
from backend.history import DemoHistory, StorageError, SupabaseHistory, create_history_from_environment


class FakeResponse:
    def __init__(self, body: Any) -> None:
        self.body = body

    def raise_for_status(self) -> None:
        return None

    def json(self) -> Any:
        return self.body


class FakeClient:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, **kwargs: Any) -> Any:
        self.calls.append({"url": url, **kwargs})
        return FakeResponse(self.responses.pop(0))


class FailingClient:
    def post(self, url: str, **kwargs: Any) -> FakeResponse:
        raise httpx.ConnectError("offline")


def sample_record() -> dict[str, Any]:
    return {
        "timestamp": "2026-10-09T08:00:00+00:00",
        "reading": {"timestamp": "2026-10-09T08:00:00+00:00", "occupancy": 12},
        "prediction": {"occupancy_prediction": "Occupied", "predicted_fan_count": 2, "predicted_light_count": 2},
        "decision": {"recommended_fan_count": 2, "recommended_light_count": 2, "reason": "Occupied classroom.", "ai_mode": "AI_AUTO", "hardware_control_enabled": False},
        "sensor_data_status": {"kind": "simulated", "message": "Simulated value."},
        "power_status": "unavailable",
    }


def test_legacy_service_role_adapter_preserves_bearer_header_compatibility() -> None:
    record = sample_record()
    client = FakeClient(["db-record-id", [{"record": {"id": "db-record-id", **record}}]])
    storage = SupabaseHistory("https://example.supabase.co", "server-secret", client=client)

    assert storage.add(record) == "db-record-id"
    assert storage.recent(10) == [{"id": "db-record-id", **record}]
    assert client.calls[0]["url"].endswith("/rest/v1/rpc/record_evaluation")
    assert client.calls[1]["json"] == {"p_limit": 10}
    assert client.calls[0]["headers"]["apikey"] == "server-secret"
    assert client.calls[0]["headers"]["Authorization"] == "Bearer server-secret"


def test_secret_key_adapter_uses_apikey_without_authorization_header() -> None:
    client = FakeClient(["db-record-id"])
    storage = SupabaseHistory(
        "https://example.supabase.co",
        "sb_secret_test_placeholder",
        client=client,
        use_legacy_bearer_auth=False,
    )

    assert storage.add(sample_record()) == "db-record-id"
    assert client.calls[0]["headers"]["apikey"] == "sb_secret_test_placeholder"
    assert "Authorization" not in client.calls[0]["headers"]


def test_rest_api_suffix_is_not_duplicated_in_rpc_url() -> None:
    client = FakeClient([[{"record": sample_record()}]])
    storage = SupabaseHistory(
        "https://example.supabase.co/rest/v1/",
        "sb_secret_test_placeholder",
        client=client,
        use_legacy_bearer_auth=False,
    )

    storage.recent(10)

    assert client.calls[0]["url"] == "https://example.supabase.co/rest/v1/rpc/dashboard_history"


def test_rpc_http_failure_logs_safe_operation_status_and_message(caplog) -> None:
    class ErrorClient:
        def post(self, url: str, **kwargs: Any) -> httpx.Response:
            return httpx.Response(
                404,
                json={"code": "PGRST202", "message": "Route not found for sb_secret_sensitive-value"},
                request=httpx.Request("POST", url),
            )

    storage = SupabaseHistory(
        "https://example.supabase.co",
        "sb_secret_test_placeholder",
        client=ErrorClient(),
        use_legacy_bearer_auth=False,
    )

    with pytest.raises(StorageError, match="Supabase storage request failed"):
        storage.add(sample_record())

    assert "operation=record_evaluation" in caplog.text
    assert "status=404" in caplog.text
    assert "Supabase error code PGRST202" in caplog.text
    assert "sensitive-value" not in caplog.text


def test_no_supabase_variables_selects_local_simulation_storage(monkeypatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    assert isinstance(create_history_from_environment(), DemoHistory)


def test_project_root_dotenv_loads_before_supabase_storage_selection(tmp_path, monkeypatch) -> None:
    """The configured project .env, rather than the launch directory, controls storage."""
    dotenv_file = tmp_path / ".env"
    dotenv_file.write_text(
        "SUPABASE_URL=https://example.supabase.co\n"
        "SUPABASE_SECRET_KEY=sb_secret_test_placeholder\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setattr(config, "ENV_FILE", dotenv_file)

    assert config.load_project_environment() is True
    storage = create_history_from_environment()

    assert isinstance(storage, SupabaseHistory)
    assert storage.storage_name == "Supabase PostgreSQL"


def test_process_environment_takes_precedence_over_project_dotenv(tmp_path, monkeypatch) -> None:
    dotenv_file = tmp_path / ".env"
    dotenv_file.write_text("SUPABASE_URL=https://dotenv.example.co\n", encoding="utf-8")
    monkeypatch.setenv("SUPABASE_URL", "https://process.example.co")
    monkeypatch.setattr(config, "ENV_FILE", dotenv_file)

    config.load_project_environment()

    assert __import__("os").environ["SUPABASE_URL"] == "https://process.example.co"


@pytest.mark.parametrize(
    ("url", "secret_key", "legacy_key"),
    [
        ("https://example.supabase.co", "", ""),
        ("", "sb_secret_test_placeholder", ""),
        ("", "", "legacy-test-key"),
    ],
)
def test_missing_supabase_credentials_fail_clearly(monkeypatch, url: str, secret_key: str, legacy_key: str) -> None:
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", secret_key)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", legacy_key)
    with pytest.raises(StorageError, match="partially configured"):
        create_history_from_environment()


def test_both_supabase_key_types_fail_clearly(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_test_placeholder")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "legacy-test-key")
    with pytest.raises(StorageError, match="Both SUPABASE_SECRET_KEY"):
        create_history_from_environment()


def test_secret_key_requires_current_supabase_format(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "not-a-secret-key")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with pytest.raises(StorageError, match="sb_secret_"):
        create_history_from_environment()


def test_database_connection_errors_become_safe_storage_errors() -> None:
    storage = SupabaseHistory("https://example.supabase.co", "sb_secret_test_placeholder", client=FailingClient(), use_legacy_bearer_auth=False)
    with pytest.raises(StorageError, match="Supabase storage request failed"):
        storage.add(sample_record())


def test_dashboard_contains_no_supabase_credentials_or_client_setup() -> None:
    from pathlib import Path

    dashboard = Path(__file__).resolve().parents[1] / "dashboard"
    source = "\n".join(path.read_text(encoding="utf-8") for path in dashboard.glob("*.*"))
    assert "SUPABASE_SECRET_KEY" not in source
    assert "SUPABASE_SERVICE_ROLE_KEY" not in source
    assert "supabase.co" not in source
