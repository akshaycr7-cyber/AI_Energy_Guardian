"""Model registry and retraining-readiness routes."""
from fastapi import APIRouter, HTTPException
from google.cloud.firestore_v1 import Query

from backend.firebase import get_firestore_client
from ml.retraining import retraining_readiness

router = APIRouter(prefix="/model", tags=["models"])


@router.get("/status")
def model_status() -> dict:
    return {"models_directory": "ml/models", "power_regression_available": False,
            "note": "No genuine power model is trained until measured_power_w observations exist."}


@router.get("/versions")
def model_versions() -> dict:
    try:
        rows = get_firestore_client().collection("model_versions").order_by("trained_at", direction=Query.DESCENDING).stream()
        return {"items": [{"id": row.id, **row.to_dict()} for row in rows]}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/retrain/check")
def retrain_check() -> dict:
    """Assess eligibility only; it never trains or deploys a model."""
    return retraining_readiness()
