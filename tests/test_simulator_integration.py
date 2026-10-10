from fastapi.testclient import TestClient

from backend.main import app
from simulator.sensor_simulator import generate_reading


def test_simulator_generated_payload_passes_the_evaluation_contract() -> None:
    response = TestClient(app).post("/evaluate", json=generate_reading())
    assert response.status_code == 201
    body = response.json()
    assert body["reading"]["data_source"] == "simulated"
    assert body["sensor_data_status"]["kind"] == "simulated"
