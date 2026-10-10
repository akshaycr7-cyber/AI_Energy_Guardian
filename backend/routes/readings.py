"""Reading ingestion and retrieval routes."""
from fastapi import APIRouter, HTTPException, status
from google.cloud.firestore_v1 import Query

from backend.firebase import get_firestore_client
from backend.schemas import ClassroomReadingCreate

router = APIRouter(prefix="/readings", tags=["readings"])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_reading(reading: ClassroomReadingCreate) -> dict:
    """Validate and persist one classroom observation in Firestore."""
    try:
        reference = get_firestore_client().collection("classroom_readings").document()
        reference.set(reading.firestore_document())
        return {"message": "Reading stored", "id": reference.id, "data_source": reading.data_source}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/latest")
def latest_reading() -> dict:
    try:
        rows = list(get_firestore_client().collection("classroom_readings").order_by("timestamp", direction=Query.DESCENDING).limit(1).stream())
        if not rows:
            raise HTTPException(status_code=404, detail="No readings found")
        return {"id": rows[0].id, **rows[0].to_dict()}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/recent")
def recent_readings(limit: int = 20) -> dict:
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    try:
        rows = get_firestore_client().collection("classroom_readings").order_by("timestamp", direction=Query.DESCENDING).limit(limit).stream()
        return {"items": [{"id": row.id, **row.to_dict()} for row in rows]}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
