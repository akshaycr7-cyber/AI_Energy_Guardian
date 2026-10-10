"""Validated API contracts and Firestore serialization helpers."""
from __future__ import annotations

from datetime import date as DateType, datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClassroomReadingCreate(APIModel):
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    date: DateType | None = None
    # Classroom schedules use intervals such as "1:10 pm", not clock-only time.
    time: str | None = Field(default=None, max_length=40)
    lecture: str | None = Field(default=None, max_length=200)
    occupancy: int = Field(ge=0, le=500)
    temperature_c: float = Field(ge=-30, le=70)
    humidity_pct: float = Field(ge=0, le=100)
    cloud_cover_pct: float | None = Field(default=None, ge=0, le=100)
    precipitation_mm: float | None = Field(default=None, ge=0)
    weather_condition: str | None = Field(default=None, max_length=80)
    light_level: float | None = Field(default=None, ge=0)
    # These are observed appliance states when available, not model targets.
    no_of_lights_on: int | None = Field(default=None, ge=0, le=100)
    no_of_fans_on: int | None = Field(default=None, ge=0, le=100)
    smart_board_on: bool = False
    measured_power_w: float | None = Field(default=None, ge=0)
    data_source: Literal["simulated", "esp32", "manual", "imported"] = "manual"

    @field_validator("timestamp")
    @classmethod
    def timestamp_must_have_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value

    def firestore_document(self) -> dict[str, Any]:
        data = self.model_dump(mode="json")
        data["created_at"] = datetime.now(timezone.utc).isoformat()
        return data


class PredictionRequest(APIModel):
    date: DateType | None = None
    time: str | None = None
    lecture: str | None = Field(default=None, max_length=200)
    occupancy: int = Field(ge=0, le=500)
    temperature_c: float = Field(ge=-30, le=70)
    humidity_pct: float = Field(ge=0, le=100)
    light_level: float | None = Field(default=None, ge=0)
    weather_condition: str | None = None
    cloud_cover_pct: float | None = Field(default=None, ge=0, le=100)
    precipitation_mm: float | None = Field(default=None, ge=0)
    smart_board_on: bool | None = None


class DecisionRequest(PredictionRequest):
    decision_mode: Literal["recommendation", "automatic"] = "recommendation"


class ModelVersion(APIModel):
    model_version: str
    model_type: str
    trained_at: datetime | None = None
    training_rows: int | None = Field(default=None, ge=0)
    validation_metrics: dict[str, float] | None = None
    test_metrics: dict[str, float] | None = None
    status: str
    model_path: str | None = None
    notes: str | None = None


class SystemStatus(APIModel):
    """Singleton-status fields stored in the system_status collection."""
    last_sensor_update: datetime | None = None
    active_model_version: str | None = None
    last_retraining_time: datetime | None = None
    total_readings: int = Field(default=0, ge=0)
    new_readings_since_retraining: int = Field(default=0, ge=0)
    system_mode: Literal["development", "monitoring", "automatic"] = "development"


class EnergyStatistics(APIModel):
    """Energy fields remain nullable until real INA219 measurements are available."""
    date: DateType
    baseline_power_w: float | None = Field(default=None, ge=0)
    actual_power_w: float | None = Field(default=None, ge=0)
    energy_used_wh: float | None = Field(default=None, ge=0)
    energy_saved_wh: float | None = None
    energy_saved_kwh: float | None = None
    savings_percent: float | None = None
