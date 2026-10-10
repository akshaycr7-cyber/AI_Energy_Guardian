import pytest

from ml.decision_engine import MAX_FAN_RECOMMENDATION, MAX_LIGHT_RECOMMENDATION, recommend_states
from ml.prediction import (
    predict_all,
    predict_fan_count,
    predict_light_count,
    predict_occupancy,
    prepare_prediction_features,
)
from ml.preprocessing import MODEL_FEATURES


SAMPLE = {
    "Date": "2026-10-09",
    "Time": "1.10-2.10 pm",
    "Lect": "EM",
    "Smart Board ON/OFF": "ON",
    "Weather Condition": "Cloudy",
    "Temperature (C)": 31.0,
    "Humidity (%)": 78.0,
    "Cloud Cover (%)": 80.0,
    "Precipitation (mm)": 0.0,
}


def test_final_prediction_schema_and_entry_points() -> None:
    frame = prepare_prediction_features(SAMPLE)
    assert list(frame.columns) == MODEL_FEATURES
    assert frame.loc[0, "Hour"] == 13
    assert frame.loc[0, "Minute"] == 10
    assert isinstance(predict_occupancy(SAMPLE), str)
    assert isinstance(predict_fan_count(SAMPLE), int)
    assert isinstance(predict_light_count(SAMPLE), int)
    assert {"occupancy_prediction", "predicted_fan_count", "predicted_light_count"} <= predict_all(SAMPLE).keys()


def test_invalid_prediction_time_has_clear_error() -> None:
    with pytest.raises(ValueError, match="Could not parse classroom start time"):
        prepare_prediction_features({"Time": "not a classroom interval"})


def test_decision_recommendations_are_bounded() -> None:
    prediction = {
        "occupancy_prediction": "Occupied",
        "predicted_fan_count": 5,
        "predicted_light_count": 6,
    }
    decision = recommend_states(SAMPLE, prediction)
    assert decision["mode"] == "AI_AUTO"
    assert 0 <= decision["fan_count"] <= MAX_FAN_RECOMMENDATION
    assert 0 <= decision["light_count"] <= MAX_LIGHT_RECOMMENDATION
    assert decision["reason"]
