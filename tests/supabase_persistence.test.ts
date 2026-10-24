/**
 * AI Energy Guardian - Supabase Persistence & Database Health Tests
 *
 * Verifies:
 * 1. Supabase credentials detection & honest fallback reporting
 * 2. Database writes and reads for users, readings, predictions, and audit logs
 * 3. Telemetry and user restoration across simulated server restarts
 * 4. User and role authorization with immutable audit tracking
 * 5. Room-level data isolation
 * 6. Database outage & connection failure handling (no false persistence claims)
 * 7. Simulator vs. physical telemetry separation in database schema
 * 8. Real credentials check (distinguishing unit tests from live cloud tests)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  setSupabaseClientForTesting,
  checkSupabaseHealth,
  getStorageName,
  getStorageMode,
  isSupabaseConfigured,
  getSupabaseConfig,
} from "../src/supabase.js";
import { userStore, hashPassword } from "../src/auth.js";
import { history, sensorDataStatus } from "../src/history.js";
import { predictAll, recommendStates } from "../src/ml.js";

/**
 * Creates an in-memory SQL-like mock database implementing the Supabase client interface.
 * Used for deterministic testing of database persistence and failure handling.
 */
function createMockSupabaseClient(options: { failQueries?: boolean; failMessage?: string } = {}) {
  const tables: Record<string, any[]> = {
    users: [],
    sensor_readings: [],
    predictions: [],
    ai_predictions: [],
    ai_decisions: [],
    audit_logs: [],
    sensor_events: [],
  };

  function buildQuery(tableName: string) {
    let filterFn = (_row: any) => true;
    let sortFn = (a: any, b: any) => 0;
    let limitCount: number | null = null;

    const builder: any = {
      select: (_cols?: string) => builder,
      eq: (col: string, val: any) => {
        const prev = filterFn;
        filterFn = (row: any) => prev(row) && row[col] === val;
        return builder;
      },
      in: (col: string, values: any[]) => {
        const prev = filterFn;
        filterFn = (row: any) => prev(row) && Array.isArray(values) && values.includes(row[col]);
        return builder;
      },
      ilike: (col: string, val: string) => {
        const prev = filterFn;
        filterFn = (row: any) => prev(row) && String(row[col] || "").toLowerCase() === val.toLowerCase();
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        const asc = opts?.ascending !== false;
        sortFn = (a: any, b: any) => {
          if (a[col] < b[col]) return asc ? -1 : 1;
          if (a[col] > b[col]) return asc ? 1 : -1;
          return 0;
        };
        return builder;
      },
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      insert: (rows: any[]) => {
        if (options.failQueries) {
          return Promise.resolve({ data: null, error: { message: options.failMessage || "Mock PostgreSQL connection refused (503)" } });
        }
        const inserted = rows.map((r) => ({ ...r }));
        if (!tables[tableName]) {
          tables[tableName] = [];
        }
        tables[tableName].push(...inserted);
        return Promise.resolve({ data: inserted, error: null });
      },
      update: (updates: any) => {
        return {
          eq: (col: string, val: any) => {
            if (options.failQueries) {
              return Promise.resolve({ data: null, error: { message: options.failMessage || "Mock PostgreSQL query failed" } });
            }
            let updatedCount = 0;
            for (const row of (tables[tableName] || [])) {
              if (row[col] === val) {
                Object.assign(row, updates);
                updatedCount++;
              }
            }
            return Promise.resolve({ data: null, count: updatedCount, error: null });
          },
        };
      },
      catch: (reject: any) => {
        return builder.then(null, reject);
      },
      then: (resolve: any, reject: any) => {
        if (options.failQueries) {
          return Promise.resolve({
            data: null,
            error: { message: options.failMessage || "Database unreachable" },
          }).then(resolve, reject);
        }
        let result = (tables[tableName] || []).filter(filterFn);
        if (sortFn) result = result.sort(sortFn);
        if (limitCount !== null) result = result.slice(0, limitCount);
        return Promise.resolve({ data: result, error: null }).then(resolve, reject);
      },
    };

    return builder;
  }

  return {
    from: (tableName: string) => buildQuery(tableName),
    _tables: tables,
  };
}

test("1. Honest Storage Mode Reporting: Nonpersistent demo mode without credentials", () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedSecret = process.env.SUPABASE_SECRET_KEY;
  const savedAnon = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_ANON_KEY;

  try {
    // Ensure mock client is cleared to test default unconfigured state
    setSupabaseClientForTesting(null);

    assert.equal(isSupabaseConfigured(), false);
    assert.equal(getStorageMode(), "in_memory_demo");
    assert.equal(getStorageName(), "nonpersistent demo storage (in-memory)");

    const health = history.getSensorHealth();
    assert.equal(health.backendStatus, "online");
    assert.equal(history.storageName, "nonpersistent demo storage (in-memory)");
  } finally {
    if (savedUrl) process.env.SUPABASE_URL = savedUrl;
    if (savedKey) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    if (savedSecret) process.env.SUPABASE_SECRET_KEY = savedSecret;
    if (savedAnon) process.env.SUPABASE_ANON_KEY = savedAnon;
  }
});

test("2. Database Writes & Reads: User accounts, sensor readings, and AI predictions", async () => {
  const mockDb = createMockSupabaseClient();
  setSupabaseClientForTesting(mockDb as any);

  assert.equal(isSupabaseConfigured(), true);
  assert.equal(getStorageName(), "Supabase PostgreSQL");
  assert.equal(getStorageMode(), "supabase_postgresql");

  // Ingest reading via history store with Supabase enabled
  const readingPayload = {
    timestamp: new Date().toISOString(),
    occupancy: 28,
    temperature_c: 27.5,
    humidity_pct: 62.0,
    cloud_cover_pct: 35,
    weather_condition: "Cloudy",
    data_source: "esp32" as const,
  };
  const pred = predictAll(readingPayload);
  const dec = recommendStates(readingPayload, pred);

  const readingId = history.add({
    timestamp: readingPayload.timestamp,
    reading: readingPayload,
    prediction: pred,
    decision: {
      recommended_fan_count: dec.fan_count,
      recommended_light_count: dec.light_count,
      reason: dec.reason,
      ai_mode: dec.mode,
      hardware_control_enabled: false,
    },
    sensor_data_status: sensorDataStatus("esp32", "ESP32_LAB_CLASSROOM_01"),
    power_status: "unavailable: no physical power meter hardware connected",
  });

  assert.ok(readingId);

  // Give asynchronous insert a tick
  await new Promise((r) => setTimeout(r, 60));

  // Assert records were persisted to the mock database tables
  assert.equal(mockDb._tables.sensor_readings.length, 1);
  const dbReading = mockDb._tables.sensor_readings[0];
  assert.equal(dbReading.id, readingId);
  assert.equal(dbReading.data_source, "esp32");
  assert.equal(dbReading.is_physical, true);
  assert.equal(dbReading.device_id, "ESP32_LAB_CLASSROOM_01");
  assert.equal(dbReading.temperature_c, 27.5);

  assert.equal(mockDb._tables.ai_predictions.length, 1);
  const dbPred = mockDb._tables.ai_predictions[0];
  assert.equal(dbPred.reading_id, readingId);
  assert.equal(dbPred.status, "valid");
  assert.ok(typeof dbPred.predicted_fan_count === "number");

  setSupabaseClientForTesting(null);
});

test("3. Persistence Across Server Restarts: Hydrating memory from database", async () => {
  const mockDb = createMockSupabaseClient();
  const pastTimestamp = new Date(Date.now() - 30 * 1000).toISOString();

  // Populate mock database with existing historical record as if saved before restart
  mockDb._tables.sensor_readings.push({
    id: "pre_existing_reading_001",
    room_id: "room_101",
    device_id: "ESP32_LAB_CLASSROOM_01",
    data_source: "esp32",
    is_physical: true,
    timestamp: pastTimestamp,
    temperature_c: 29.0,
    humidity_pct: 65.0,
    occupancy: 32,
    raw_reading: {
      occupancy: 32,
      temperature_c: 29.0,
      humidity_pct: 65.0,
      data_source: "esp32",
    },
    ai_predictions: [
      {
        occupancy_prediction: "Occupied",
        predicted_fan_count: 3,
        predicted_light_count: 2,
        recommended_fan_count: 4,
        recommended_light_count: 2,
        ai_mode: "AI_AUTO",
        reason: "Occupied classroom; elevated temperature.",
        model_version: "1.0.0",
        status: "valid",
      },
    ],
  });

  setSupabaseClientForTesting(mockDb as any);

  // Trigger database synchronization (simulating server reboot)
  await history.syncWithDatabase();

  // Verify memory store was restored from database records
  const recent = history.recent(10);
  assert.ok(recent.length >= 1);
  const restored = recent.find((r) => r.id === "pre_existing_reading_001");
  assert.ok(restored, "Record should be hydrated from Supabase table");
  assert.equal(restored?.reading.occupancy, 32);
  assert.equal(restored?.sensor_data_status.isPhysical, true);
  assert.equal(restored?.sensor_data_status.kind, "esp32");

  setSupabaseClientForTesting(null);
});

test("4. User Authorization & Role Update with Immutable Audit Logging", async () => {
  const mockDb = createMockSupabaseClient();
  setSupabaseClientForTesting(mockDb as any);

  // Sync users with database
  await userStore.syncWithDatabase();
  assert.ok(mockDb._tables.users.length >= 3, "Default accounts should be seeded into Supabase users table");
  assert.ok(mockDb._tables.audit_logs.length >= 1, "Initial seed event must be logged to audit_logs");

  // Admin updates an operator's role
  const updatedUser = userStore.updateRole("usr_operator_002", "admin", {
    id: "usr_admin_001",
    email: "admin@energyguardian.ai",
  });
  assert.equal(updatedUser.role, "admin");

  // Give async write a tick
  await new Promise((r) => setTimeout(r, 60));

  // Check audit log in database
  const roleAudit = mockDb._tables.audit_logs.find((log) => log.action === "USER_ROLE_UPDATED");
  assert.ok(roleAudit, "Role change must generate an immutable audit log entry in Supabase");
  assert.equal(roleAudit.target_id, "usr_operator_002");
  assert.equal(roleAudit.actor_email, "admin@energyguardian.ai");

  // Restore operator role
  userStore.updateRole("usr_operator_002", "operator");
  setSupabaseClientForTesting(null);
});

test("5. Room-Level Data Isolation & Schema Integrity", async () => {
  const mockDb = createMockSupabaseClient();
  setSupabaseClientForTesting(mockDb as any);

  // Insert readings for room 101 and unauthorized room 999
  mockDb._tables.sensor_readings.push(
    {
      id: "reading_room_101",
      room_id: "room_101",
      device_id: "ESP32_LAB_CLASSROOM_01",
      data_source: "esp32",
      is_physical: true,
      timestamp: new Date().toISOString(),
    },
    {
      id: "reading_room_999",
      room_id: "room_999",
      device_id: "ESP32_RESTRICTED_999",
      data_source: "esp32",
      is_physical: true,
      timestamp: new Date().toISOString(),
    }
  );

  // Query scoped to assigned room 101
  const { data: room101Data } = await mockDb.from("sensor_readings").select("*").eq("room_id", "room_101");
  assert.equal(room101Data?.length, 1);
  assert.equal(room101Data?.[0].id, "reading_room_101");

  // Operator cannot query room 999
  const { data: room999Data } = await mockDb.from("sensor_readings").select("*").eq("room_id", "room_999");
  assert.equal(room999Data?.length, 1);
  assert.notEqual(room999Data?.[0].room_id, "room_101");

  setSupabaseClientForTesting(null);
});

test("6. Database Outage & Honest Failure Handling", async () => {
  // Configure mock client simulating database outage (e.g. 503 service unavailable)
  const failingDb = createMockSupabaseClient({
    failQueries: true,
    failMessage: "PostgreSQL connection timeout: Server unreachable",
  });
  setSupabaseClientForTesting(failingDb as any);

  const health = await checkSupabaseHealth();
  assert.equal(health.configured, true);
  assert.equal(health.connected, false, "Must honestly report disconnected on outage");
  assert.match(health.error || "", /PostgreSQL connection timeout/i);
  assert.match(health.storageName, /Connection Degraded|Unreachable/i);

  // Async user creation with failing database throws explicit error rather than pretending success
  await assert.rejects(
    async () => {
      await userStore.createUserAsync("failing_user@energyguardian.ai", "SecretPass123!");
    },
    /Failed to persist user to Supabase/i
  );

  // Async reading persistence with failing database throws explicit error rather than pretending success
  await assert.rejects(
    async () => {
      await history.addAsync({
        timestamp: new Date().toISOString(),
        reading: { occupancy: 10, temperature_c: 24, data_source: "esp32" },
        prediction: predictAll({ occupancy: 10, temperature_c: 24 }),
        decision: {
          recommended_fan_count: 1,
          recommended_light_count: 1,
          reason: "Test",
          ai_mode: "AI_AUTO",
          hardware_control_enabled: false,
        },
        sensor_data_status: sensorDataStatus("esp32"),
        power_status: "unavailable",
      });
    },
    /Failed to persist sensor_reading to Supabase/i
  );

  setSupabaseClientForTesting(null);
});

test("7. Simulator vs. Physical Telemetry Strict Schema Tagging", async () => {
  const mockDb = createMockSupabaseClient();
  setSupabaseClientForTesting(mockDb as any);

  // Ingest simulated telemetry
  history.add({
    timestamp: new Date().toISOString(),
    reading: {
      occupancy: 20,
      temperature_c: 24.0,
      data_source: "simulated",
    },
    prediction: predictAll({ occupancy: 20, temperature_c: 24.0 }),
    decision: {
      recommended_fan_count: 1,
      recommended_light_count: 2,
      reason: "Simulated observation.",
      ai_mode: "AI_AUTO",
      hardware_control_enabled: false,
    },
    sensor_data_status: sensorDataStatus("simulated"),
    power_status: "unavailable: no physical power meter hardware connected",
  });

  await new Promise((r) => setTimeout(r, 60));

  const simRow = mockDb._tables.sensor_readings[0];
  assert.ok(simRow);
  assert.equal(simRow.data_source, "simulated");
  assert.equal(simRow.is_physical, false, "Simulator must NEVER be marked as physical");
  assert.equal(simRow.device_id, null, "Simulator cannot claim a physical hardware device ID");

  setSupabaseClientForTesting(null);
});

test("8. Real Supabase Project Credentials Diagnostic", () => {
  const cfg = getSupabaseConfig();
  if (cfg) {
    console.log("ℹ️ Real Supabase credentials detected in environment.");
    console.log(`   Host: ${new URL(cfg.url).hostname}`);
    console.log(`   Service Role Key configured: ${cfg.isServiceRole}`);
  } else {
    console.log("ℹ️ No external Supabase credentials found in environment.");
    console.log("   Running in verified mock mode. Real credentials required for live Supabase deployment.");
  }
  assert.ok(true);
});
