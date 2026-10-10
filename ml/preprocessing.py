"""Shared feature schema and inference-row preparation for final models.

The fitted ``ColumnTransformer`` lives inside each saved model pipeline. This
module only builds the raw one-row frame passed to that fitted preprocessor;
it deliberately does not fit or duplicate an encoder/imputer.
"""
from __future__ import annotations

import re
from typing import Any, Sequence

import numpy as np
import pandas as pd


CATEGORICAL_FEATURES = [
    "Lect",
    "Smart Board ON/OFF",
    "Weather Condition",
]

NUMERICAL_FEATURES = [
    "Hour",
    "Minute",
    "Weekday",
    "Month",
    "Temperature (C)",
    "Humidity (%)",
    "Cloud Cover (%)",
    "Precipitation (mm)",
]

MODEL_FEATURES = CATEGORICAL_FEATURES + NUMERICAL_FEATURES

INPUT_ALIASES = {
    "date": "Date", "time": "Time", "lecture": "Lect", "lect": "Lect",
    "smart_board_on": "Smart Board ON/OFF", "smart_board": "Smart Board ON/OFF",
    "weather_condition": "Weather Condition", "temperature_c": "Temperature (C)",
    "humidity_pct": "Humidity (%)", "cloud_cover_pct": "Cloud Cover (%)",
    "precipitation_mm": "Precipitation (mm)", "hour": "Hour", "minute": "Minute",
    "weekday": "Weekday", "month": "Month",
}

# Accepted API/simulator inputs that are not final-model features.
_NON_MODEL_INPUTS = {
    "Date", "Time", "occupancy", "light_level", "data_source", "decision_mode",
}
_NUMERIC_BOUNDS = {
    "Hour": (0, 23), "Minute": (0, 59), "Weekday": (0, 6), "Month": (1, 12),
    "Humidity (%)": (0, 100), "Cloud Cover (%)": (0, 100),
    "Precipitation (mm)": (0, None),
}


def extract_start_hour_minute(value: Any) -> tuple[float, float]:
    """Parse an interval's start using the classroom schedule context.

    A suffix often describes the interval end. Starts in periods 1--4 are
    afternoon (13--16) unless explicitly marked AM; starts 9--12 stay literal.
    Whole intervals are never passed to ``pd.to_datetime``.
    """
    if pd.isna(value):
        return np.nan, np.nan
    if hasattr(value, "hour") and hasattr(value, "minute"):
        try:
            return int(value.hour), int(value.minute)
        except (TypeError, ValueError):
            return np.nan, np.nan
    if isinstance(value, pd.Timedelta):
        seconds = value.total_seconds()
        if seconds < 0:
            return np.nan, np.nan
        seconds %= 24 * 60 * 60
        return int(seconds // 3600), int((seconds % 3600) // 60)

    text = str(value).strip().lower()
    match = re.match(r"^(\d{1,2})(?:[\.:](\d{1,2}))?\s*(?:-|\u2013|\u2014)", text)
    if not match:
        match = re.match(r"^(\d{1,2})(?:[\.:](\d{1,2}))?\s*(?:a\.?m\.?|p\.?m\.?)?$", text)
    if not match:
        return np.nan, np.nan

    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    if not 1 <= hour <= 12 or not 0 <= minute <= 59:
        return np.nan, np.nan
    has_am = bool(re.search(r"\ba\.?m\.?\b", text))
    has_pm = bool(re.search(r"\bp\.?m\.?\b", text))
    if has_am and has_pm:
        return np.nan, np.nan
    if hour in {1, 2, 3, 4} and (has_pm or not has_am):
        hour += 12
    elif hour == 12 and has_am:
        hour = 0
    return hour, minute


def _normalise_smart_board(value: Any) -> Any:
    return "ON" if value is True else "OFF" if value is False else value


def _missing(value: Any) -> bool:
    return value is None or (isinstance(value, float) and np.isnan(value))


def _validated_number(feature: str, value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{feature!r} must be numeric or omitted.") from exc
    if not np.isfinite(number):
        raise ValueError(f"{feature!r} must be finite or omitted.")
    minimum, maximum = _NUMERIC_BOUNDS.get(feature, (None, None))
    if (minimum is not None and number < minimum) or (maximum is not None and number > maximum):
        raise ValueError(f"{feature!r} must be between {minimum} and {maximum}.")
    return number


def prepare_model_features(
    input_data: dict[str, Any],
    features: Sequence[str] = MODEL_FEATURES,
) -> pd.DataFrame:
    """Return one raw row in saved feature order.

    Invalid supplied dates/times/numerics raise ``ValueError``. Omitted model
    features become ``np.nan`` and are handled by the saved fitted imputers.
    """
    if not isinstance(input_data, dict):
        raise TypeError("input_data must be a dictionary.")
    feature_names = list(features)
    if feature_names != MODEL_FEATURES:
        raise ValueError(
            "Saved model feature schema does not match the final schema. "
            "Retrain with `python ml/train_final.py`."
        )

    values: dict[str, Any] = {feature: np.nan for feature in feature_names}
    for key, value in input_data.items():
        canonical = INPUT_ALIASES.get(key, key)
        if canonical in values:
            values[canonical] = _normalise_smart_board(value) if canonical == "Smart Board ON/OFF" else value
        elif canonical not in _NON_MODEL_INPUTS:
            raise ValueError(f"Unsupported prediction input field: {key!r}.")

    raw_time = input_data.get("Time", input_data.get("time"))
    if raw_time is not None and (_missing(values["Hour"]) or _missing(values["Minute"])):
        hour, minute = extract_start_hour_minute(raw_time)
        if pd.isna(hour) or pd.isna(minute):
            raise ValueError(f"Could not parse classroom start time from {raw_time!r}.")
        if _missing(values["Hour"]):
            values["Hour"] = hour
        if _missing(values["Minute"]):
            values["Minute"] = minute

    raw_date = input_data.get("Date", input_data.get("date"))
    if raw_date is not None and (_missing(values["Weekday"]) or _missing(values["Month"])):
        date = pd.to_datetime(raw_date, errors="coerce")
        if pd.isna(date):
            raise ValueError(f"Could not parse Date from {raw_date!r}.")
        if _missing(values["Weekday"]):
            values["Weekday"] = date.weekday()
        if _missing(values["Month"]):
            values["Month"] = date.month

    for feature in NUMERICAL_FEATURES:
        if not _missing(values[feature]):
            values[feature] = _validated_number(feature, values[feature])
    for feature in CATEGORICAL_FEATURES:
        if _missing(values[feature]) or not str(values[feature]).strip():
            values[feature] = np.nan
    return pd.DataFrame([values], columns=feature_names)


def prepare_features(values: dict[str, Any]) -> pd.DataFrame:
    """Backward-compatible alias for final-model feature preparation."""
    return prepare_model_features(values)
