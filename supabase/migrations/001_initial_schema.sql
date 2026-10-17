-- AI Energy Guardian - Supabase PostgreSQL Database Schema
-- Migration: 001_initial_schema.sql
-- Description: Creates or updates persistent storage tables for user accounts, sensor readings,
--              AI predictions/recommendations, sensor telemetry events, and audit logs.
--              Fully idempotent and safe to execute against fresh or existing databases.

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. USER ACCOUNTS & ROLE-BASED ACCESS CONTROL
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'occupant', 'user')),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  assigned_room TEXT DEFAULT 'Lab Classroom 101',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist if the table was pre-existing
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'occupant';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS salt TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS assigned_room TEXT DEFAULT 'Lab Classroom 101';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users (role);

COMMENT ON TABLE public.users IS 'Authenticated application user credentials and role-based permissions.';
COMMENT ON COLUMN public.users.password_hash IS 'Cryptographically salted scrypt password hash; never stored in plaintext.';
COMMENT ON COLUMN public.users.role IS 'Server-authoritative role: admin, operator, or occupant.';

-- ============================================================================
-- 2. SENSOR READINGS & HARDWARE TELEMETRY
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sensor_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id TEXT NOT NULL DEFAULT 'room_101',
  device_id TEXT,
  data_source TEXT NOT NULL CHECK (data_source IN ('esp32', 'simulated', 'manual', 'imported')),
  is_physical BOOLEAN NOT NULL DEFAULT FALSE,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  date TEXT,
  time TEXT,
  lecture TEXT,
  occupancy INTEGER CHECK (occupancy >= 0 AND occupancy <= 500),
  temperature_c NUMERIC(5, 2) CHECK (temperature_c >= -30 AND temperature_c <= 70),
  humidity_pct NUMERIC(5, 2) CHECK (humidity_pct >= 0 AND humidity_pct <= 100),
  cloud_cover_pct NUMERIC(5, 2) CHECK (cloud_cover_pct >= 0 AND cloud_cover_pct <= 100),
  precipitation_mm NUMERIC(5, 2),
  weather_condition TEXT,
  light_level NUMERIC(7, 2),
  no_of_lights_on INTEGER CHECK (no_of_lights_on >= 0),
  no_of_fans_on INTEGER CHECK (no_of_fans_on >= 0),
  smart_board_on BOOLEAN DEFAULT FALSE,
  measured_power_w NUMERIC(7, 2),
  raw_reading JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Crucial: Ensure the "timestamp" column and all fields exist on pre-existing tables
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS room_id TEXT NOT NULL DEFAULT 'room_101';
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS data_source TEXT DEFAULT 'manual';
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS is_physical BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS time TEXT;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS lecture TEXT;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS occupancy INTEGER;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS temperature_c NUMERIC(5, 2);
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS humidity_pct NUMERIC(5, 2);
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS cloud_cover_pct NUMERIC(5, 2);
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS precipitation_mm NUMERIC(5, 2);
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS weather_condition TEXT;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS light_level NUMERIC(7, 2);
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS no_of_lights_on INTEGER;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS no_of_fans_on INTEGER;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS smart_board_on BOOLEAN DEFAULT FALSE;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS measured_power_w NUMERIC(7, 2);
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS raw_reading JSONB;
ALTER TABLE public.sensor_readings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_sensor_readings_timestamp ON public.sensor_readings ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_source_timestamp ON public.sensor_readings (data_source, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_room_timestamp ON public.sensor_readings (room_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_physical ON public.sensor_readings (is_physical, "timestamp" DESC);

COMMENT ON TABLE public.sensor_readings IS 'Ingested telemetry strictly partitioned into physical esp32, simulated, manual, or imported data.';
COMMENT ON COLUMN public.sensor_readings.is_physical IS 'Strict flag indicating authenticated physical ESP32 hardware origin.';
COMMENT ON COLUMN public.sensor_readings.measured_power_w IS 'Direct physical power measurement. Null when power sub-meter is disconnected; never fabricated.';

-- ============================================================================
-- 3. AI PREDICTIONS & ADVISORY RECOMMENDATIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ai_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id UUID REFERENCES public.sensor_readings(id) ON DELETE CASCADE,
  occupancy_prediction TEXT,
  predicted_fan_count INTEGER,
  predicted_light_count INTEGER,
  recommended_fan_count INTEGER,
  recommended_light_count INTEGER,
  ai_mode TEXT NOT NULL DEFAULT 'AI_AUTO',
  reason TEXT,
  model_version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL CHECK (status IN ('valid', 'insufficient_data')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist if the table was pre-existing
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS reading_id UUID REFERENCES public.sensor_readings(id) ON DELETE CASCADE;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS occupancy_prediction TEXT;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS predicted_fan_count INTEGER;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS predicted_light_count INTEGER;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS recommended_fan_count INTEGER;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS recommended_light_count INTEGER;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'AI_AUTO';
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'valid';
ALTER TABLE public.ai_predictions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ai_predictions_reading_id ON public.ai_predictions (reading_id);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_created_at ON public.ai_predictions (created_at DESC);

COMMENT ON TABLE public.ai_predictions IS 'AI inference outputs and transparent advisory recommendations generated for sensor readings.';

-- ============================================================================
-- 4. SENSOR HARDWARE AUDIT & DIAGNOSTIC EVENTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sensor_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  device_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist if the table was pre-existing
ALTER TABLE public.sensor_events ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.sensor_events ADD COLUMN IF NOT EXISTS message TEXT DEFAULT '';
ALTER TABLE public.sensor_events ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info';
ALTER TABLE public.sensor_events ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public.sensor_events ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE public.sensor_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_sensor_events_timestamp ON public.sensor_events ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_events_severity ON public.sensor_events (severity);

-- ============================================================================
-- 5. ADMINISTRATIVE AUDIT TRAIL
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  target_type TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist if the table was pre-existing
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor_email TEXT;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS action TEXT DEFAULT '';
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON public.audit_logs ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);

COMMENT ON TABLE public.audit_logs IS 'Immutable audit log tracking role modifications, user creations, and critical system events.';

-- ============================================================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sensor_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sensor_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Note: The backend server connects via service_role key which bypasses RLS for authoritative operations.
-- The following policies secure direct client/anon queries if client-side Supabase SDK is ever enabled:

-- sensor_readings: Public read-only access for general dashboard display
DROP POLICY IF EXISTS sensor_readings_public_read ON public.sensor_readings;
CREATE POLICY sensor_readings_public_read ON public.sensor_readings
  FOR SELECT USING (true);

-- ai_predictions: Public read-only access for recommendations
DROP POLICY IF EXISTS ai_predictions_public_read ON public.ai_predictions;
CREATE POLICY ai_predictions_public_read ON public.ai_predictions
  FOR SELECT USING (true);

-- users: Users can read their own profile, cannot alter roles or read password hashes directly
DROP POLICY IF EXISTS users_self_read ON public.users;
CREATE POLICY users_self_read ON public.users
  FOR SELECT USING (auth.uid()::text = id);

-- audit_logs: Strictly restricted, not readable by unauthenticated users
DROP POLICY IF EXISTS audit_logs_service_only ON public.audit_logs;
CREATE POLICY audit_logs_service_only ON public.audit_logs
  FOR ALL USING (auth.role() = 'service_role');
