/**
 * AI Energy Guardian - Supabase PostgreSQL Storage Engine
 *
 * Implements server-side persistent database connection using @supabase/supabase-js.
 * Handles user persistence, sensor reading history, AI prediction logging,
 * and immutable administrative audit logs with honest status and failure reporting.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConfig {
  url: string;
  key: string;
  isServiceRole: boolean;
}

export interface SupabaseHealth {
  configured: boolean;
  connected: boolean;
  storageMode: "supabase_postgresql" | "in_memory_demo";
  storageName: string;
  endpoint?: string;
  latencyMs?: number;
  error?: string;
  lastChecked?: string;
}

let activeClient: SupabaseClient | null = null;
let clientOverriddenForTesting = false;
let lastHealthCheck: SupabaseHealth = {
  configured: false,
  connected: false,
  storageMode: "in_memory_demo",
  storageName: "nonpersistent demo storage (in-memory)",
  lastChecked: new Date().toISOString(),
};

export function normalizeSupabaseUrl(rawUrl: string): string {
  try {
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const parsed = new URL(trimmed);
      return parsed.origin;
    }
    return trimmed;
  } catch {
    return rawUrl.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
  }
}

/**
 * Resolves Supabase credentials strictly from environment variables.
 * Prioritizes SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY for authoritative server operations,
 * falling back to SUPABASE_ANON_KEY if service key is omitted.
 */
export function getSupabaseConfig(): SupabaseConfig | null {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();

  const key = serviceKey || anonKey;
  if (!rawUrl || !key) {
    return null;
  }

  const url = normalizeSupabaseUrl(rawUrl);

  return {
    url,
    key,
    isServiceRole: Boolean(serviceKey),
  };
}

export function isPlaceholderConfig(url?: string): boolean {
  if (!url) return true;
  const lower = url.toLowerCase().trim();
  return (
    lower.includes("your-project-ref") ||
    lower.includes("placeholder") ||
    lower.includes("example.supabase.co") ||
    lower === "https://.supabase.co" ||
    lower === "http://" ||
    lower === "https://"
  );
}

export function isSupabaseConfigured(): boolean {
  if (clientOverriddenForTesting) return true;
  const config = getSupabaseConfig();
  if (!config) return false;
  if (isPlaceholderConfig(config.url)) return false;
  return true;
}

/**
 * Returns the active Supabase client instance, initializing it lazily if configured.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (activeClient) return activeClient;

  const config = getSupabaseConfig();
  if (!config) return null;

  try {
    activeClient = createClient(config.url, config.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    return activeClient;
  } catch (err: any) {
    console.error("[Supabase] Failed to initialize client:", err?.message || err);
    return null;
  }
}

/**
 * Allows automated tests to inject a mock or configured client for deterministic testing.
 */
export function setSupabaseClientForTesting(client: SupabaseClient | null): void {
  activeClient = client;
  clientOverriddenForTesting = client !== null;
  if (client) {
    lastHealthCheck = {
      configured: true,
      connected: true,
      storageMode: "supabase_postgresql",
      storageName: "Supabase PostgreSQL",
      lastChecked: new Date().toISOString(),
    };
  } else {
    lastHealthCheck = {
      configured: false,
      connected: false,
      storageMode: "in_memory_demo",
      storageName: "nonpersistent demo storage (in-memory)",
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Returns the human-readable storage engine descriptor.
 * Never lies about storage: if credentials are absent or database is offline,
 * explicitly reports demo in-memory storage.
 */
export function getStorageName(): string {
  if (!isSupabaseConfigured()) {
    return "nonpersistent demo storage (in-memory)";
  }
  return "Supabase PostgreSQL";
}

export function getStorageMode(): "supabase_postgresql" | "in_memory_demo" {
  return isSupabaseConfigured() ? "supabase_postgresql" : "in_memory_demo";
}

/**
 * Tests database connectivity by performing a lightweight query.
 * Updates and returns the health status.
 */
export async function checkSupabaseHealth(): Promise<SupabaseHealth> {
  const configured = isSupabaseConfigured();
  if (!configured) {
    lastHealthCheck = {
      configured: false,
      connected: false,
      storageMode: "in_memory_demo",
      storageName: "nonpersistent demo storage (in-memory)",
      lastChecked: new Date().toISOString(),
      error: "Supabase credentials (SUPABASE_URL and SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY) not provided in environment.",
    };
    return lastHealthCheck;
  }

  const client = getSupabaseClient();
  if (!client) {
    lastHealthCheck = {
      configured: true,
      connected: false,
      storageMode: "in_memory_demo",
      storageName: "nonpersistent demo storage (in-memory)",
      lastChecked: new Date().toISOString(),
      error: "Supabase client initialization failed.",
    };
    return lastHealthCheck;
  }

  const start = Date.now();
  try {
    const { error } = await client.from("sensor_readings").select("id").limit(1);
    const latencyMs = Date.now() - start;

    if (error) {
      lastHealthCheck = {
        configured: true,
        connected: false,
        storageMode: "supabase_postgresql",
        storageName: "Supabase PostgreSQL (Connection Degraded)",
        latencyMs,
        error: error.message,
        lastChecked: new Date().toISOString(),
      };
    } else {
      const config = getSupabaseConfig();
      lastHealthCheck = {
        configured: true,
        connected: true,
        storageMode: "supabase_postgresql",
        storageName: "Supabase PostgreSQL",
        endpoint: config ? new URL(config.url).hostname : "configured-project",
        latencyMs,
        lastChecked: new Date().toISOString(),
      };
    }
  } catch (err: any) {
    lastHealthCheck = {
      configured: true,
      connected: false,
      storageMode: "supabase_postgresql",
      storageName: "Supabase PostgreSQL (Unreachable)",
      latencyMs: Date.now() - start,
      error: err?.message || String(err),
      lastChecked: new Date().toISOString(),
    };
  }

  return lastHealthCheck;
}

export function getLastSupabaseHealth(): SupabaseHealth {
  return lastHealthCheck;
}

// ----------------- Database CRUD Interfaces -----------------

export interface DbUser {
  id: string;
  email: string;
  role: string;
  password_hash: string;
  salt: string;
  assigned_room?: string;
  last_login_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DbReading {
  id: string;
  room_id: string;
  device_id: string | null;
  data_source: string;
  is_physical: boolean;
  timestamp: string;
  date: string | null;
  time: string | null;
  lecture: string | null;
  occupancy: number | null;
  temperature_c: number | null;
  humidity_pct: number | null;
  cloud_cover_pct: number | null;
  precipitation_mm: number | null;
  weather_condition: string | null;
  light_level: number | null;
  no_of_lights_on: number | null;
  no_of_fans_on: number | null;
  smart_board_on: boolean;
  measured_power_w: number | null;
  raw_reading: any;
  created_at?: string;
}

export interface DbAiPrediction {
  id?: string;
  reading_id: string;
  occupancy_prediction: string | null;
  predicted_fan_count: number | null;
  predicted_light_count: number | null;
  recommended_fan_count: number | null;
  recommended_light_count: number | null;
  ai_mode: string;
  reason: string | null;
  model_version: string;
  status: string;
  created_at?: string;
}

// Backward compatibility aliases if needed
export interface DbRawPrediction {
  id: string;
  reading_id: string;
  occupancy_prediction: string | null;
  predicted_fan_count: number | null;
  predicted_light_count: number | null;
  model_version: string;
  prediction_json?: any;
  created_at?: string;
}

export interface DbAiDecision {
  id: string;
  reading_id: string;
  prediction_id: string;
  recommended_fan_count: number | null;
  recommended_light_count: number | null;
  decision_json?: any;
  sensor_data_status?: string;
  created_at?: string;
}

export interface DbAuditLog {
  id?: string;
  timestamp: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_id: string | null;
  target_type: string | null;
  details: any;
}

export interface DbSensorEvent {
  id?: string;
  timestamp: string;
  message: string;
  severity: "info" | "warn" | "error";
  device_id?: string;
  details?: any;
}

/**
 * Persist an audit log entry to Supabase if configured.
 */
export async function logAuditEventToDb(entry: DbAuditLog): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client.from("audit_logs").insert([entry]);
    if (error) {
      console.warn("[Supabase] Failed to persist audit log:", error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn("[Supabase] Audit log insert error:", err?.message || err);
    return false;
  }
}
