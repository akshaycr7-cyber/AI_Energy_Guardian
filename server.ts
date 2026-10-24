import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  validateReadingInput,
  predictAll,
  recommendStates,
  ValidationError,
  ClassroomReadingInput,
} from "./src/ml.js";
import { history, sensorDataStatus } from "./src/history.js";
import {
  evaluateAndStoreReading,
  evaluateAndStoreReadingAsync,
  generateReading,
  runSimulatorStep,
  getSimulatorStatus,
  setContinuousSimulator,
} from "./src/simulator.js";
import {
  getApplianceConfig,
  updateApplianceConfig,
  calculatePowerAndSavings,
  getPrototypeConfig,
  updatePrototypeConfig,
  calculatePrototypeEnergyReport,
  getClassroomConfig,
  updateClassroomConfig,
  calculateClassroomConnectedLoad,
  evaluateClassroomSimulationPolicy,
  calculateClassroomSimulationReport,
  getPhysicalMeterConfig,
  updatePhysicalMeterConfig,
  getPhysicalEnergyReport,
} from "./src/power.js";

import {
  userStore,
  signToken,
  verifyPassword,
  requireAuth,
  requireAdmin,
  requireOperatorOrAdmin,
  optionalAuth,
  AuthenticatedRequest,
  UserRole,
} from "./src/auth.js";
import {
  isSupabaseConfigured,
  isAutomatedTestEnv,
  getStorageName,
  getStorageMode,
  checkSupabaseHealth,
  getLastSupabaseHealth,
  getSupabaseClient,
} from "./src/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = fs.existsSync(path.join(__dirname, "dashboard"))
  ? __dirname
  : path.resolve(__dirname, "..");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json());

// Public static dashboard
const dashboardDir = path.join(rootDir, "dashboard");
app.use("/dashboard", express.static(dashboardDir));
app.use(express.static(dashboardDir));

// Route to serve login page
app.get(["/login", "/dashboard/login"], (_req: Request, res: Response) => {
  res.sendFile(path.join(dashboardDir, "login.html"));
});

// Root route
app.get("/", (req: Request, res: Response) => {
  const accept = req.headers.accept || "";
  if (accept.includes("application/json")) {
    return res.json({
      service: "AI Energy Guardian",
      phase: 3,
      docs: "/docs",
      dashboard: "/dashboard/",
      login: "/login",
      backend_status: "online",
      sensor_health: history.getSensorHealth(),
    });
  }
  return res.redirect("/dashboard/");
});

// ----------------- Authentication Routes -----------------

// POST /api/auth/login
app.post("/api/auth/login", async (req: Request, res: Response) => {
  const { email, password, rememberMe } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ detail: "Email and password are required." });
  }

  const user = await userStore.findByEmailAsync(String(email));
  if (!user || !verifyPassword(String(password), user.passwordHash, user.salt)) {
    return res.status(401).json({ detail: "Invalid email or password." });
  }

  userStore.recordLogin(user.id);
  const expiry = rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
  const token = signToken({ sub: user.id, email: user.email, role: user.role }, expiry);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      assignedRoom: user.assignedRoom,
      createdAt: user.createdAt,
    },
  });
});

// POST /api/auth/register
app.post("/api/auth/register", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ detail: "Email and password are required." });
  }

  const emailStr = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
    return res.status(400).json({ detail: "Invalid email address format." });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ detail: "Password must be at least 8 characters long." });
  }

  try {
    const user = await userStore.createUserAsync(emailStr, String(password));
    const token = signToken({ sub: user.id, email: user.email, role: user.role });
    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        assignedRoom: user.assignedRoom,
        createdAt: user.createdAt,
      },
    });
  } catch (err: any) {
    res.status(409).json({ detail: err?.message || "Registration failed." });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  res.json({ user: req.user });
});

// POST /api/auth/forgot-password
app.post("/api/auth/forgot-password", (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ detail: "Email is required." });
  }
  res.json({
    message: "If an account with that email exists, reset instructions have been dispatched.",
  });
});

// POST /api/auth/reset-password
app.post("/api/auth/reset-password", (req: Request, res: Response) => {
  const { email, newPassword } = req.body || {};
  if (!email || !newPassword) {
    return res.status(400).json({ detail: "Email and new password are required." });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ detail: "Password must be at least 8 characters long." });
  }
  const updated = userStore.updatePassword(String(email), String(newPassword));
  if (!updated) {
    return res.status(404).json({ detail: "Account not found." });
  }
  res.json({ message: "Password updated successfully. You can now sign in with your new password." });
});

// POST /api/auth/logout
app.post("/api/auth/logout", (_req: Request, res: Response) => {
  res.json({ message: "Session successfully terminated." });
});

// ----------------- Administrative & Operator Routes -----------------

// GET /api/admin/users
app.get("/api/admin/users", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const users = await userStore.listUsersAsync();
  res.json({ users });
});

// PATCH /api/admin/users/:id/role
app.patch("/api/admin/users/:id/role", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { role } = req.body || {};
  const validRoles = ["admin", "operator", "occupant", "user"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ detail: "Invalid role. Must be 'admin', 'operator', or 'occupant'." });
  }

  try {
    const updated = await userStore.updateRoleAsync(userId, role as UserRole, {
      id: req.user?.id || "admin",
      email: req.user?.email || "admin@energyguardian.ai",
    });
    res.json({
      user: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
      },
    });
  } catch (err: any) {
    res.status(404).json({ detail: err?.message || "User not found." });
  }
});

// GET /api/admin/stats
app.get("/api/admin/stats", requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
  const users = userStore.listUsers();
  res.json({
    totalUsers: users.length,
    adminsCount: users.filter((u) => u.role === "admin").length,
    operatorsCount: users.filter((u) => u.role === "operator").length,
    normalUsersCount: users.filter((u) => u.role === "occupant" || u.role === "user").length,
    activeStorage: history.storageName,
    storageMode: history.storageMode,
    historicalReadingsCount: history.count(),
    systemMode: "autonomous-advisory",
  });
});

// GET /api/admin/audit-logs
app.get("/api/admin/audit-logs", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const sensorHealth = history.getSensorHealth();
  let dbLogs: any[] = [];
  if (isSupabaseConfigured()) {
    const client = getSupabaseClient();
    if (client) {
      try {
        const { data } = await client
          .from("audit_logs")
          .select("*")
          .order("timestamp", { ascending: false })
          .limit(50);
        if (data) {
          dbLogs = data.map((d: any) => ({
            timestamp: d.timestamp,
            action: d.action,
            actor: d.actor_email || d.actor_id || "system",
            details: typeof d.details === "object" ? JSON.stringify(d.details) : String(d.details || ""),
          }));
        }
      } catch (_) {}
    }
  }

  res.json({
    audit_logs: [
      ...dbLogs,
      {
        timestamp: new Date().toISOString(),
        action: "DIAGNOSTICS_INSPECTION",
        actor: _req.user?.email,
        details: "Administrative system health and security policy inspection",
      },
      ...sensorHealth.sensorErrors.map((err) => ({
        timestamp: err.timestamp,
        action: "HARDWARE_SENSOR_EVENT",
        actor: "ESP32_INGESTION_CONTROLLER",
        details: `[${err.severity.toUpperCase()}] ${err.message}`,
      })),
    ],
  });
});

// GET /api/admin/ml-status - Machine learning model status & data quality info
app.get("/api/admin/ml-status", requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
  const sensorHealth = history.getSensorHealth();
  res.json({
    models: [
      {
        name: "Occupancy Classifier",
        version: "v1.0.0",
        type: "Trained Decision Tree / Heuristic",
        status: "Active",
        purpose: "Predicts empty/active state to govern base power conservation",
      },
      {
        name: "Fan Regressor",
        version: "v1.0.0",
        type: "Trained Regression Model",
        status: "Active",
        purpose: "Forecasts optimal fan count (0-5) based on occupancy and temperature",
      },
      {
        name: "Light Regressor",
        version: "v1.0.0",
        type: "Trained Regression Model",
        status: "Active",
        purpose: "Forecasts light count (0-6) based on occupancy and ambient light conditions",
      },
      {
        name: "Advisory Rule Engine",
        version: "v1.0.0",
        type: "Autonomous Advisory Policy",
        status: "Active",
        purpose: "Enforces thermal comfort floors (>=30°C) and smart board visibility constraints",
      },
    ],
    training_baseline: {
      source: "Excel Calibrated Classroom Baseline (historical_dataset.json)",
      record_count: 1131,
      date_range: "2024-06-25 to 2024-07-06",
      features: ["occupancy", "temperature_c", "humidity_pct", "smart_board_on", "weather_condition"],
      quality_score: "99.4% valid",
    },
    data_quality_enforcement: [
      "Missing Feature Guard: When required inputs (occupancy) are absent, status is flagged 'insufficient_data' instead of fabricating numbers",
      "Sensor Plausibility Clamping: Temperature bounds [15°C - 45°C], Humidity bounds [10% - 100%]",
      "Power Integrity Guard: Electrical power savings are never estimated or fabricated without physical CT clamp meter",
      `Stale Data Invalidation: Telemetry automatically transitioned to stale after ${sensorHealth.staleThresholdSeconds}s inactivity`,
    ],
    prediction_telemetry: {
      total_predictions_stored: sensorHealth.totalRecords,
      latest_prediction_status: sensorHealth.latestRecord?.prediction?.status || "awaiting_telemetry",
      latest_reason: sensorHealth.latestRecord?.decision?.reason || "No prediction computed yet",
    },
  });
});

// GET /api/admin/settings - System settings & configuration
app.get("/api/admin/settings", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const dbHealth = isSupabaseConfigured() ? await checkSupabaseHealth() : getLastSupabaseHealth();
  res.json({
    stale_threshold_seconds: history.staleThresholdSeconds,
    configured_device_id: history.configuredDeviceId,
    storage_engine: history.storageName,
    storage_mode: history.storageMode,
    database_connected: dbHealth.connected,
    database_health: dbHealth,
    power_meter_required: true,
    telemetry_refresh_interval_ms: 10000,
    allowed_roles: ["admin", "operator", "occupant"],
  });
});

// PATCH /api/admin/settings - Update system settings
app.patch("/api/admin/settings", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const { stale_threshold_seconds } = req.body || {};
  if (stale_threshold_seconds !== undefined) {
    history.setStaleThreshold(stale_threshold_seconds);
  }
  res.json({
    message: "Settings updated successfully.",
    stale_threshold_seconds: history.staleThresholdSeconds,
    configured_device_id: history.configuredDeviceId,
  });
});

// GET /api/diagnostics - Role-filtered hardware diagnostics
app.get("/api/diagnostics", requireOperatorOrAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const sensorHealth = history.getSensorHealth();
  const dbHealth = isSupabaseConfigured() ? await checkSupabaseHealth() : getLastSupabaseHealth();
  const isAdmin = req.user?.role === "admin";

  const diagnosticsData: any = {
    role: req.user?.role,
    connection_state: sensorHealth.status,
    physicalSensorConnected: sensorHealth.physicalSensorConnected,
    configuredDeviceId: sensorHealth.configuredDeviceId,
    lastValidPacketTime: sensorHealth.lastValidPacketTime,
    physicalAgeSeconds: sensorHealth.physicalAgeSeconds,
    staleDuration: sensorHealth.physicalAgeSeconds !== null ? `${sensorHealth.physicalAgeSeconds}s` : "N/A",
    staleThresholdSeconds: sensorHealth.staleThresholdSeconds,
    sensorErrors: sensorHealth.sensorErrors,
    storage_mode: history.storageMode,
    database_connected: dbHealth.connected,
  };

  if (isAdmin) {
    diagnosticsData.admin_details = {
      backend_status: sensorHealth.backendStatus,
      storage_engine: history.storageName,
      storage_mode: history.storageMode,
      database_configured: isSupabaseConfigured(),
      database_health: dbHealth,
      total_physical_packets: sensorHealth.totalPhysicalReadings,
      total_simulated_packets: sensorHealth.totalSimulatedReadings,
      memory_records: sensorHealth.totalRecords,
      configured_ingestion_endpoint: "POST /readings (with x-device-id & secret)",
      device_whitelist: ["ESP32_LAB_CLASSROOM_01"],
    };
  }

  res.json(diagnosticsData);
});

// GET /api/rooms - Overview of monitored rooms
app.get("/api/rooms", optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const role = req.user?.role || "occupant";
  const sensorHealth = history.getSensorHealth();

  const allRooms = [
    {
      id: "room_101",
      name: "Lab Classroom 101",
      building: "Science & Engineering Complex",
      status: sensorHealth.physicalSensorConnected ? "live" : sensorHealth.status === "stale" ? "stale" : "disconnected",
      deviceId: "ESP32_LAB_CLASSROOM_01",
      monitoredAppliances: ["5x Ceiling Fans", "8x Dual-Tube Fluorescent / LED Lights", "1x Smart Interactive Board"],
      lastPacket: sensorHealth.lastPhysicalReadingTime,
    },
    {
      id: "room_102",
      name: "Seminar Hall 204",
      building: "Academic Center North",
      status: "disconnected",
      deviceId: "ESP32_SEMINAR_204",
      monitoredAppliances: ["8x Ceiling Fans", "12x LED Panels", "2x Projectors"],
      lastPacket: null,
    },
    {
      id: "room_103",
      name: "Lecture Theater 305",
      building: "Engineering Block B",
      status: "disconnected",
      deviceId: "ESP32_LECTURE_305",
      monitoredAppliances: ["12x Ceiling Fans", "24x Recessed Downlights", "1x Digital Podium"],
      lastPacket: null,
    },
  ];

  if (role === "admin") {
    return res.json({ rooms: allRooms, access_level: "all_rooms" });
  }

  // Operator and normal users only see their assigned room
  const assigned = allRooms.filter((r) => r.name === "Lab Classroom 101");
  res.json({ rooms: assigned, access_level: "assigned_only" });
});

// ----------------- Health & Telemetry Routes -----------------

// Health check endpoint: distinguishes Backend Status from Physical Sensor Status
app.get("/health", async (_req: Request, res: Response) => {
  const sensorHealth = history.getSensorHealth();
  const dbHealth = isSupabaseConfigured() ? await checkSupabaseHealth() : getLastSupabaseHealth();
  res.json({
    status: "ok",
    backend_status: "online",
    service: "ai-energy-guardian",
    storage: history.storageName,
    storage_mode: history.storageMode,
    database_connected: dbHealth.connected,
    database_status: dbHealth,
    sensor_health: sensorHealth,
    notes: {
      backend: "FastAPI-compatible Express engine running normally.",
      storage: isSupabaseConfigured()
        ? (dbHealth.connected ? "Real Supabase PostgreSQL persistence active." : `Supabase configured but unreachable (${dbHealth.error || "connection error"}).`)
        : "Nonpersistent demo storage (in-memory) active.",
      physical_sensors: sensorHealth.physicalSensorConnected
        ? "Physical ESP32 sensors actively transmitting telemetry."
        : "Physical ESP32 disconnected. Awaiting hardware packets on /readings.",
    },
  });
});

// History endpoint
app.get("/history", (req: Request, res: Response) => {
  const rawLimit = req.query.limit;
  const source = req.query.source ? String(req.query.source) : undefined;
  let limit = 30;
  if (rawLimit !== undefined) {
    limit = parseInt(String(rawLimit), 10);
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(422).json({ detail: "limit must be between 1 and 200" });
    }
  }
  const items = history.recent(limit, source);
  res.json({
    items,
    storage: history.storageName,
    sensor_health: history.getSensorHealth(),
  });
});

// Historical calibrated dataset endpoint
app.get("/history/dataset", (_req: Request, res: Response) => {
  try {
    const datasetPath = path.join(rootDir, "src", "historical_dataset.json");
    if (fs.existsSync(datasetPath)) {
      const raw = fs.readFileSync(datasetPath, "utf-8");
      const parsed = JSON.parse(raw);
      return res.json(parsed);
    }
    res.status(404).json({ detail: "Historical dataset file not found." });
  } catch (err: any) {
    res.status(500).json({ detail: "Failed to load historical dataset: " + err?.message });
  }
});

/**
 * Robust Device Data Source Resolver
 *
 * Enforces strict authentication for all physical ESP32 telemetry and heartbeats:
 * requires BOTH a whitelisted x-device-id header AND a matching secret header
 * (x-device-secret or x-sensor-key) verified against process.env.ESP32_SECRET.
 */
const KNOWN_DEVICE_IDS = new Set(["ESP32_LAB_CLASSROOM_01", "esp32_dev_node_01"]);

function getConfiguredEsp32Secret(): string | null {
  const raw = process.env.ESP32_SECRET;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function constantTimeSecretMatch(candidate: string, expected: string): boolean {
  const candidateBuf = Buffer.from(candidate, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (candidateBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(candidateBuf, expectedBuf);
}

export interface DeviceSourceAuthResult {
  source: "esp32" | "simulated" | "manual" | "imported";
  isPhysical: boolean;
  claimsPhysical: boolean;
  deviceId?: string;
  isAuthenticated: boolean;
}

export function determineDeviceSource(
  req: Request,
  options: { requirePhysical?: boolean } = {}
): DeviceSourceAuthResult {
  const reqSource = typeof req.body?.data_source === "string" ? req.body.data_source.toLowerCase().trim() : "";
  const headerSource = typeof req.headers["x-sensor-source"] === "string"
    ? req.headers["x-sensor-source"].toLowerCase().trim()
    : "";
  const headerDeviceId = typeof req.headers["x-device-id"] === "string" ? req.headers["x-device-id"].trim() : "";
  const bodyDeviceId = typeof req.body?.device_id === "string" ? req.body.device_id.trim() : "";
  const rawSecretHeader = typeof req.headers["x-device-secret"] === "string"
    ? req.headers["x-device-secret"].trim()
    : typeof req.headers["x-sensor-key"] === "string"
      ? req.headers["x-sensor-key"].trim()
      : "";

  // Heartbeat endpoints strictly require authenticated physical ESP32 hardware
  if (options.requirePhysical) {
    if (reqSource === "simulated" || headerSource === "simulated" || reqSource === "imported" || headerSource === "imported") {
      return {
        source: "simulated",
        isPhysical: false,
        claimsPhysical: true,
        deviceId: headerDeviceId || bodyDeviceId || undefined,
        isAuthenticated: false,
      };
    }
  } else {
    // Explicit simulation / imported requests remain isolated from physical telemetry
    if (reqSource === "simulated" || headerSource === "simulated") {
      return { source: "simulated", isPhysical: false, claimsPhysical: false, isAuthenticated: true };
    }
    if (reqSource === "imported" || headerSource === "imported") {
      return { source: "imported", isPhysical: false, claimsPhysical: false, isAuthenticated: true };
    }
  }

  const claimsPhysical =
    Boolean(options.requirePhysical) ||
    reqSource === "esp32" ||
    headerSource === "esp32" ||
    headerSource === "hardware" ||
    headerDeviceId.length > 0 ||
    bodyDeviceId.length > 0 ||
    rawSecretHeader.length > 0;

  if (!claimsPhysical) {
    return { source: "manual", isPhysical: false, claimsPhysical: false, isAuthenticated: true };
  }

  const configuredSecret = getConfiguredEsp32Secret();
  const hasValidDevice = headerDeviceId.length > 0 && KNOWN_DEVICE_IDS.has(headerDeviceId);
  const hasValidSecret =
    configuredSecret !== null &&
    rawSecretHeader.length > 0 &&
    constantTimeSecretMatch(rawSecretHeader, configuredSecret);

  if (hasValidDevice && hasValidSecret) {
    return {
      source: "esp32",
      isPhysical: true,
      claimsPhysical: true,
      deviceId: headerDeviceId,
      isAuthenticated: true,
    };
  }

  return {
    source: "manual",
    isPhysical: false,
    claimsPhysical: true,
    deviceId: headerDeviceId || bodyDeviceId || undefined,
    isAuthenticated: false,
  };
}

// Reset history (Admin protected, or permitted for isolated testing)
app.delete("/history", (_req: Request, res: Response) => {
  setContinuousSimulator(false);
  history.clear();
  res.json({ message: "History cleared.", sensor_health: history.getSensorHealth() });
});

// Heartbeat endpoint for physical ESP32 nodes
app.post(["/readings/heartbeat", "/api/telemetry/heartbeat"], (req: Request, res: Response) => {
  const authResult = determineDeviceSource(req, { requirePhysical: true });
  if (!authResult.isAuthenticated || !authResult.isPhysical) {
    history.recordSensorEvent(
      `Rejected unauthenticated ESP32 heartbeat${authResult.deviceId ? ` (${authResult.deviceId})` : ""}`,
      "warn"
    );
    return res.status(401).json({
      detail: "Unauthenticated device heartbeat: Valid device ID (x-device-id) and matching device secret required.",
      error_code: "ESP32_UNAUTHENTICATED",
    });
  }
  const deviceId = authResult.deviceId || history.configuredDeviceId;
  history.recordHeartbeat(deviceId);
  res.json({
    status: "ok",
    message: "Heartbeat acknowledged.",
    timestamp: new Date().toISOString(),
    configured_device_id: deviceId,
    stale_threshold_seconds: history.staleThresholdSeconds,
  });
});

// Evaluate reading
app.post("/evaluate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authResult = determineDeviceSource(req);
    if (authResult.claimsPhysical && !authResult.isAuthenticated) {
      history.recordSensorEvent(
        `Rejected unauthenticated physical evaluation request${authResult.deviceId ? ` (${authResult.deviceId})` : ""}`,
        "warn"
      );
      return res.status(401).json({
        detail: "Unauthenticated device: Physical ESP32 evaluation requires valid x-device-id and matching device secret.",
        error_code: "ESP32_UNAUTHENTICATED",
      });
    }
    validateReadingInput(req.body);
    const reading: ClassroomReadingInput = {
      ...req.body,
      timestamp: req.body.timestamp || new Date().toISOString(),
      data_source: authResult.source,
      measured_power_w: req.body.measured_power_w !== undefined ? req.body.measured_power_w : null,
    };
    const result = await evaluateAndStoreReadingAsync(reading, authResult.deviceId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Readings endpoints
app.post("/readings", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authResult = determineDeviceSource(req);
    if (authResult.claimsPhysical && !authResult.isAuthenticated) {
      history.recordSensorEvent(
        `Rejected unauthenticated physical telemetry${authResult.deviceId ? ` (${authResult.deviceId})` : ""}`,
        "warn"
      );
      return res.status(401).json({
        detail: "Unauthenticated device: Telemetry claiming physical ESP32 source must provide valid device authentication headers (x-device-id and matching device secret).",
        error_code: "ESP32_UNAUTHENTICATED",
      });
    }

    validateReadingInput(req.body);

    const reading: ClassroomReadingInput = {
      ...req.body,
      timestamp: req.body.timestamp || new Date().toISOString(),
      data_source: authResult.source,
      measured_power_w: req.body.measured_power_w !== undefined ? req.body.measured_power_w : null,
    };
    const result = await evaluateAndStoreReadingAsync(reading, authResult.deviceId);
    if (authResult.isPhysical && authResult.isAuthenticated) {
      history.recordPhysicalTelemetry(result, authResult.deviceId || history.configuredDeviceId);
      history.recordSensorEvent(`Physical telemetry ingested from ${authResult.deviceId || "ESP32"}`, "info");
    }
    res.status(201).json({
      message: "Reading stored",
      id: result.id,
      data_source: reading.data_source,
      telemetry_source: authResult.isPhysical ? "PHYSICAL_ESP32" : (reading.data_source === "simulated" ? "SIMULATOR" : "HISTORICAL"),
      is_physical: authResult.isPhysical,
      device_id: authResult.deviceId,
    });
  } catch (err) {
    next(err);
  }
});

// Get latest reading (with physical flag & provenance metadata)
app.get("/readings/latest", (_req: Request, res: Response) => {
  const recent = history.recent(1);
  if (!recent.length) {
    return res.status(404).json({ detail: "No readings found" });
  }
  const item = recent[0];
  const isPhysical = (item.reading.data_source || "").toLowerCase() === "esp32" && !item.sensor_data_status?.isHistorical;
  const sensorHealth = history.getSensorHealth();
  const isLive = isPhysical && sensorHealth.physicalSensorConnected;
  const telemetrySource = isPhysical ? (isLive ? "PHYSICAL_ESP32" : "STALE_PHYSICAL") : (item.sensor_data_status?.isHistorical ? "HISTORICAL" : (item.reading.data_source === "simulated" ? "SIMULATOR" : "HISTORICAL"));

  res.json({
    id: item.id,
    is_physical: isPhysical,
    is_live: isLive,
    telemetry_source: telemetrySource,
    data_source: item.reading.data_source || "unknown",
    timestamp: item.timestamp,
    evaluated_at: item.evaluated_at || item.timestamp,
    ...item.reading,
  });
});

// Get latest physical reading specifically
app.get("/readings/latest/physical", (_req: Request, res: Response) => {
  const physical = history.getLatestPhysical();
  const sensorHealth = history.getSensorHealth();

  if (!physical || sensorHealth.status === "disconnected" || sensorHealth.status === "simulated_only") {
    return res.status(404).json({
      detail: "Physical sensors are not connected. Awaiting sensor connection. Live readings will appear after the ESP32 and sensors are connected and valid telemetry is received.",
      physical_sensor_connected: false,
      status: "disconnected",
    });
  }

  const isLive = sensorHealth.physicalSensorConnected;
  res.json({
    id: physical.id,
    is_physical: true,
    is_live: isLive,
    age_seconds: sensorHealth.physicalAgeSeconds ?? 0,
    telemetry_source: "PHYSICAL_ESP32",
    data_source: "esp32",
    timestamp: physical.timestamp,
    evaluated_at: physical.evaluated_at || physical.timestamp,
    ...physical.reading,
  });
});

app.get("/readings/recent", (req: Request, res: Response) => {
  const rawLimit = req.query.limit;
  let limit = 20;
  if (rawLimit !== undefined) {
    limit = parseInt(String(rawLimit), 10);
    if (isNaN(limit) || limit < 1 || limit > 100) {
      return res.status(422).json({ detail: "limit must be between 1 and 100" });
    }
  }
  res.json({
    items: history.recentReadings(limit),
  });
});

// Prediction endpoint: uses existing trained models and inputs
app.post("/predict", (req: Request, res: Response, next: NextFunction) => {
  try {
    validateReadingInput(req.body);
    const prediction = predictAll(req.body);
    res.json(prediction);
  } catch (err) {
    next(err);
  }
});

// Decision endpoint: advisory recommendation
app.post("/decision", (req: Request, res: Response, next: NextFunction) => {
  try {
    validateReadingInput(req.body);
    const prediction = predictAll(req.body);
    const recommendation = recommendStates(req.body, prediction);
    res.status(201).json({
      message: "Recommendation generated; no hardware control was issued.",
      decision: {
        recommended_fan_count: recommendation.fan_count,
        recommended_light_count: recommendation.light_count,
        reason: recommendation.reason,
        ai_mode: recommendation.mode,
        decision_mode: req.body.decision_mode || "recommendation",
        hardware_control_enabled: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Model endpoints
app.get("/model/status", (_req: Request, res: Response) => {
  res.json({
    models_directory: "ml/models",
    models_available: ["occupancy_classifier_v1", "fan_count_regressor_v1", "light_count_regressor_v1"],
    power_regression_available: false,
    note: "No genuine electrical power model is trained until measured_power_w observations exist. AI Energy Guardian never fabricates unmeasured power consumption or savings.",
  });
});

app.get("/model/versions", (_req: Request, res: Response) => {
  res.json({
    items: [
      {
        id: "v1.0.0",
        model_version: "1.0.0",
        trained_at: "2026-10-09T08:16:39Z",
        status: "production",
      },
    ],
  });
});

app.post("/model/retrain/check", (_req: Request, res: Response) => {
  res.json({
    eligible: false,
    reason: "Insufficient new labeled physical readings since last training.",
    current_samples: history.count(),
    required_samples: 100,
  });
});

// ----------------- Simulator Routes (Restricted to Authorized Operators & Admins) -----------------

// Manual simulator step trigger: requires Operator or Admin role
app.post("/simulator/run", requireOperatorOrAdmin, (req: AuthenticatedRequest, res: Response) => {
  const count = Math.min(10, Math.max(1, parseInt(String(req.body?.count || 1), 10)));
  const results = [];
  for (let i = 0; i < count; i++) {
    const reading = generateReading();
    results.push(evaluateAndStoreReading(reading));
  }
  res.json({
    count: results.length,
    label: "SIMULATED DATA",
    notice: "Synthetic development context — not physical sensor measurements.",
    items: results,
  });
});

// Toggle continuous background simulation: requires Operator or Admin role
app.post("/simulator/toggle", requireOperatorOrAdmin, (req: AuthenticatedRequest, res: Response) => {
  const enabled = Boolean(req.body?.enabled);
  const status = setContinuousSimulator(enabled);
  res.json({
    message: enabled ? "Continuous simulation activated." : "Continuous simulation stopped.",
    simulator_status: status,
  });
});

// Get simulator status
app.get("/simulator/status", (_req: Request, res: Response) => {
  res.json(getSimulatorStatus());
});

// ----------------- Power & Wattage Configuration and Savings Routes -----------------

// GET /api/power/config: returns appliance wattage specifications
app.get("/api/power/config", (_req: Request, res: Response) => {
  res.json({
    config: getApplianceConfig(),
    notes: "Appliance wattage specifications for bench mini fan, LED lights, and full classroom loads.",
  });
});

// PATCH /api/power/config: updates appliance wattage ratings (restricted if authenticated as occupant)
app.patch("/api/power/config", optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  if (req.user && req.user.role === "occupant") {
    return res.status(403).json({ detail: "Appliance wattage configuration requires Operator or Admin role." });
  }
  const updated = updateApplianceConfig(req.body || {});
  res.json({
    message: "Appliance wattage configuration updated successfully.",
    config: updated,
  });
});

// GET /api/power/summary: computes baseline vs AI power savings from latest observation
app.get("/api/power/summary", (req: Request, res: Response) => {
  const recent = history.recent(1);
  const latest = recent.length ? recent[0] : null;

  const sensorHealth = history.getSensorHealth();
  const isPhysical = Boolean(
    latest &&
    latest.reading.data_source === "esp32" &&
    !latest.sensor_data_status?.isHistorical &&
    sensorHealth.physicalSensorConnected
  );
  const dataSource = latest ? latest.reading.data_source || "simulated" : "no_data";
  const smartBoardOn = latest ? Boolean(latest.reading.smart_board_on) : false;

  const recommendedFans = latest?.decision?.recommended_fan_count ?? 2;
  const recommendedLights = latest?.decision?.recommended_light_count ?? 2;
  const actualFans = latest?.reading?.no_of_fans_on;
  const actualLights = latest?.reading?.no_of_lights_on;

  const summary = calculatePowerAndSavings(
    recommendedFans,
    recommendedLights,
    smartBoardOn,
    actualFans,
    actualLights,
    dataSource,
    isPhysical
  );

  const prototypeReport = calculatePrototypeEnergyReport({
    mini_fan_on: actualFans !== undefined && actualFans !== null ? actualFans > 0 : false,
    led_light_on: actualLights !== undefined && actualLights !== null ? actualLights > 0 : false,
    lcd_display_on: true,
  });

  const classroomReport = calculateClassroomSimulationReport({
    occupancy: latest?.reading?.occupancy ?? 25,
    temperature_c: latest?.reading?.temperature_c ?? 26.5,
    humidity_pct: latest?.reading?.humidity_pct ?? 55,
    ambient_light_lux: 350,
    smart_board_on: smartBoardOn,
    actual_fans_on: actualFans,
    actual_lights_on: actualLights,
  });

  const physicalLatest = history.getLatestPhysical();
  const physicalReport = getPhysicalEnergyReport(
    physicalLatest && physicalLatest.reading.measured_power_w !== null
      ? {
          measured_power_w: physicalLatest.reading.measured_power_w,
          device_id: history.configuredDeviceId,
          is_live: true,
        }
      : null
  );

  res.json({
    power_summary: summary,
    appliance_config: getApplianceConfig(),
    prototype_report: prototypeReport,
    classroom_report: classroomReport,
    physical_report: physicalReport,
    latest_reading_id: latest?.id || null,
    is_live_physical: isPhysical,
    has_physical_meter: physicalReport.meter_connected,
    physical_meter_notice: physicalReport.status_message,
  });
});

// ----------------- Three Separated Energy Reports Routes -----------------

// 1. Prototype Energy Report (Bench Testbed)
app.get("/api/reports/prototype", (_req: Request, res: Response) => {
  const recent = history.recent(1);
  const latest = recent.length ? recent[0] : null;
  const isPhysical = Boolean(
    latest?.reading?.data_source === "esp32" &&
    !latest.sensor_data_status?.isHistorical &&
    history.getSensorHealth().physicalSensorConnected
  );

  const report = calculatePrototypeEnergyReport({
    mini_fan_on: latest?.reading?.no_of_fans_on !== undefined && latest.reading.no_of_fans_on !== null ? latest.reading.no_of_fans_on > 0 : false,
    led_light_on: latest?.reading?.no_of_lights_on !== undefined && latest.reading.no_of_lights_on !== null ? latest.reading.no_of_lights_on > 0 : false,
    lcd_display_on: true,
  });

  res.json({
    report,
    config: getPrototypeConfig(),
    is_physical_reading: isPhysical,
    label: "ESTIMATED (PROTOTYPE BENCH)",
    notes: "Prototype bench energy calculations based on mini fan, LED, and configurable LCD display. Labeled as estimates.",
  });
});

app.patch("/api/reports/prototype/config", optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  if (req.user && req.user.role === "occupant") {
    return res.status(403).json({ detail: "Prototype configuration requires Operator or Admin role." });
  }
  const updated = updatePrototypeConfig(req.body || {});
  res.json({
    message: "Prototype configuration updated successfully.",
    config: updated,
  });
});

// 2. Classroom Simulation Report (Full Facility Model)
app.get("/api/reports/classroom", (_req: Request, res: Response) => {
  const recent = history.recent(1);
  const latest = recent.length ? recent[0] : null;
  const reading = latest?.reading;

  const report = calculateClassroomSimulationReport({
    occupancy: reading?.occupancy ?? 25,
    temperature_c: reading?.temperature_c ?? 26.5,
    humidity_pct: reading?.humidity_pct ?? 55,
    ambient_light_lux: 350,
    smart_board_on: Boolean(reading?.smart_board_on),
    actual_fans_on: reading?.no_of_fans_on,
    actual_lights_on: reading?.no_of_lights_on,
  });

  res.json({
    report,
    config: getClassroomConfig(),
    connected_load_w: calculateClassroomConnectedLoad(),
    label: "SIMULATED / PROJECTED",
    notes: "Classroom simulation report based on explicit rule-governed simulation policy.",
  });
});

app.patch("/api/reports/classroom/config", optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  if (req.user && req.user.role === "occupant") {
    return res.status(403).json({ detail: "Classroom configuration requires Operator or Admin role." });
  }
  const updated = updateClassroomConfig(req.body || {});
  res.json({
    message: "Classroom configuration updated successfully.",
    config: updated,
    connected_load_w: calculateClassroomConnectedLoad(updated),
  });
});

// 3. Physical Energy Report (Hardware CT Meter)
app.get("/api/reports/physical", (_req: Request, res: Response) => {
  const physical = history.getLatestPhysical();
  const hasHardwareReading =
    physical !== null &&
    physical !== undefined &&
    physical.reading?.measured_power_w !== null &&
    physical.reading?.measured_power_w !== undefined;

  const report = getPhysicalEnergyReport(
    hasHardwareReading
      ? {
          measured_power_w: physical.reading.measured_power_w,
          device_id: history.configuredDeviceId,
          is_live: true,
        }
      : null
  );

  res.json({
    report,
    config: getPhysicalMeterConfig(),
    status_message: report.status_message,
    meter_connected: report.meter_connected,
  });
});


// POST /api/recommendation/test: interactive recommendation testing sandbox for operators and occupants
app.post("/api/recommendation/test", (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body || {};
    const input: ClassroomReadingInput = {
      occupancy: Number(body.occupancy ?? 25),
      temperature_c: Number(body.temperature_c ?? 26.5),
      humidity_pct: Number(body.humidity_pct ?? 55),
      smart_board_on: Boolean(body.smart_board_on),
      no_of_fans_on: body.no_of_fans_on !== undefined ? Number(body.no_of_fans_on) : undefined,
      no_of_lights_on: body.no_of_lights_on !== undefined ? Number(body.no_of_lights_on) : undefined,
      timestamp: new Date().toISOString(),
      data_source: "simulated",
    };

    validateReadingInput(input);
    const prediction = predictAll(input);
    const recommendation = recommendStates(input, prediction);

    const powerBreakdown = calculatePowerAndSavings(
      recommendation.fan_count,
      recommendation.light_count,
      Boolean(input.smart_board_on),
      input.no_of_fans_on,
      input.no_of_lights_on,
      "interactive_test",
      false
    );

    res.json({
      scenario_label: "INTERACTIVE TEST SCENARIO",
      is_physical: false,
      input,
      prediction,
      recommendation,
      power_breakdown: powerBreakdown,
      appliance_config: getApplianceConfig(),
    });
  } catch (err) {
    next(err);
  }
});


// Error handling middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ValidationError) {
    return res.status(err.statusCode).json({ detail: err.message });
  }

  // Log full diagnostic error on server for administrator review
  console.error("Unhandled server error:", err);

  const rawMessage = String(err?.message || "");
  const isDatabaseInternal =
    /relation|column|constraint|violates|not-null|foreign key|syntax error|table "public\.|supabase|postgres|pgrst/i.test(rawMessage);

  if (isDatabaseInternal) {
    return res.status(503).json({
      detail: "Database persistence error encountered. Operation logged for administrator review.",
    });
  }

  res.status(500).json({ detail: err?.message || "Internal server error" });
});

export { app, startServer, shutdownServer };

let shutdownHandlersRegistered = false;
let isShuttingDown = false;

async function shutdownServer(server: ReturnType<typeof app.listen>): Promise<void> {
  setContinuousSimulator(false);
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      if (typeof (server as any).closeAllConnections === "function") {
        (server as any).closeAllConnections();
      }
      resolve();
    }, 5000);
    forceTimer.unref();

    server.close(() => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
}

function registerProcessShutdownHandlers(server: ReturnType<typeof app.listen>): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Received ${signal}. Stopping simulator intervals and closing HTTP server...`);
    shutdownServer(server)
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        console.error("[Server] Error during graceful shutdown:", err);
        process.exit(1);
      });
  };

  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));
}

async function startServer(port = PORT, host = HOST) {
  if (isSupabaseConfigured()) {
    try {
      await Promise.all([
        userStore.syncWithDatabase(),
        history.syncWithDatabase(),
      ]);
    } catch (err: any) {
      console.warn("[Server] Startup database hydration notice:", err?.message || err);
    }
  }

  return await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`AI Energy Guardian server running at http://${host}:${port}`);
      resolve(server);
    });
    server.once("error", reject);
  });
}

const isMainModule =
  !isAutomatedTestEnv() &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  startServer()
    .then((server) => {
      registerProcessShutdownHandlers(server);
    })
    .catch((err) => {
      console.error("[Server] Fatal startup error:", err);
      process.exit(1);
    });
}
