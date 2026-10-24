/**
 * AI Energy Guardian - Authoritative Hardware Telemetry & Status Verification Tests
 *
 * Verifies:
 * 1. Fresh authenticated physical telemetry marks the device CONNECTED.
 * 2. No telemetry marks it DISCONNECTED.
 * 3. Simulator data never marks physical sensors CONNECTED.
 * 4. Historical Supabase readings do not mark the device CONNECTED after restart.
 * 5. Stale telemetry changes the status to STALE or DISCONNECTED.
 * 6. Invalid or unauthenticated telemetry cannot establish a connection.
 * 7. Missing temperature/humidity/occupancy readings appear as unavailable, not fabricated zeros.
 * 8. Backend online status does not imply sensor connectivity.
 * 9. Simulation recommendations remain clearly identified as simulated.
 * 10. Existing three-report energy calculations and Supabase persistence continue to work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { history, sensorDataStatus } from "../src/history.js";
import {
  calculateClassroomConnectedLoad,
  calculateClassroomSimulationReport,
  calculatePrototypeEnergyReport,
  getPhysicalEnergyReport,
} from "../src/power.js";
import {
  setSupabaseClientForTesting,
  isSupabaseConfigured,
} from "../src/supabase.js";

const API_BASE = "http://localhost:3000";

async function postJson(url: string, data: any, headers: Record<string, string> = {}) {
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${API_BASE}${url}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteJson(url: string) {
  const res = await fetch(`${API_BASE}${url}`, { method: "DELETE" });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// 1. Initial / No Telemetry State: DISCONNECTED
test("1. No telemetry marks hardware status as DISCONNECTED with explicit guidance", async () => {
  await deleteJson("/history");

  const health = await getJson("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.backend_status, "online");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "disconnected");
  assert.match(health.body.sensor_health.statusText, /^Physical sensors are not connected/i);
  assert.equal(health.body.sensor_health.latestPhysicalReading, null);
  assert.equal(health.body.sensor_health.lastPhysicalReadingTime, null);

  // Dedicated physical endpoint returns 404 with clear message
  const physicalRes = await getJson("/readings/latest/physical");
  assert.equal(physicalRes.status, 404);
  assert.equal(physicalRes.body.physical_sensor_connected, false);
  assert.match(physicalRes.body.detail, /Physical sensors are not connected/i);
});

// 2. Fresh Authenticated Physical Telemetry: CONNECTED
test("2. Fresh authenticated physical telemetry transitions status to CONNECTED", async () => {
  await deleteJson("/history");

  const freshTimestamp = new Date().toISOString();
  const ingestRes = await postJson(
    "/readings",
    {
      occupancy: 28,
      temperature_c: 26.5,
      humidity_pct: 58.0,
      smart_board_on: true,
      timestamp: freshTimestamp,
      data_source: "esp32",
    },
    {
      "x-device-id": "ESP32_LAB_CLASSROOM_01",
      "x-sensor-source": "esp32",
    }
  );

  assert.equal(ingestRes.status, 201);
  assert.equal(ingestRes.body.is_physical, true);
  assert.equal(ingestRes.body.telemetry_source, "PHYSICAL_ESP32");

  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, true);
  assert.equal(health.body.sensor_health.status, "live");
  assert.match(health.body.sensor_health.statusText, /Physical ESP32 Sensor Connected/i);
  assert.ok(health.body.sensor_health.lastPhysicalReadingTime);
  assert.ok(health.body.sensor_health.latestPhysicalReading);
  assert.equal(health.body.sensor_health.latestPhysicalReading.reading.occupancy, 28);

  const physicalRes = await getJson("/readings/latest/physical");
  assert.equal(physicalRes.status, 200);
  assert.equal(physicalRes.body.is_physical, true);
  assert.equal(physicalRes.body.is_live, true);
  assert.equal(physicalRes.body.telemetry_source, "PHYSICAL_ESP32");
  assert.equal(physicalRes.body.occupancy, 28);
});

// 3. Simulator Data Never Marks Hardware CONNECTED
test("3. Simulator execution never marks physical hardware as CONNECTED", async () => {
  await deleteJson("/history");

  const opLogin = await postJson("/api/auth/login", {
    email: "operator@energyguardian.ai",
    password: "OperatorGuardian2026!",
  });
  const opToken = opLogin.body.token;

  // Run simulator steps
  const simRun = await postJson("/simulator/run", { count: 2 }, { Authorization: `Bearer ${opToken}` });
  assert.equal(simRun.status, 200);
  assert.equal(simRun.body.label, "SIMULATED DATA");

  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "simulated_only");
  assert.match(health.body.sensor_health.statusText, /^Physical sensors are not connected/i);
  assert.equal(health.body.sensor_health.latestPhysicalReading, null);
  assert.ok(health.body.sensor_health.totalSimulatedReadings >= 2);

  const physicalRes = await getJson("/readings/latest/physical");
  assert.equal(physicalRes.status, 404);
  assert.equal(physicalRes.body.physical_sensor_connected, false);
});

// 4. Historical Supabase Readings Do Not Mark Hardware CONNECTED
test("4. Historical Supabase database records do not mark hardware CONNECTED after reboot", async () => {
  await deleteJson("/history");

  // Create mock DB containing a row from Supabase
  const pastTimestamp = new Date(Date.now() - 10 * 1000).toISOString();
  const mockDb = {
    _tables: {
      sensor_readings: [
        {
          id: "hist_db_reading_999",
          room_id: "room_101",
          device_id: "ESP32_LAB_CLASSROOM_01",
          data_source: "esp32",
          is_physical: true,
          timestamp: pastTimestamp,
          temperature_c: 27.0,
          humidity_pct: 60.0,
          occupancy: 25,
          raw_reading: {
            occupancy: 25,
            temperature_c: 27.0,
            humidity_pct: 60.0,
            data_source: "esp32",
          },
        },
      ],
      ai_predictions: [],
      sensor_events: [],
    },
    from: (table: string) => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: (mockDb._tables as any)[table] || [], error: null }),
        }),
      }),
      insert: (rows: any[]) => {
        ((mockDb._tables as any)[table] = (mockDb._tables as any)[table] || []).push(...rows);
        return Promise.resolve({ data: rows, error: null });
      },
    }),
  };

  setSupabaseClientForTesting(mockDb as any);

  // Hydrate memory from database (simulating restart)
  await history.syncWithDatabase();

  // Historical reading exists in store for history view
  const recent = history.recent(5);
  const found = recent.find((r) => r.id === "hist_db_reading_999");
  assert.ok(found, "Historical row should be hydrated for history display");
  assert.equal(found?.sensor_data_status.isHistorical, true);

  // CRITICAL: Hardware health must NOT be marked CONNECTED from DB hydration
  const health = history.getSensorHealth();
  assert.equal(health.physicalSensorConnected, false);
  assert.equal(health.status, "disconnected");
  assert.equal(health.latestPhysicalReading, null);

  setSupabaseClientForTesting(null);
});

// 5. Stale Telemetry Changes Status to STALE
test("5. Stale telemetry exceeding configured timeout marks status as STALE", async () => {
  await deleteJson("/history");

  // Telemetry from 45 seconds ago (exceeding default 30s timeout)
  const staleTimestamp = new Date(Date.now() - 45 * 1000).toISOString();
  const res = await postJson(
    "/readings",
    {
      occupancy: 22,
      temperature_c: 25.0,
      humidity_pct: 50.0,
      smart_board_on: false,
      timestamp: staleTimestamp,
      data_source: "esp32",
    },
    {
      "x-device-id": "ESP32_LAB_CLASSROOM_01",
      "x-sensor-source": "esp32",
    }
  );
  assert.equal(res.status, 201);

  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "stale");
  assert.ok(health.body.sensor_health.physicalAgeSeconds >= 30);
  assert.match(health.body.sensor_health.statusText, /Physical ESP32 Sensor Stale/i);

  const physicalRes = await getJson("/readings/latest/physical");
  assert.equal(physicalRes.status, 200);
  assert.equal(physicalRes.body.is_live, false);
});

// 6. Invalid / Unauthenticated Telemetry Rejected
test("6. Unauthenticated or invalid telemetry cannot establish a physical connection", async () => {
  await deleteJson("/history");

  // Attempt to claim physical ESP32 without device headers
  const unauthRes = await postJson("/readings", {
    occupancy: 30,
    temperature_c: 27.0,
    humidity_pct: 55.0,
    data_source: "esp32",
  });
  assert.equal(unauthRes.status, 401);
  assert.match(unauthRes.body.detail, /Unauthenticated device/i);

  // Attempt with invalid device ID
  const invalidDevRes = await postJson(
    "/readings",
    {
      occupancy: 30,
      temperature_c: 27.0,
      humidity_pct: 55.0,
      data_source: "esp32",
    },
    { "x-device-id": "UNAUTHORIZED_HACKER_DEVICE" }
  );
  assert.equal(invalidDevRes.status, 401);

  // Attempt with invalid payload (e.g. occupancy < 0)
  const invalidDataRes = await postJson(
    "/readings",
    {
      occupancy: -50,
      temperature_c: 27.0,
      humidity_pct: 55.0,
      data_source: "esp32",
    },
    { "x-device-id": "ESP32_LAB_CLASSROOM_01" }
  );
  assert.equal(invalidDataRes.status, 422);

  // System remains disconnected
  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
});

// 7. Missing Readings Appear as Unavailable (Not Fabricated Zeros)
test("7. Disconnected state does not fabricate zeros or false readings", async () => {
  await deleteJson("/history");

  const health = await getJson("/health");
  assert.equal(health.body.sensor_health.latestPhysicalReading, null);
  assert.equal(health.body.sensor_health.lastPhysicalReadingTime, null);

  const latest = await getJson("/readings/latest/physical");
  assert.equal(latest.status, 404);
  assert.equal(latest.body.physical_sensor_connected, false);
});

// 8. Backend Online Status Does Not Imply Sensor Connectivity
test("8. Backend online status is decoupled from sensor hardware connectivity", async () => {
  await deleteJson("/history");

  const health = await getJson("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.backend_status, "online");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "disconnected");
  assert.match(health.body.notes.physical_sensors, /Physical ESP32 disconnected/i);
});

// 9. Simulation Recommendations Identified as Simulated
test("9. Simulation recommendations are explicitly tagged and never claim physical actuation", async () => {
  const decRes = await postJson("/decision", {
    occupancy: 30,
    temperature_c: 29.0,
    humidity_pct: 65.0,
    smart_board_on: true,
  });

  assert.equal(decRes.status, 201);
  assert.equal(decRes.body.decision.hardware_control_enabled, false);
  assert.match(decRes.body.message, /no hardware control was issued/i);
});

// 10. Existing Three Reports and Power Calculations Continue to Pass
test("10. Existing three energy reports and power calculations function accurately", async () => {
  const crLoad = calculateClassroomConnectedLoad();
  assert.equal(crLoad, 749);

  const protoReport = calculatePrototypeEnergyReport({
    mini_fan_on: true,
    led_light_on: true,
    lcd_display_on: true,
  });
  assert.ok(protoReport.total_connected_load_w < 50);
  assert.equal(protoReport.label, "ESTIMATED (PROTOTYPE BENCH)");

  const crReport = calculateClassroomSimulationReport({
    occupancy: 25,
    temperature_c: 26.5,
    humidity_pct: 55,
    smart_board_on: true,
  });
  assert.equal(crReport.label, "SIMULATED / PROJECTED");
  assert.equal(crReport.baseline_power_w, 749);

  const physReport = getPhysicalEnergyReport(null);
  assert.equal(physReport.meter_connected, false);
  assert.equal(physReport.measured_power_w, null);
  assert.match(physReport.status_message, /Physical meter not connected/i);
});
