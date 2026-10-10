"""Rule-governed, hardware-neutral classroom comfort recommendations."""
from __future__ import annotations

from typing import Any

from .prediction import predict_all


# Bounds currently supported by the observed appliance-count targets. They are
# recommendation safeguards, not measurements or claims of optimal control.
MAX_FAN_RECOMMENDATION = 5
MAX_LIGHT_RECOMMENDATION = 6


def _number(values: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = values.get(key)
        try:
            return None if value is None else float(value)
        except (TypeError, ValueError):
            continue
    return None


def recommend_states(input_data: dict[str, Any], prediction: dict[str, Any] | None = None) -> dict[str, Any]:
    """Combine model estimates with explicit occupancy, comfort, and context rules.

    The result is an AI_AUTO recommendation, never a mains-voltage control
    command.  An ESP32/low-voltage integration can consume it later.
    """
    prediction = prediction or predict_all(input_data)
    occupancy = prediction["occupancy_prediction"]
    lecture = str(input_data.get("Lect", input_data.get("lecture", ""))).lower()
    board = input_data.get("Smart Board ON/OFF", input_data.get("smart_board_on"))
    temp = _number(input_data, "Temperature (C)", "temperature_c")
    humidity = _number(input_data, "Humidity (%)", "humidity_pct")
    cloud = _number(input_data, "Cloud Cover (%)", "cloud_cover_pct")

    if occupancy == "Empty" or "cancel" in lecture or "break" in lecture:
        reason = "Empty or inactive classroom context; conserve appliances."
        return {"fan_count": 0, "light_count": 0, "reason": reason, "mode": "AI_AUTO", "prediction": prediction}

    fans = prediction["predicted_fan_count"]
    lights = prediction["predicted_light_count"]
    reasons = [f"{occupancy} classroom"]
    if temp is not None and temp >= 30:
        fans += 1
        reasons.append("elevated temperature")
    if humidity is not None and humidity >= 75:
        fans += 1
        reasons.append("high humidity")
    if cloud is not None and cloud >= 75:
        lights += 1
        reasons.append("low natural light")
    if board is True or str(board).strip().upper() == "ON":
        lights = max(lights, 2)
        reasons.append("smart board in use")

    return {
        "fan_count": min(MAX_FAN_RECOMMENDATION, max(0, int(fans))),
        "light_count": min(MAX_LIGHT_RECOMMENDATION, max(0, int(lights))),
        "reason": "; ".join(reasons) + ".",
        "mode": "AI_AUTO",
        "prediction": prediction,
    }
