from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_reading_validation_rejects_invalid_humidity() -> None:
    response = client.post("/readings", json={"occupancy": 1, "temperature_c": 25, "humidity_pct": 120,
                                                "no_of_lights_on": 1, "no_of_fans_on": 1, "data_source": "simulated"})
    assert response.status_code == 422


def test_evaluate_validation_rejects_invalid_temperature() -> None:
    response = client.post("/evaluate", json={"occupancy": 1, "temperature_c": 99, "humidity_pct": 50})
    assert response.status_code == 422
    assert "temperature_c" in response.text


def test_prediction_endpoint_uses_final_count_models() -> None:
    response = client.post("/predict", json={"occupancy": 1, "temperature_c": 25, "humidity_pct": 50})
    assert response.status_code == 200
    body = response.json()
    assert {"occupancy_prediction", "predicted_fan_count", "predicted_light_count"} <= body.keys()


def test_prediction_endpoint_reports_clear_invalid_time() -> None:
    response = client.post("/predict", json={"occupancy": 1, "temperature_c": 25, "humidity_pct": 50, "time": "invalid"})
    assert response.status_code == 422
    assert "Could not parse classroom start time" in response.json()["detail"]


def test_evaluate_retains_simulated_reading_prediction_and_decision() -> None:
    response = client.post("/evaluate", json={
        "date": "2026-10-09", "time": "1:10 pm", "lecture": "EM",
        "occupancy": 24, "temperature_c": 31, "humidity_pct": 78,
        "cloud_cover_pct": 80, "smart_board_on": True, "data_source": "simulated",
    })
    assert response.status_code == 201
    body = response.json()
    assert body["reading"]["occupancy"] == 24
    assert body["prediction"]["predicted_fan_count"] >= 0
    assert body["decision"]["ai_mode"] == "AI_AUTO"
    assert body["sensor_data_status"]["kind"] == "simulated"
    assert "unavailable" in body["power_status"]


def test_decision_endpoint_returns_advisory_without_firebase() -> None:
    response = client.post("/decision", json={"occupancy": 1, "temperature_c": 25, "humidity_pct": 50})
    assert response.status_code == 201
    assert response.json()["decision"]["hardware_control_enabled"] is False


def test_history_and_dashboard_are_available() -> None:
    assert client.get("/history").status_code == 200
    dashboard = client.get("/dashboard/")
    assert dashboard.status_code == 200
    assert "AI Energy Guardian" in dashboard.text
