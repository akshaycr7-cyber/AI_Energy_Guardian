import { randomUUID } from "node:crypto";
import {
  ClassroomReadingInput,
  predictAll,
  recommendStates,
  PredictionOutput,
  DecisionOutput,
} from "./ml.js";

export interface SensorStatusProvenance {
  kind: "esp32" | "simulated" | "manual" | "imported" | "PHYSICAL_ESP32" | "SIMULATOR" | "HISTORICAL";
  message: string;
  isPhysical: boolean;
  isHistorical?: boolean;
  deviceId?: string;
}

export interface HistoryRecord {
  id: string;
  timestamp: string;
  evaluated_at?: string;
  reading: ClassroomReadingInput;
  prediction: PredictionOutput;
  decision: {
    recommended_fan_count: number | null;
    recommended_light_count: number | null;
    reason: string;
    ai_mode: string;
    hardware_control_enabled: boolean;
  };
  sensor_data_status: SensorStatusProvenance;
  power_status: string;
}

export function sensorDataStatus(source: string, deviceId?: string, isHistorical = false): SensorStatusProvenance {
  const normalized = (source || "").toLowerCase().trim();
  if (isHistorical) {
    return {
      kind: normalized === "esp32" ? "esp32" : "imported",
      message: "HISTORICAL: Database record restored across server restart — not a live hardware connection.",
      isPhysical: normalized === "esp32",
      isHistorical: true,
      deviceId,
    };
  }
  const labels: Record<string, SensorStatusProvenance> = {
    esp32: {
      kind: "esp32",
      message: deviceId
        ? `PHYSICAL_ESP32: Authenticated live ESP32 telemetry from hardware node [${deviceId}].`
        : "PHYSICAL_ESP32: Reported by live classroom ESP32 microcontroller.",
      isPhysical: true,
      deviceId,
    },
    simulated: {
      kind: "simulated",
      message: "SIMULATOR: Synthetic development context — not physical sensor data.",
      isPhysical: false,
    },
    manual: {
      kind: "manual",
      message: "MANUAL: Manually entered reading — not an automatic physical sensor measurement.",
      isPhysical: false,
    },
    imported: {
      kind: "imported",
      message: "HISTORICAL: Calibrated historical record from dataset.",
      isPhysical: false,
      isHistorical: true,
    },
  };
  return labels[normalized] || labels.manual;
}

export interface SensorHealthStatus {
  backendStatus: "online" | "degraded";
  physicalSensorConnected: boolean;
  status: "live" | "stale" | "disconnected" | "simulated_only";
  statusText: string;
  lastPhysicalReadingTime: string | null;
  physicalAgeSeconds: number | null;
  totalPhysicalReadings: number;
  totalSimulatedReadings: number;
  totalRecords: number;
  latestDataSource: string | null;
  latestPhysicalReading: HistoryRecord | null;
  latestSimulatedReading: HistoryRecord | null;
  latestRecord: HistoryRecord | null;
  // Diagnostics & error tracking for Admin/Operator
  configuredDeviceId: string;
  lastValidPacketTime: string | null;
  staleThresholdSeconds: number;
  sensorErrors: Array<{ timestamp: string; message: string; severity: "warn" | "error" | "info" }>;
}

export interface HardwareHeartbeat {
  deviceId: string;
  lastReceivedEpochMs: number;
  lastTelemetryTimestamp: string;
  lastReading: HistoryRecord;
}

import {
  getSupabaseClient,
  isSupabaseConfigured,
  getStorageName,
  getStorageMode,
  DbReading,
  DbAiPrediction,
} from "./supabase.js";

class DemoHistoryStore {
  private items: HistoryRecord[] = [];
  private maxItems = 200;
  private sensorErrors: Array<{ timestamp: string; message: string; severity: "warn" | "error" | "info" }> = [];
  readonly configuredDeviceId = "ESP32_LAB_CLASSROOM_01";
  staleThresholdSeconds: number = process.env.SENSOR_STALE_TIMEOUT_SECONDS
    ? parseInt(process.env.SENSOR_STALE_TIMEOUT_SECONDS, 10)
    : 30;
  private liveHardwareHeartbeat: HardwareHeartbeat | null = null;

  get storageName(): string {
    return getStorageName();
  }

  get storageMode(): string {
    return getStorageMode();
  }

  setStaleThreshold(seconds: number): void {
    this.staleThresholdSeconds = Math.max(1, seconds);
  }

  getStaleThreshold(): number {
    return this.staleThresholdSeconds;
  }

  /**
   * Registers verified, authenticated telemetry from a live physical ESP32.
   * This is the authoritative way a hardware device is marked connected.
   */
  recordPhysicalTelemetry(record: HistoryRecord, deviceId: string): void {
    this.liveHardwareHeartbeat = {
      deviceId,
      lastReceivedEpochMs: Date.now(),
      lastTelemetryTimestamp: record.timestamp || new Date().toISOString(),
      lastReading: record,
    };
  }

  /**
   * Acknowledges a lightweight ping/heartbeat from an authenticated ESP32.
   */
  recordHeartbeat(deviceId: string): void {
    const now = Date.now();
    const iso = new Date().toISOString();
    if (this.liveHardwareHeartbeat) {
      this.liveHardwareHeartbeat.lastReceivedEpochMs = now;
      this.liveHardwareHeartbeat.deviceId = deviceId;
    } else {
      this.liveHardwareHeartbeat = {
        deviceId,
        lastReceivedEpochMs: now,
        lastTelemetryTimestamp: iso,
        lastReading: null as any,
      };
    }
  }

  constructor() {
    // Process boots with hardware state: DISCONNECTED
    this.recordSensorEvent("System initialized. Awaiting physical ESP32 hardware handshake on /readings.", "info");
    // Non-blocking sync with Supabase if configured
    this.syncWithDatabase().catch((err) => {
      console.warn("[HistoryStore] Background Supabase sync notice:", err?.message || err);
    });
  }

  /**
   * Synchronizes recent history from Supabase if configured,
   * restoring telemetry across server restarts without relying on brittle nested joins.
   */
  async syncWithDatabase(): Promise<void> {
    if (!isSupabaseConfigured()) return;
    const client = getSupabaseClient();
    if (!client) return;

    try {
      const { data: readingsData, error: readingsErr } = await client
        .from("sensor_readings")
        .select("*")
        .order("timestamp", { ascending: false })
        .limit(100);

      if (readingsErr) {
        console.warn("[HistoryStore] Supabase readings query notice:", readingsErr.message);
        return;
      }

      if (readingsData && readingsData.length > 0) {
        const readingIds = readingsData.map((r: any) => r.id);

        let aiPredsData: any[] = [];
        try {
          const { data, error } = await client
            .from("ai_predictions")
            .select("*")
            .in("reading_id", readingIds);
          if (!error && data) {
            aiPredsData = data;
          }
        } catch (_) {}

        const aiPredsByReading = new Map<string, any>();
        for (const a of aiPredsData) {
          if (a?.reading_id) aiPredsByReading.set(a.reading_id, a);
        }

        const restoredItems: HistoryRecord[] = readingsData.map((row: any) => {
          const inlineAiPred = Array.isArray(row.ai_predictions) ? row.ai_predictions[0] : row.ai_predictions;
          const aiPred = inlineAiPred || aiPredsByReading.get(row.id);

          const reading: ClassroomReadingInput = row.raw_reading || {
            timestamp: row.timestamp,
            date: row.date,
            time: row.time,
            lecture: row.lecture,
            occupancy: row.occupancy !== null && row.occupancy !== undefined ? Number(row.occupancy) : undefined,
            temperature_c: row.temperature_c !== null && row.temperature_c !== undefined ? Number(row.temperature_c) : undefined,
            humidity_pct: row.humidity_pct !== null && row.humidity_pct !== undefined ? Number(row.humidity_pct) : undefined,
            cloud_cover_pct: row.cloud_cover_pct !== null && row.cloud_cover_pct !== undefined ? Number(row.cloud_cover_pct) : undefined,
            precipitation_mm: row.precipitation_mm !== null && row.precipitation_mm !== undefined ? Number(row.precipitation_mm) : undefined,
            weather_condition: row.weather_condition,
            light_level: row.light_level !== null && row.light_level !== undefined ? Number(row.light_level) : undefined,
            no_of_lights_on: row.no_of_lights_on,
            no_of_fans_on: row.no_of_fans_on,
            smart_board_on: Boolean(row.smart_board_on),
            measured_power_w: row.measured_power_w !== null && row.measured_power_w !== undefined ? Number(row.measured_power_w) : null,
            data_source: row.data_source,
          };

          const effectiveTimestamp = row.timestamp || new Date().toISOString();
          const evaluatedAt = row.evaluated_at || effectiveTimestamp;

          return {
            id: row.id,
            timestamp: effectiveTimestamp,
            evaluated_at: evaluatedAt,
            reading,
            prediction: {
              occupancy_prediction: aiPred?.occupancy_prediction || null,
              predicted_fan_count: aiPred?.predicted_fan_count ?? null,
              predicted_light_count: aiPred?.predicted_light_count ?? null,
              model_version: aiPred?.model_version || "1.0.0",
              status: aiPred?.status || "valid",
              reason: aiPred?.reason,
            },
            decision: {
              recommended_fan_count: aiPred?.recommended_fan_count ?? null,
              recommended_light_count: aiPred?.recommended_light_count ?? null,
              reason: aiPred?.reason || "Restored from database record.",
              ai_mode: aiPred?.ai_mode || "AI_AUTO",
              hardware_control_enabled: false,
            },
            sensor_data_status: sensorDataStatus(row.data_source, row.device_id, true),
            power_status: row.measured_power_w !== null && row.measured_power_w !== undefined
              ? `${row.measured_power_w} W`
              : "unavailable: no physical power meter hardware connected",
          };
        });

        // Merge restored items into local memory
        this.items = restoredItems;
      }
    } catch (err: any) {
      console.warn("[HistoryStore] Could not complete database sync:", err?.message || err);
    }
  }

  recordSensorEvent(message: string, severity: "warn" | "error" | "info" = "info", deviceId?: string): void {
    const event = {
      timestamp: new Date().toISOString(),
      message,
      severity,
    };
    this.sensorErrors.unshift(event);
    if (this.sensorErrors.length > 50) {
      this.sensorErrors.length = 50;
    }

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        Promise.resolve(
          client.from("sensor_events").insert([
            {
              timestamp: event.timestamp,
              message: event.message,
              severity: event.severity,
              device_id: deviceId || this.configuredDeviceId,
            },
          ])
        ).catch((err: any) => console.warn("[HistoryStore] Sensor event insert error:", err?.message || err));
      }
    }
  }

  private createFullRecord(record: Omit<HistoryRecord, "id">): HistoryRecord {
    const id = randomUUID();
    const fullRecord: HistoryRecord = { id, ...record };
    this.items.unshift(fullRecord);
    if (this.items.length > this.maxItems) {
      this.items.length = this.maxItems;
    }
    return fullRecord;
  }

  private async persistRecordToDb(client: any, fullRecord: HistoryRecord, throwOnError = false): Promise<void> {
    const aiPredictionId = randomUUID();

    const now = new Date().toISOString();
    const effectiveTimestamp = fullRecord.timestamp || now;

    const readingRow = {
      id: fullRecord.id,
      room_id: "room_101",
      device_id: fullRecord.sensor_data_status.deviceId || (fullRecord.reading.data_source === "esp32" ? this.configuredDeviceId : null),
      data_source: fullRecord.reading.data_source || "manual",
      is_physical: Boolean(fullRecord.sensor_data_status.isPhysical),
      timestamp: effectiveTimestamp,
      sensor_timestamp: fullRecord.reading.timestamp || effectiveTimestamp,
      evaluated_at: fullRecord.evaluated_at || now,
      date: fullRecord.reading.date || null,
      time: fullRecord.reading.time || null,
      reading_date: fullRecord.reading.date || null,
      class_time: fullRecord.reading.time || null,
      lecture: fullRecord.reading.lecture || null,
      occupancy: fullRecord.reading.occupancy ?? null,
      temperature_c: fullRecord.reading.temperature_c ?? null,
      humidity_pct: fullRecord.reading.humidity_pct ?? null,
      cloud_cover_pct: fullRecord.reading.cloud_cover_pct ?? null,
      precipitation_mm: fullRecord.reading.precipitation_mm ?? null,
      weather_condition: fullRecord.reading.weather_condition ?? null,
      light_level: fullRecord.reading.light_level ?? null,
      no_of_lights_on: fullRecord.reading.no_of_lights_on ?? null,
      no_of_fans_on: fullRecord.reading.no_of_fans_on ?? null,
      smart_board_on: Boolean(fullRecord.reading.smart_board_on),
      measured_power_w: fullRecord.reading.measured_power_w ?? null,
      raw_reading: fullRecord.reading,
      reading_json: fullRecord.reading,
      created_at: effectiveTimestamp,
    };

    const aiPredRow = {
      id: aiPredictionId,
      reading_id: fullRecord.id,
      occupancy_prediction: fullRecord.prediction.occupancy_prediction,
      predicted_fan_count: fullRecord.prediction.predicted_fan_count,
      predicted_light_count: fullRecord.prediction.predicted_light_count,
      recommended_fan_count: fullRecord.decision.recommended_fan_count,
      recommended_light_count: fullRecord.decision.recommended_light_count,
      ai_mode: fullRecord.decision.ai_mode,
      reason: fullRecord.decision.reason,
      model_version: fullRecord.prediction.model_version || "1.0.0",
      status: fullRecord.prediction.status,
      created_at: fullRecord.timestamp,
    };

    const { error: rErr } = await client.from("sensor_readings").insert([readingRow]);
    if (rErr) {
      console.error("[HistoryStore] Failed to write sensor_reading to Supabase:", rErr.message);
      this.recordSensorEvent(`Database write warning: ${rErr.message}`, "warn");
      if (throwOnError) {
        throw new Error(`Failed to persist sensor_reading to Supabase: ${rErr.message}`);
      }
      return;
    }

    const { error: pErr } = await client.from("ai_predictions").insert([aiPredRow]);
    if (pErr) {
      console.warn("[HistoryStore] ai_predictions write warning:", pErr.message);
      if (throwOnError) {
        throw new Error(`Failed to persist ai_predictions to Supabase: ${pErr.message}`);
      }
    }
  }

  add(record: Omit<HistoryRecord, "id">): string {
    const fullRecord = this.createFullRecord(record);

    // Persist to Supabase across related tables if configured
    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        this.persistRecordToDb(client, fullRecord, false).catch((err: any) => {
          console.error("[HistoryStore] Supabase reading insert error:", err);
          this.recordSensorEvent(`Database insert error: ${err?.message || err}`, "error");
        });
      }
    }

    return fullRecord.id;
  }

  async addAsync(record: Omit<HistoryRecord, "id">): Promise<HistoryRecord> {
    const fullRecord = this.createFullRecord(record);

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        await this.persistRecordToDb(client, fullRecord, true);
      }
    }

    return fullRecord;
  }

  recent(limit = 30, filterSource?: string): HistoryRecord[] {
    const cleanLimit = Math.max(1, Math.min(200, limit));
    if (filterSource && filterSource !== "all") {
      return this.items
        .filter((item) => (item.reading.data_source || "").toLowerCase() === filterSource.toLowerCase())
        .slice(0, cleanLimit);
    }
    return this.items.slice(0, cleanLimit);
  }

  recentReadings(limit = 20): Array<{ id: string } & ClassroomReadingInput> {
    return this.items.slice(0, limit).map((item) => ({
      id: item.id,
      ...item.reading,
    }));
  }

  getLatestPhysical(): HistoryRecord | null {
    if (!this.liveHardwareHeartbeat || !this.liveHardwareHeartbeat.lastReading) {
      return null;
    }
    return this.liveHardwareHeartbeat.lastReading;
  }

  getLatestSimulated(): HistoryRecord | null {
    return this.items.find((item) => (item.reading.data_source || "").toLowerCase() === "simulated") || null;
  }

  getSensorHealth(): SensorHealthStatus {
    const physicalItems = this.items.filter((item) => (item.reading.data_source || "").toLowerCase() === "esp32" && !item.sensor_data_status.isHistorical);
    const simulatedItems = this.items.filter((item) => (item.reading.data_source || "").toLowerCase() === "simulated");
    const latestItem = this.items[0] || null;
    const latestSimulated = simulatedItems[0] || null;

    const totalPhysical = physicalItems.length;
    const totalSimulated = simulatedItems.length;

    // A physical sensor system is marked CONNECTED only when a verified, authenticated ESP32
    // has communicated with fresh telemetry within staleThresholdSeconds in this runtime process.
    if (!this.liveHardwareHeartbeat || !this.liveHardwareHeartbeat.lastReading) {
      return {
        backendStatus: "online",
        physicalSensorConnected: false,
        status: totalSimulated > 0 ? "simulated_only" : "disconnected",
        statusText: totalSimulated > 0
          ? "Physical sensors are not connected · Showing SIMULATED DATA only (Awaiting ESP32)"
          : "Physical sensors are not connected. Awaiting ESP32 hardware connection.",
        lastPhysicalReadingTime: null,
        physicalAgeSeconds: null,
        totalPhysicalReadings: totalPhysical,
        totalSimulatedReadings: totalSimulated,
        totalRecords: this.items.length,
        latestDataSource: latestItem ? (latestItem.sensor_data_status?.isHistorical ? "HISTORICAL" : latestItem.reading.data_source || "unknown") : null,
        latestPhysicalReading: null,
        latestSimulatedReading: latestSimulated,
        latestRecord: latestItem,
        configuredDeviceId: this.configuredDeviceId,
        lastValidPacketTime: null,
        staleThresholdSeconds: this.staleThresholdSeconds,
        sensorErrors: this.sensorErrors.slice(0, 10),
      };
    }

    const now = Date.now();
    const ageFromReceipt = Math.max(0, Math.round((now - this.liveHardwareHeartbeat.lastReceivedEpochMs) / 1000));
    const telemetryTime = new Date(this.liveHardwareHeartbeat.lastTelemetryTimestamp).getTime();
    const ageFromTelemetry = isNaN(telemetryTime) ? ageFromReceipt : Math.max(0, Math.round((now - telemetryTime) / 1000));
    const physicalAgeSeconds = Math.max(ageFromReceipt, ageFromTelemetry);
    const isLive = physicalAgeSeconds <= this.staleThresholdSeconds;

    return {
      backendStatus: "online",
      physicalSensorConnected: isLive,
      status: isLive ? "live" : "stale",
      statusText: isLive
        ? "Physical ESP32 Sensor Connected · Live Data"
        : `Physical ESP32 Sensor Stale (Last reported ${physicalAgeSeconds}s ago)`,
      lastPhysicalReadingTime: this.liveHardwareHeartbeat.lastTelemetryTimestamp,
      physicalAgeSeconds,
      totalPhysicalReadings: totalPhysical,
      totalSimulatedReadings: totalSimulated,
      totalRecords: this.items.length,
      latestDataSource: isLive ? "PHYSICAL_ESP32" : (latestItem ? (latestItem.sensor_data_status?.isHistorical ? "HISTORICAL" : latestItem.reading.data_source || "unknown") : null),
      latestPhysicalReading: isLive ? this.liveHardwareHeartbeat.lastReading : null,
      latestSimulatedReading: latestSimulated,
      latestRecord: latestItem,
      configuredDeviceId: this.liveHardwareHeartbeat.deviceId || this.configuredDeviceId,
      lastValidPacketTime: this.liveHardwareHeartbeat.lastTelemetryTimestamp,
      staleThresholdSeconds: this.staleThresholdSeconds,
      sensorErrors: this.sensorErrors.slice(0, 10),
    };
  }

  count(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.liveHardwareHeartbeat = null;
    this.recordSensorEvent("History memory reset. Awaiting ESP32 hardware connection.", "info");
  }
}

export const history = new DemoHistoryStore();
