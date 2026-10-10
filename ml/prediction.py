"""Inference API for the final AI Energy Guardian count models.

This module returns recommendations only; it does not control hardware or
estimate power because the dataset has no measured power target.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

try:  # Supports both ``import ml.prediction`` and direct local execution.
    from .preprocessing import MODEL_FEATURES, prepare_model_features
except ImportError:  # pragma: no cover - direct-script compatibility
    from preprocessing import MODEL_FEATURES, prepare_model_features


MODEL_PATH = Path(__file__).resolve().parent / "models" / "energy_guardian_models_final.joblib"

def load_final_models() -> dict[str, Any]:
    """Load the fresh final package, failing clearly if training has not run."""
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Final model package is missing: {MODEL_PATH}. Run `python ml/train_final.py` first."
        )
    package = joblib.load(MODEL_PATH)
    required = {"occupancy_model", "fan_count_model", "light_count_model", "features"}
    missing = required - package.keys()
    if missing:
        raise ValueError(f"Final model package is invalid; missing keys: {sorted(missing)}")
    if list(package["features"]) != MODEL_FEATURES:
        raise ValueError(
            "Final model package uses a different feature schema. "
            "Run `python ml/train_final.py` to regenerate it."
        )
    return package


def prepare_prediction_features(input_data: dict[str, Any], package: dict[str, Any] | None = None) -> pd.DataFrame:
    """Prepare one row; fitted transformations stay inside the saved pipelines."""
    package = package or load_final_models()
    return prepare_model_features(input_data, package["features"])


def _non_negative_count(value: Any) -> int:
    return max(0, int(np.rint(float(value))))


def predict_occupancy(input_data: dict[str, Any]) -> str:
    package = load_final_models()
    return str(package["occupancy_model"].predict(prepare_prediction_features(input_data, package))[0])


def predict_fan_count(input_data: dict[str, Any]) -> int:
    package = load_final_models()
    return _non_negative_count(package["fan_count_model"].predict(prepare_prediction_features(input_data, package))[0])


def predict_light_count(input_data: dict[str, Any]) -> int:
    package = load_final_models()
    return _non_negative_count(package["light_count_model"].predict(prepare_prediction_features(input_data, package))[0])


def predict_all(input_data: dict[str, Any]) -> dict[str, Any]:
    """Return JSON-friendly occupancy and appliance-count predictions."""
    package = load_final_models()
    frame = prepare_prediction_features(input_data, package)
    return {
        "occupancy_prediction": str(package["occupancy_model"].predict(frame)[0]),
        "predicted_fan_count": _non_negative_count(package["fan_count_model"].predict(frame)[0]),
        "predicted_light_count": _non_negative_count(package["light_count_model"].predict(frame)[0]),
        "model_version": package.get("model_version"),
    }
