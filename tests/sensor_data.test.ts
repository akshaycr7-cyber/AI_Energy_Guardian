import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startIsolatedTestServer,
  IsolatedTestServer,
  ESP32_AUTH_HEADERS,
} from "./test_helper.js";
import { history } from "../src/history.js";
import { predictAll, recommendStates } from "../src/ml.js";

let testServer: IsolatedTestServer;
let API_BASE = "";

before(async () => {
  testServer = await startIsolatedTestServer();
  API_BASE = testServer.baseUrl;
});

after(async () => {
  if (testServer) {
    await testServer.close();
  }
});

async function postJson(url: string, data: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteJson(url: string) {
  const res = await fetch(`${API_BASE}${url}`, { method: "DELETE" });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("Requirement 1 & 7: Disconnected Physical Sensor & Separate Statuses", async () => {
  // Clear server history for isolated test
  await deleteJson("/history");

  const health = await getJson("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.backend_status, "online");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "disconnected");
  assert.match(health.body.sensor_health.statusText, /Awaiting ESP32/i);

  // Dedicated physical endpoint returns 404 when hardware is offline
  const latestPhysical = await getJson("/readings/latest/physical");
  assert.equal(latestPhysical.status, 404);
  assert.match(latestPhysical.body.detail, /Awaiting sensor connection/i);
});

test("Requirement 3: Simulator Telemetry is Strictly Isolated and Labeled", async () => {
  await deleteJson("/history");

  // Get operator token to run simulator
  const opLogin = await postJson("/api/auth/login", {
    email: "operator@energyguardian.ai",
    password: "OperatorGuardian2026!",
  });
  const opToken = opLogin.body.token;

  const simRun = await postJson("/simulator/run", { count: 1 }, opToken);
  assert.equal(simRun.status, 200);
  assert.equal(simRun.body.label, "SIMULATED DATA");
  assert.ok(simRun.body.items[0].reading.data_source === "simulated");

  // Health check should report simulated_only, NOT physical live
  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "simulated_only");
  assert.match(health.body.sensor_health.statusText, /SIMULATED DATA only/i);

  // Dedicated physical endpoint must still return 404
  const latestPhysical = await getJson("/readings/latest/physical");
  assert.equal(latestPhysical.status, 404);
});

test("Requirement 2: Live Physical Sensor Telemetry Detection & Provenance", async () => {
  await deleteJson("/history");

  // Ingest reading with authenticated physical device header
  const postRes = await fetch(`${API_BASE}/readings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...ESP32_AUTH_HEADERS,
    },
    body: JSON.stringify({
      occupancy: 34,
      temperature_c: 28.5,
      humidity_pct: 68.0,
      smart_board_on: true,
      data_source: "esp32",
    }),
  });
  const body = await postRes.json();
  assert.equal(postRes.status, 201);
  assert.equal(body.is_physical, true);
  assert.equal(body.data_source, "esp32");

  // Health should now report physicalSensorConnected as true and status live
  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, true);
  assert.equal(health.body.sensor_health.status, "live");
  assert.match(health.body.sensor_health.statusText, /Live Data/i);
  assert.ok(health.body.sensor_health.lastPhysicalReadingTime);

  // Dedicated physical endpoint must now return 200 with live physical readings
  const latestPhysical = await getJson("/readings/latest/physical");
  assert.equal(latestPhysical.status, 200);
  assert.equal(latestPhysical.body.is_physical, true);
  assert.equal(latestPhysical.body.is_live, true);
  assert.equal(latestPhysical.body.occupancy, 34);
  assert.equal(latestPhysical.body.temperature_c, 28.5);
});

test("Requirement 4: Historical Training Dataset API Availability", async () => {
  const datasetRes = await getJson("/history/dataset");
  assert.equal(datasetRes.status, 200);
  assert.ok(datasetRes.body.total_records >= 100);
  assert.ok(datasetRes.body.date_range);
  assert.ok(Array.isArray(datasetRes.body.records));
  assert.ok(datasetRes.body.records[0].date);
});

test("Requirement 5: AI Model Forecasts & Insufficient Data Handling", () => {
  // Missing required feature occupancy produces status: "insufficient_data" per Requirement 5
  const incompletePred = predictAll({ temperature_c: 25.0 } as any);
  assert.equal(incompletePred.status, "insufficient_data");
  assert.equal(incompletePred.predicted_fan_count, null);
  assert.equal(incompletePred.predicted_light_count, null);
  assert.match(incompletePred.reason || "", /Insufficient data for prediction/i);

  // Valid features produce real model forecasts
  const validPred = predictAll({
    occupancy: 30,
    temperature_c: 29.0,
    humidity_pct: 70.0,
    smart_board_on: true,
  });
  assert.equal(validPred.status, "valid");
  assert.ok(typeof validPred.predicted_fan_count === "number");
  assert.ok(typeof validPred.predicted_light_count === "number");
});

test("Requirement 6: Power & Savings Transparency", async () => {
  // Model status makes electrical power transparency explicit
  const statusRes = await getJson("/model/status");
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.power_regression_available, false);
  assert.match(statusRes.body.note, /never fabricates unmeasured power/i);
});

test("Requirement B: Stale Status Enforcement after configured stale timeout threshold", async () => {
  await deleteJson("/history");

  const effectiveThreshold = history.staleThresholdSeconds;
  // Ingest reading timestamped beyond the configured stale timeout (default 30s)
  const staleTimestamp = new Date(Date.now() - (effectiveThreshold + 15) * 1000).toISOString();
  const res = await fetch(`${API_BASE}/readings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...ESP32_AUTH_HEADERS,
    },
    body: JSON.stringify({
      occupancy: 20,
      temperature_c: 26.0,
      humidity_pct: 55.0,
      smart_board_on: false,
      timestamp: staleTimestamp,
      data_source: "esp32",
    }),
  });
  assert.equal(res.status, 201);

  // Health check should report status as stale and physicalSensorConnected as false
  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "stale");
  assert.ok(health.body.sensor_health.physicalAgeSeconds > effectiveThreshold);

  // Reading endpoint returns is_live = false
  const latestPhysical = await getJson("/readings/latest/physical");
  assert.equal(latestPhysical.status, 200);
  assert.equal(latestPhysical.body.is_live, false);
});
