"""Transparent, hardware-neutral AI recommendation endpoint."""
from fastapi import APIRouter, HTTPException, status

from backend.schemas import DecisionRequest
from ml.decision_engine import recommend_states

router = APIRouter(tags=["decisions"])


@router.post("/decision", status_code=status.HTTP_201_CREATED)
def decision_only(payload: DecisionRequest) -> dict:
    """Generate an advisory decision without Firebase or appliance actuation."""
    try:
        recommendation = recommend_states(payload.model_dump())
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Prediction input is invalid: {exc}") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    decision = {
        "recommended_fan_count": recommendation["fan_count"],
        "recommended_light_count": recommendation["light_count"],
        "reason": recommendation["reason"],
        "ai_mode": recommendation["mode"],
        "decision_mode": payload.decision_mode,
        "hardware_control_enabled": False,
    }
    return {"message": "Recommendation generated; no hardware control was issued.", "decision": decision}
