"""Dashboard-oriented API contracts backed by the local demonstration store."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status

from backend.history import StorageError, history
from backend.schemas import ClassroomReadingCreate
from ml.decision_engine import recommend_states
from ml.prediction import predict_all

router = APIRouter(tags=["dashboard"])


def sensor_data_status(source: str) -> dict[str, str]:
    labels = {
        "simulated": ("simulated", "Simulated value - not a physical sensor measurement."),
        "esp32": ("measured", "Sensor reading reported by an ESP32 device."),
        "manual": ("manual", "Manually entered reading - not an automatic sensor measurement."),
        "imported": ("imported", "Imported reading; original measurement provenance should be checked."),
    }
    kind, message = labels[source]
    return {"kind": kind, "message": message}


@router.post("/evaluate", status_code=status.HTTP_201_CREATED)
def evaluate_reading(reading: ClassroomReadingCreate) -> dict:
    """Evaluate a validated observation and retain it for the local dashboard.

    The output separates the supplied observation from model output and the
    hardware-neutral recommendation.  It never sends a control command.
    """
    try:
        model_input = reading.model_dump(exclude={"timestamp", "data_source", "measured_power_w", "no_of_lights_on", "no_of_fans_on"})
        prediction = predict_all(model_input)
        decision = recommend_states(model_input, prediction)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Prediction input is invalid: {exc}") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    observed = reading.model_dump(mode="json")
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "reading": observed,
        "prediction": prediction,
        "decision": {
            "recommended_fan_count": decision["fan_count"],
            "recommended_light_count": decision["light_count"],
            "reason": decision["reason"],
            "ai_mode": decision["mode"],
            "hardware_control_enabled": False,
        },
        "sensor_data_status": sensor_data_status(reading.data_source),
        "power_status": "unavailable: no real power measurement has been supplied",
    }
    try:
        identifier = history.add(record)
    except StorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"id": identifier, **record}


@router.get("/history")
def get_history(limit: int = 30) -> dict:
    if not 1 <= limit <= 200:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 200")
    try:
        items = history.recent(limit)
    except StorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"items": items, "storage": history.storage_name}
