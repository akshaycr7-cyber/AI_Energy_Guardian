"""Prediction API route."""
from fastapi import APIRouter, HTTPException

from backend.schemas import PredictionRequest
from ml.prediction import predict_all

router = APIRouter(tags=["predictions"])


@router.post("/predict")
def predict(payload: PredictionRequest) -> dict:
    """Produce occupancy and appliance-count predictions from the final model."""
    try:
        return predict_all(payload.model_dump())
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Prediction input is invalid: {exc}") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
