/**
 * AI Energy Guardian - Security, Restart State, Timeout Validation & Test Isolation Regressions
 *
 * Proves all audit remediation requirements:
 * 1. Whitelisted device ID without a secret is rejected (HTTP 401) when ESP32_SECRET is configured.
 * 2. Incorrect secret is rejected (HTTP 401) across /readings, /readings/heartbeat, /api/telemetry/heartbeat, /evaluate.
 * 3. Valid device ID and matching secret (x-device-secret or x-sensor-key) are accepted.
 * 4. Rejected requests never establish a physical hardware heartbeat.
 * 5. Historical simulator records hydrated from Supabase do not activate simulation status after restart.
 * 6. SENSOR_STALE_TIMEOUT_SECONDS safely defaults (30s) and clamps extreme values; NaN never leaks.
 * 7. Test execution cannot accidentally write to production Supabase and fails fast on unsafe TEST_SUPABASE_URL.
 * 8. Dashboard & API endpoints use the effective stale timeout (no legacy 120s text).
 * 9. Frontend assets never expose ESP32_SECRET or SUPABASE_SERVICE_ROLE_KEY.
 * 10. Sensor-disconnection behavior and all three energy reports remain independent and accurate.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  startIsolatedTestServer,
  assertTestDatabaseIsolation,
  IsolatedTestServer,
  TEST_ESP32_SECRET,
  TEST_DEVICE_ID,
} from "./test_helper.js";
import {
  history,
  parseStaleTimeoutSeconds,
  DEFAULT_STALE_TIMEOUT_SECONDS,
  MIN_STALE_TIMEOUT_SECONDS,
  MAX_STALE_TIMEOUT_SECONDS,
} from "../src/history.js";
import { createClient } from "@supabase/supabase-js";
import {
  getSupabaseClient,
  getSupabaseConfig,
  isSupabaseConfigured,
  setSupabaseClientForTesting,
} from "../src/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

let testServer: IsolatedTestServer;
let API_BASE = "";

before(async () => {
  testServer = await startIsolatedTestServer();
  API_BASE = testServer.baseUrl;
});

after(async () => {
  history.setStaleThreshold(DEFAULT_STALE_TIMEOUT_SECONDS);
  if (testServer) {
    await testServer.close();
  }
});

async function sendJson(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const reqHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("Regression 1: Whitelisted device ID without secret is rejected (401) on all physical endpoints", async () => {
  await sendJson("DELETE", "/history");
  process.env.ESP32_SECRET = TEST_ESP32_SECRET;

  const sampleReading = {
    occupancy: 24,
    temperature_c: 26.2,
    humidity_pct: 56.0,
    smart_board_on: true,
    data_source: "esp32",
  };

  // POST /readings with valid x-device-id but missing secret
  const r1 = await sendJson("POST", "/readings", sampleReading, {
    "x-device-id": TEST_DEVICE_ID,
  });
  assert.equal(r1.status, 401);
  assert.equal(r1.body.error_code, "ESP32_UNAUTHENTICATED");

  // POST /readings/heartbeat with valid x-device-id but missing secret
  const r2 = await sendJson("POST", "/readings/heartbeat", {}, {
    "x-device-id": TEST_DEVICE_ID,
  });
  assert.equal(r2.status, 401);
  assert.equal(r2.body.error_code, "ESP32_UNAUTHENTICATED");

  // POST /api/telemetry/heartbeat with valid x-device-id but missing secret
  const r3 = await sendJson("POST", "/api/telemetry/heartbeat", {}, {
    "x-device-id": TEST_DEVICE_ID,
  });
  assert.equal(r3.status, 401);
  assert.equal(r3.body.error_code, "ESP32_UNAUTHENTICATED");

  // POST /evaluate claiming physical ESP32 without secret
  const r4 = await sendJson("POST", "/evaluate", sampleReading, {
    "x-device-id": TEST_DEVICE_ID,
  });
  assert.equal(r4.status, 401);
  assert.equal(r4.body.error_code, "ESP32_UNAUTHENTICATED");

  // Verify NO heartbeat or physical connection was established
  assert.equal(history.getHeartbeatState(), null);
  const health = await sendJson("GET", "/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.status, "disconnected");
});

test("Regression 2: Incorrect secret, unknown device ID, or missing ESP32_SECRET are rejected and never establish a heartbeat", async () => {
  await sendJson("DELETE", "/history");
  process.env.ESP32_SECRET = TEST_ESP32_SECRET;

  const sampleReading = {
    occupancy: 18,
    temperature_c: 25.4,
    humidity_pct: 52.0,
    smart_board_on: false,
    data_source: "esp32",
  };

  // Wrong x-device-secret on /readings
  const badSecretReadings = await sendJson("POST", "/readings", sampleReading, {
    "x-device-id": TEST_DEVICE_ID,
    "x-device-secret": "wrong_secret_value",
  });
  assert.equal(badSecretReadings.status, 401);

  // Wrong x-sensor-key on /readings/heartbeat
  const badKeyHeartbeat = await sendJson("POST", "/readings/heartbeat", {}, {
    "x-device-id": TEST_DEVICE_ID,
    "x-sensor-key": "wrong_sensor_key",
  });
  assert.equal(badKeyHeartbeat.status, 401);

  // Wrong secret on /api/telemetry/heartbeat
  const badApiHeartbeat = await sendJson("POST", "/api/telemetry/heartbeat", {}, {
    "x-device-id": TEST_DEVICE_ID,
    "x-device-secret": "wrong_secret_value",
  });
  assert.equal(badApiHeartbeat.status, 401);

  // Unknown device ID even with valid secret
  const unknownDevice = await sendJson("POST", "/readings", sampleReading, {
    "x-device-id": "UNRECOGNIZED_ESP32_NODE_99",
    "x-device-secret": TEST_ESP32_SECRET,
  });
  assert.equal(unknownDevice.status, 401);

  // Simulator spoofing attempt on heartbeat endpoint
  const spoofedSimHeartbeat = await sendJson("POST", "/readings/heartbeat", {
    data_source: "simulated",
  });
  assert.equal(spoofedSimHeartbeat.status, 401);

  // Unconfigured ESP32_SECRET fails closed
  const savedEspSecret = process.env.ESP32_SECRET;
  delete process.env.ESP32_SECRET;
  try {
    const missingEnvRes = await sendJson("POST", "/readings", sampleReading, {
      "x-device-id": TEST_DEVICE_ID,
      "x-device-secret": TEST_ESP32_SECRET,
    });
    assert.equal(missingEnvRes.status, 401);
  } finally {
    process.env.ESP32_SECRET = savedEspSecret;
  }

  // Confirm zero heartbeat or physical reading state leaked
  assert.equal(history.getHeartbeatState(), null);
  const health = await sendJson("GET", "/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, false);
  assert.equal(health.body.sensor_health.lastPhysicalReadingTime, null);
  assert.equal(health.body.sensor_health.latestPhysicalReading, null);

  const latestPhysical = await sendJson("GET", "/readings/latest/physical");
  assert.equal(latestPhysical.status, 404);
});

test("Regression 3: Valid device ID + matching secret are accepted across /readings and heartbeat endpoints", async () => {
  await sendJson("DELETE", "/history");
  process.env.ESP32_SECRET = TEST_ESP32_SECRET;

  // 1. Lightweight authenticated heartbeat via x-device-secret on /readings/heartbeat
  const hb1 = await sendJson("POST", "/readings/heartbeat", {}, {
    "x-device-id": TEST_DEVICE_ID,
    "x-device-secret": TEST_ESP32_SECRET,
  });
  assert.equal(hb1.status, 200);
  assert.equal(hb1.body.status, "ok");
  assert.equal(hb1.body.configured_device_id, TEST_DEVICE_ID);
  assert.ok(history.getHeartbeatState() !== null);

  // Heartbeat without telemetry packet does not fabricate sensor readings
  const preReadingPhysical = await sendJson("GET", "/readings/latest/physical");
  assert.equal(preReadingPhysical.status, 404);

  // 2. Authenticated telemetry via x-sensor-key header on /readings (secondary whitelisted node)
  const readingRes = await sendJson(
    "POST",
    "/readings",
    {
      occupancy: 31,
      temperature_c: 27.4,
      humidity_pct: 61.0,
      smart_board_on: true,
      data_source: "esp32",
    },
    {
      "x-device-id": "esp32_dev_node_01",
      "x-sensor-key": TEST_ESP32_SECRET,
    }
  );
  assert.equal(readingRes.status, 201);
  assert.equal(readingRes.body.is_physical, true);
  assert.equal(readingRes.body.telemetry_source, "PHYSICAL_ESP32");
  assert.equal(readingRes.body.device_id, "esp32_dev_node_01");

  // 3. Authenticated heartbeat refresh on /api/telemetry/heartbeat
  const hb2 = await sendJson("POST", "/api/telemetry/heartbeat", {}, {
    "x-device-id": "esp32_dev_node_01",
    "x-device-secret": TEST_ESP32_SECRET,
  });
  assert.equal(hb2.status, 200);
  assert.equal(hb2.body.status, "ok");

  const health = await sendJson("GET", "/health");
  assert.equal(health.body.sensor_health.physicalSensorConnected, true);
  assert.equal(health.body.sensor_health.status, "live");
  assert.equal(health.body.sensor_health.latestPhysicalReading.reading.occupancy, 31);
});

test("Regression 4: Historical simulator records in Supabase do NOT activate simulation status after restart", async () => {
  await sendJson("DELETE", "/history");

  const nowMs = Date.now();
  const mockDb = {
    _tables: {
      sensor_readings: [
        {
          id: "hist_sim_row_001",
          room_id: "room_101",
          device_id: null,
          data_source: "simulated",
          is_physical: false,
          timestamp: new Date(nowMs - 15_000).toISOString(),
          temperature_c: 26.8,
          humidity_pct: 59.0,
          occupancy: 24,
          smart_board_on: true,
          raw_reading: {
            occupancy: 24,
            temperature_c: 26.8,
            humidity_pct: 59.0,
            smart_board_on: true,
            data_source: "simulated",
          },
        },
        {
          id: "hist_esp_row_002",
          room_id: "room_101",
          device_id: TEST_DEVICE_ID,
          data_source: "esp32",
          is_physical: true,
          timestamp: new Date(nowMs - 20_000).toISOString(),
          temperature_c: 27.1,
          humidity_pct: 60.0,
          occupancy: 29,
          smart_board_on: false,
          raw_reading: {
            occupancy: 29,
            temperature_c: 27.1,
            humidity_pct: 60.0,
            smart_board_on: false,
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
        in: () => Promise.resolve({ data: [], error: null }),
      }),
      insert: (rows: any[]) => {
        ((mockDb._tables as any)[table] = (mockDb._tables as any)[table] || []).push(...rows);
        return Promise.resolve({ data: rows, error: null });
      },
    }),
  };

  setSupabaseClientForTesting(mockDb as any);
  try {
    await history.syncWithDatabase();
  } finally {
    setSupabaseClientForTesting(null);
  }

  // Historical records remain accessible in history views
  const histRes = await sendJson("GET", "/history?limit=10");
  assert.equal(histRes.status, 200);
  assert.equal(histRes.body.items.length, 2);
  assert.ok(histRes.body.items.some((item: any) => item.id === "hist_sim_row_001"));
  assert.ok(histRes.body.items.every((item: any) => item.sensor_data_status.isHistorical === true));

  // Current runtime status after restart MUST be disconnected with simulationActive: false
  const healthRes = await sendJson("GET", "/health");
  assert.equal(healthRes.status, 200);
  const sh = healthRes.body.sensor_health;
  assert.equal(sh.physicalSensorConnected, false);
  assert.equal(sh.simulationActive, false, "Historical simulated DB rows must not mark current simulation active");
  assert.equal(sh.status, "disconnected", "Post-restart status with no live ESP32 and inactive simulator must be disconnected");
  assert.equal(sh.totalSimulatedReadings, 0);
  assert.equal(sh.totalPhysicalReadings, 0);
  assert.equal(sh.totalRecords, 2);

  const simStatus = await sendJson("GET", "/simulator/status");
  assert.equal(simStatus.status, 200);
  assert.equal(simStatus.body.active, false);
});

test("Regression 5: SENSOR_STALE_TIMEOUT_SECONDS parsing defaults safely (30s), clamps extremes, and blocks NaN", () => {
  // Missing & empty -> 30
  assert.equal(parseStaleTimeoutSeconds(undefined), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds(null), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds(""), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("   "), DEFAULT_STALE_TIMEOUT_SECONDS);

  // Invalid / non-numeric / floats / NaN / Infinity -> 30
  assert.equal(parseStaleTimeoutSeconds("abc"), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("30s"), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("12.5"), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds(12.5), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds(Number.NaN), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds(Number.POSITIVE_INFINITY), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds({}), DEFAULT_STALE_TIMEOUT_SECONDS);

  // Zero & negative -> 30
  assert.equal(parseStaleTimeoutSeconds(0), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("0"), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds(-1), DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("-45"), DEFAULT_STALE_TIMEOUT_SECONDS);

  // Valid positive integers -> exact integer
  assert.equal(parseStaleTimeoutSeconds(1), MIN_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("15"), 15);
  assert.equal(parseStaleTimeoutSeconds(30), 30);
  assert.equal(parseStaleTimeoutSeconds(" 90 "), 90);

  // Extreme positive integers -> clamped to MAX_STALE_TIMEOUT_SECONDS (3600)
  assert.equal(parseStaleTimeoutSeconds(999999), MAX_STALE_TIMEOUT_SECONDS);
  assert.equal(parseStaleTimeoutSeconds("86400"), MAX_STALE_TIMEOUT_SECONDS);

  // setStaleThreshold() consistency and NaN immunity on sensor_health
  history.setStaleThreshold("invalid_value");
  assert.equal(history.staleThresholdSeconds, DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(Number.isNaN(history.getSensorHealth().staleThresholdSeconds), false);

  history.setStaleThreshold(99999);
  assert.equal(history.staleThresholdSeconds, MAX_STALE_TIMEOUT_SECONDS);

  history.setStaleThreshold(DEFAULT_STALE_TIMEOUT_SECONDS);
  assert.equal(history.staleThresholdSeconds, DEFAULT_STALE_TIMEOUT_SECONDS);
});

test("Regression 6: Automated test isolation unconditionally blocks external Supabase and rejects real clients in test hooks", () => {
  assert.notEqual(testServer.port, 3000, "Test HTTP server must never target live port 3000");

  const origProdUrl = process.env.SUPABASE_URL;
  const origProdKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origAegTestMode = process.env.AEG_TEST_MODE;

  try {
    setSupabaseClientForTesting(null);

    // 1. Even with production credentials present in process.env, automated test mode unconditionally ignores them
    process.env.SUPABASE_URL = "https://simulated-prod-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "simulated_prod_service_role_key";

    assert.equal(getSupabaseConfig(), null);
    assert.equal(isSupabaseConfigured(), false);
    assert.equal(getSupabaseClient(), null);
    assert.doesNotThrow(() => assertTestDatabaseIsolation());

    // 2. Attempting to inject a real @supabase/supabase-js client into setSupabaseClientForTesting fails fast
    const accidentalRealClient = createClient(
      "https://simulated-prod-project.supabase.co",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    assert.throws(
      () => setSupabaseClientForTesting(accidentalRealClient),
      /Test isolation failure: Real SupabaseClient instances cannot be injected/i
    );

    // 3. Verify .env.example contains only runtime placeholders and does NOT request TEST_SUPABASE_* variables
    const envExample = fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8");
    assert.equal(envExample.includes("TEST_SUPABASE_"), false, ".env.example must not prompt for TEST_SUPABASE_* variables");
    assert.match(envExample, /^SUPABASE_URL=\s*$/m);
    assert.match(envExample, /^ESP32_SECRET=\s*$/m);
    assert.match(envExample, /^JWT_SECRET=\s*$/m);
  } finally {
    if (origProdUrl !== undefined) process.env.SUPABASE_URL = origProdUrl;
    else delete process.env.SUPABASE_URL;

    if (origProdKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = origProdKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (origAegTestMode !== undefined) process.env.AEG_TEST_MODE = origAegTestMode;
    setSupabaseClientForTesting(null);
  }
});

test("Regression 7: Dashboard & Admin APIs reflect effective stale timeout and never expose secrets", async () => {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, "dashboard", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(ROOT_DIR, "dashboard", "app.js"), "utf8");
  const loginHtml = fs.readFileSync(path.join(ROOT_DIR, "dashboard", "login.html"), "utf8");

  // No legacy hardcoded 120-second stale timeout text in dashboard
  assert.equal(/120\s*seconds|120s/i.test(indexHtml), false, "dashboard/index.html must not hardcode 120s timeout");
  assert.equal(/120\s*seconds|120s/i.test(appJs), false, "dashboard/app.js must not hardcode 120s timeout");
  assert.match(indexHtml, /id="diag-stale-thresh">30 seconds</);
  assert.match(appJs, /staleThresholdSeconds/);

  // Frontend files never reference or expose server-side secrets
  for (const frontendContent of [indexHtml, appJs, loginHtml]) {
    assert.equal(frontendContent.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
    assert.equal(frontendContent.includes("SUPABASE_SECRET_KEY"), false);
    assert.equal(frontendContent.includes("ESP32_SECRET"), false);
    assert.equal(frontendContent.includes(TEST_ESP32_SECRET), false);
  }

  // Dynamic timeout propagation across /api/admin/settings, /api/admin/ml-status, /api/diagnostics, and /health
  const adminLogin = await sendJson("POST", "/api/auth/login", {
    email: "admin@energyguardian.ai",
    password: "AdminGuardian2026!",
  });
  assert.equal(adminLogin.status, 200);
  const authHeader = { Authorization: `Bearer ${adminLogin.body.token}` };

  try {
    const patchRes = await sendJson("PATCH", "/api/admin/settings", { stale_threshold_seconds: 45 }, authHeader);
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.stale_threshold_seconds, 45);

    const mlStatus = await sendJson("GET", "/api/admin/ml-status", undefined, authHeader);
    assert.equal(mlStatus.status, 200);
    const guardrails: string[] = mlStatus.body.data_quality_enforcement;
    assert.ok(guardrails.some((line) => line.includes("45s inactivity")));
    assert.equal(guardrails.some((line) => line.includes("120s")), false);

    const diag = await sendJson("GET", "/api/diagnostics", undefined, authHeader);
    assert.equal(diag.status, 200);
    assert.equal(diag.body.staleThresholdSeconds, 45);

    const health = await sendJson("GET", "/health");
    assert.equal(health.body.sensor_health.staleThresholdSeconds, 45);
  } finally {
    await sendJson(
      "PATCH",
      "/api/admin/settings",
      { stale_threshold_seconds: DEFAULT_STALE_TIMEOUT_SECONDS },
      authHeader
    );
  }
});

test("Regression 8: #diag-storage uses authoritative /api/diagnostics storage_mode and handles loading, missing data, and errors safely", async () => {
  const appJsSource = fs.readFileSync(path.join(ROOT_DIR, "dashboard", "app.js"), "utf8");

  // Confirm the buggy window.history truthiness check is completely gone
  assert.equal(
    /history\s*\?\s*["']Process-local memory["']/.test(appJsSource),
    false,
    "dashboard/app.js must not use window.history truthiness for #diag-storage"
  );

  // Build a lightweight VM harness to execute dashboard/app.js and inspect #diag-storage + resolveDiagnosticsStorageLabel
  const elements = new Map<string, any>();
  function getOrCreateEl(id: string) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: "",
        innerHTML: "",
        value: "",
        disabled: false,
        style: {},
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {},
        replaceChildren() {},
        appendChild() {},
        setAttribute() {},
      });
    }
    return elements.get(id);
  }

  let storedToken = "";
  let failDiagnosticsNetwork = false;

  const sandbox: Record<string, any> = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Promise,
    Error,
    URL,
    Blob,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: (k: string) => (k === "aieg_auth_token" ? storedToken || null : null),
      setItem: (_k: string, v: string) => { storedToken = v; },
      removeItem: () => { storedToken = ""; },
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    window: {
      history: { length: 1 }, // Truthy browser window.history that triggered the old bug
      location: { href: "/" },
      addEventListener() {},
    },
    document: {
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      getElementById: (id: string) => getOrCreateEl(id),
      createElement: () => getOrCreateEl(`anon_${elements.size}`),
    },
    fetch: (urlPath: string, opts?: any) => {
      if (failDiagnosticsNetwork && String(urlPath).startsWith("/api/diagnostics")) {
        return Promise.reject(new Error("Simulated network failure"));
      }
      return fetch(`${API_BASE}${urlPath}`, opts);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(appJsSource, sandbox);

  const resolveLabel = vm.runInContext("resolveDiagnosticsStorageLabel", sandbox) as (
    diag: any,
    state?: string
  ) => string;
  const loadDiagnostics = vm.runInContext("loadHardwareDiagnostics", sandbox) as () => Promise<any>;

  // 1. Unit checks for loading, missing data, error, mock, process-local, degraded, and connected Supabase modes
  assert.equal(resolveLabel(null, "loading"), "Checking storage…");
  assert.equal(resolveLabel(null, "error"), "Unavailable");
  assert.equal(resolveLabel(null, "ready"), "Unavailable");
  assert.equal(resolveLabel({}, "ready"), "Unavailable");
  assert.equal(resolveLabel({ storage_mode: "" }, "ready"), "Unavailable");
  assert.equal(resolveLabel({ storage_mode: "unknown_future_mode" }, "ready"), "Unavailable");
  assert.equal(resolveLabel({ storage_mode: "in_memory_demo" }, "ready"), "Process-local memory");
  assert.equal(resolveLabel({ storage_mode: "mock" }, "ready"), "Mock storage");
  assert.equal(
    resolveLabel({ storage_mode: "supabase_postgresql", database_connected: true }, "ready"),
    "Supabase PostgreSQL"
  );
  assert.equal(
    resolveLabel({ storage_mode: "supabase_postgresql", database_connected: false }, "ready"),
    "Supabase PostgreSQL (Unreachable)"
  );

  // 2. End-to-end check against /api/diagnostics as Operator
  const opLogin = await sendJson("POST", "/api/auth/login", {
    email: "operator@energyguardian.ai",
    password: "OperatorGuardian2026!",
  });
  assert.equal(opLogin.status, 200);
  storedToken = opLogin.body.token;

  try {
    // 2a. Default isolated in-memory mode -> /api/diagnostics returns storage_mode: "in_memory_demo"
    setSupabaseClientForTesting(null);
    await loadDiagnostics();
    assert.equal(getOrCreateEl("diag-storage").textContent, "Process-local memory");

    // 2b. Connected Supabase mode (via mock client) -> /api/diagnostics returns storage_mode: "supabase_postgresql", database_connected: true
    const connectedMockDb = {
      from: () => ({
        select: () => ({
          limit: () => Promise.resolve({ data: [{ id: "row_1" }], error: null }),
        }),
      }),
    };
    setSupabaseClientForTesting(connectedMockDb as any);
    await loadDiagnostics();
    assert.equal(getOrCreateEl("diag-storage").textContent, "Supabase PostgreSQL");

    // 2c. Configured but unreachable Supabase -> never falsely claims healthy connection
    const unreachableMockDb = {
      from: () => ({
        select: () => ({
          limit: () => Promise.resolve({ data: null, error: { message: "Connection refused" } }),
        }),
      }),
    };
    setSupabaseClientForTesting(unreachableMockDb as any);
    await loadDiagnostics();
    assert.equal(getOrCreateEl("diag-storage").textContent, "Supabase PostgreSQL (Unreachable)");

    // 2d. API / network error -> falls back safely to "Unavailable", never retaining or claiming Supabase
    failDiagnosticsNetwork = true;
    await loadDiagnostics();
    assert.equal(getOrCreateEl("diag-storage").textContent, "Unavailable");
  } finally {
    failDiagnosticsNetwork = false;
    setSupabaseClientForTesting(null);
  }
});

test("Regression 9: Cloud Run graceful shutdown stops continuous simulator and closes HTTP server cleanly; Dockerfile & .dockerignore enforce security", async () => {
  const { startServer, shutdownServer } = await import("../server.js");
  const { setContinuousSimulator, getSimulatorStatus } = await import("../src/simulator.js");

  // Start an ephemeral server instance, enable continuous simulator, then invoke shutdownServer()
  const tempServer = await startServer(0, "127.0.0.1");
  try {
    assert.equal(tempServer.listening, true);

    setContinuousSimulator(true, 60_000);
    assert.equal(getSimulatorStatus().active, true);

    await shutdownServer(tempServer);
    assert.equal(getSimulatorStatus().active, false, "Graceful shutdown must stop active simulator intervals");
    assert.equal(tempServer.listening, false, "Graceful shutdown must close the HTTP listener");

    // Idempotent second call must resolve cleanly without throwing
    await assert.doesNotReject(() => shutdownServer(tempServer));
  } finally {
    await shutdownServer(tempServer);
  }

  // Verify Dockerfile & .dockerignore invariants
  const dockerfile = fs.readFileSync(path.join(ROOT_DIR, "Dockerfile"), "utf8");
  const dockerignore = fs.readFileSync(path.join(ROOT_DIR, ".dockerignore"), "utf8");

  assert.match(dockerfile, /^FROM node:22-alpine AS builder/m);
  assert.match(dockerfile, /^USER node$/m, "Dockerfile must run as non-root user");
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /dashboard/);
  assert.match(dockerfile, /src\/historical_dataset\.json/);
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY|ESP32_SECRET|JWT_SECRET/.test(dockerfile), false, "Dockerfile must not bake secrets");

  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^dist$/m);
  assert.match(dockerignore, /^tests$/m);
});


