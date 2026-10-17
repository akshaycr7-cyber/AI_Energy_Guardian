import { randomUUID } from "node:crypto";
import {
  ClassroomReadingInput,
  predictAll,
  recommendStates,
  PredictionOutput,
  DecisionOutput,
} from "./ml.js";

export interface SensorStatusProvenance {
  kind: "esp32" | "simulated" | "manual" | "imported";
  message: string;
  isPhysical: boolean;
  deviceId?: string;
}

export interface HistoryRecord {
  id: string;
  timestamp: string;
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

export function sensorDataStatus(source: string, deviceId?: string): SensorStatusProvenance {
  const normalized = (source || "").toLowerCase().trim();
  const labels: Record<string, SensorStatusProvenance> = {
    esp32: {
      kind: "esp32",
      message: deviceId
        ? `LIVE PHYSICAL SENSOR: Authenticated ESP32 telemetry from hardware node [${deviceId}].`
        : "LIVE PHYSICAL SENSOR: Reported by classroom ESP32 microcontroller.",
      isPhysical: true,
      deviceId,
    },
    simulated: {
      kind: "simulated",
      message: "SIMULATED DATA: Synthetic development context — not a physical sensor measurement.",
      isPhysical: false,
    },
    manual: {
      kind: "manual",
      message: "MANUAL ENTRY: Manually entered reading — not an automatic physical sensor measurement.",
      isPhysical: false,
    },
    imported: {
      kind: "imported",
      message: "HISTORICAL DATASET: Calibrated historical record from training dataset.",
      isPhysical: false,
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
  readonly staleThresholdSeconds = 120; // 120 seconds per specification

  get storageName(): string {
    return getStorageName();
  }

  get storageMode(): string {
    return getStorageMode();
  }

  constructor() {
    // Process boots with hardware state
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

        // Fetch predictions, ai_predictions, and ai_decisions in parallel by reading_ids
        let predsData: any[] = [];
        let aiPredsData: any[] = [];
        let decisionsData: any[] = [];

        try {
          const [predsRes, aiPredsRes, decsRes] = await Promise.all([
            Promise.resolve(client.from("predictions").select("*").in("reading_id", readingIds)).catch(() => ({ data: null })),
            Promise.resolve(client.from("ai_predictions").select("*").in("reading_id", readingIds)).catch(() => ({ data: null })),
            Promise.resolve(client.from("ai_decisions").select("*").in("reading_id", readingIds)).catch(() => ({ data: null })),
          ]);
          predsData = predsRes?.data || [];
          aiPredsData = aiPredsRes?.data || [];
          decisionsData = decsRes?.data || [];
        } catch (_) {}

        const predsByReading = new Map<string, any>();
        for (const p of predsData) {
          if (p?.reading_id) predsByReading.set(p.reading_id, p);
        }

        const aiPredsByReading = new Map<string, any>();
        for (const a of aiPredsData) {
          if (a?.reading_id) aiPredsByReading.set(a.reading_id, a);
        }

        const decisionsByReading = new Map<string, any>();
        for (const d of decisionsData) {
          if (d?.reading_id) decisionsByReading.set(d.reading_id, d);
        }

        const restoredItems: HistoryRecord[] = readingsData.map((row: any) => {
          const rawPred = predsByReading.get(row.id);
          const aiPred = aiPredsByReading.get(row.id);
          const decision = decisionsByReading.get(row.id);

          const reading: ClassroomReadingInput = row.raw_reading || row.reading_json || {
            timestamp: row.timestamp || row.sensor_timestamp,
            date: row.date,
            time: row.time,
            lecture: row.lecture,
            occupancy: row.occupancy,
            temperature_c: row.temperature_c ? Number(row.temperature_c) : undefined,
            humidity_pct: row.humidity_pct ? Number(row.humidity_pct) : undefined,
            cloud_cover_pct: row.cloud_cover_pct ? Number(row.cloud_cover_pct) : undefined,
            precipitation_mm: row.precipitation_mm ? Number(row.precipitation_mm) : undefined,
            weather_condition: row.weather_condition,
            light_level: row.light_level ? Number(row.light_level) : undefined,
            no_of_lights_on: row.no_of_lights_on,
            no_of_fans_on: row.no_of_fans_on,
            smart_board_on: row.smart_board_on,
            measured_power_w: row.measured_power_w !== null ? Number(row.measured_power_w) : null,
            data_source: row.data_source,
          };

          const effectiveTimestamp = row.timestamp || row.sensor_timestamp || row.evaluated_at || new Date().toISOString();

          return {
            id: row.id,
            timestamp: effectiveTimestamp,
            reading,
            prediction: {
              occupancy_prediction: rawPred?.occupancy_prediction || aiPred?.occupancy_prediction || null,
              predicted_fan_count: rawPred?.predicted_fan_count ?? aiPred?.predicted_fan_count ?? null,
              predicted_light_count: rawPred?.predicted_light_count ?? aiPred?.predicted_light_count ?? null,
              model_version: rawPred?.model_version || aiPred?.model_version || "1.0.0",
              status: aiPred?.status || "valid",
              reason: aiPred?.reason,
            },
            decision: {
              recommended_fan_count: decision?.recommended_fan_count ?? aiPred?.recommended_fan_count ?? null,
              recommended_light_count: decision?.recommended_light_count ?? aiPred?.recommended_light_count ?? null,
              reason: aiPred?.reason || "Restored from database record.",
              ai_mode: aiPred?.ai_mode || "AI_AUTO",
              hardware_control_enabled: false,
            },
            sensor_data_status: sensorDataStatus(row.data_source, row.device_id),
            power_status: row.measured_power_w !== null
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

  add(record: Omit<HistoryRecord, "id">): string {
    const id = randomUUID();
    const fullRecord: HistoryRecord = { id, ...record };
    this.items.unshift(fullRecord);
    if (this.items.length > this.maxItems) {
      this.items.length = this.maxItems;
    }

    // Persist to Supabase across all related tables if configured
    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        const predictionId = randomUUID();
        const aiPredictionId = randomUUID();
        const decisionId = randomUUID();

        // 1. Parent sensor_readings row: populate both modern and legacy column aliases accurately
        const readingRow = {
          id: fullRecord.id,
          room_id: "room_101",
          device_id: fullRecord.sensor_data_status.deviceId || (fullRecord.reading.data_source === "esp32" ? this.configuredDeviceId : null),
          data_source: fullRecord.reading.data_source || "manual",
          is_physical: Boolean(fullRecord.sensor_data_status.isPhysical),
          timestamp: fullRecord.timestamp,
          sensor_timestamp: fullRecord.sensor_data_status.isPhysical ? fullRecord.timestamp : null,
          evaluated_at: new Date().toISOString(),
          date: fullRecord.reading.date || null,
          time: fullRecord.reading.time || null,
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
          created_at: fullRecord.timestamp,
        };

        // 2. Raw model predictions row
        const predictionRow = {
          id: predictionId,
          reading_id: fullRecord.id,
          occupancy_prediction: fullRecord.prediction.occupancy_prediction,
          predicted_fan_count: fullRecord.prediction.predicted_fan_count,
          predicted_light_count: fullRecord.prediction.predicted_light_count,
          model_version: fullRecord.prediction.model_version || "1.0.0",
          prediction_json: fullRecord.prediction,
          created_at: fullRecord.timestamp,
        };

        // 3. AI recommendation row
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

        // 4. AI decision record linking reading and prediction
        const decisionRow = {
          id: decisionId,
          reading_id: fullRecord.id,
          prediction_id: predictionId,
          recommended_fan_count: fullRecord.decision.recommended_fan_count,
          recommended_light_count: fullRecord.decision.recommended_light_count,
          decision_json: fullRecord.decision,
          sensor_data_status: fullRecord.sensor_data_status.message,
          created_at: fullRecord.timestamp,
        };

        // Step 1: Insert parent reading first; respect foreign key constraints
        Promise.resolve(client.from("sensor_readings").insert([readingRow]))
          .then(({ error: rErr }: any) => {
            if (rErr) {
              console.error("[HistoryStore] Failed to write sensor_reading to Supabase:", rErr.message);
              this.recordSensorEvent(`Database write warning: ${rErr.message}`, "warn");
              return; // Do NOT proceed with orphaned children if parent fails
            }

            // Step 2-4: Insert child prediction, recommendation, and decision records
            Promise.all([
              Promise.resolve(client.from("predictions").insert([predictionRow])).catch((err: any) =>
                console.warn("[HistoryStore] predictions write warning:", err?.message || err)
              ),
              Promise.resolve(client.from("ai_predictions").insert([aiPredRow])).catch((err: any) =>
                console.warn("[HistoryStore] ai_predictions write warning:", err?.message || err)
              ),
              Promise.resolve(client.from("ai_decisions").insert([decisionRow])).catch((err: any) =>
                console.warn("[HistoryStore] ai_decisions write warning:", err?.message || err)
              ),
            ]).catch((err: any) => {
              console.warn("[HistoryStore] Child table write notice:", err?.message || err);
            });
          })
          .catch((err: any) => {
            console.error("[HistoryStore] Supabase reading insert error:", err);
            this.recordSensorEvent(`Database insert error: ${err?.message || err}`, "error");
          });
      }
    }

    return id;
  }

  async addAsync(record: Omit<HistoryRecord, "id">): Promise<HistoryRecord> {
    const id = this.add(record);
    const fullRecord = this.items.find((i) => i.id === id)!;

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        const predictionId = randomUUID();
        const aiPredictionId = randomUUID();
        const decisionId = randomUUID();

        const readingRow = {
          id: fullRecord.id,
          room_id: "room_101",
          device_id: fullRecord.sensor_data_status.deviceId || (fullRecord.reading.data_source === "esp32" ? this.configuredDeviceId : null),
          data_source: fullRecord.reading.data_source || "manual",
          is_physical: Boolean(fullRecord.sensor_data_status.isPhysical),
          timestamp: fullRecord.timestamp,
          sensor_timestamp: fullRecord.sensor_data_status.isPhysical ? fullRecord.timestamp : null,
          evaluated_at: new Date().toISOString(),
          date: fullRecord.reading.date || null,
          time: fullRecord.reading.time || null,
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
          created_at: fullRecord.timestamp,
        };

        const predictionRow = {
          id: predictionId,
          reading_id: fullRecord.id,
          occupancy_prediction: fullRecord.prediction.occupancy_prediction,
          predicted_fan_count: fullRecord.prediction.predicted_fan_count,
          predicted_light_count: fullRecord.prediction.predicted_light_count,
          model_version: fullRecord.prediction.model_version || "1.0.0",
          prediction_json: fullRecord.prediction,
          created_at: fullRecord.timestamp,
        };

        const aiPredRow = {
          id: aiPredictionId,
          reading_id: fullRecord.id,
          recommended_fan_count: fullRecord.decision.recommended_fan_count,
          recommended_light_count: fullRecord.decision.recommended_light_count,
          ai_mode: fullRecord.decision.ai_mode,
          reason: fullRecord.decision.reason,
          status: fullRecord.prediction.status,
          created_at: fullRecord.timestamp,
        };

        const decisionRow = {
          id: decisionId,
          reading_id: fullRecord.id,
          prediction_id: predictionId,
          recommended_fan_count: fullRecord.decision.recommended_fan_count,
          recommended_light_count: fullRecord.decision.recommended_light_count,
          decision_json: fullRecord.decision,
          sensor_data_status: fullRecord.sensor_data_status.message,
          created_at: fullRecord.timestamp,
        };

        const { error: rErr } = await client.from("sensor_readings").insert([readingRow]);
        if (rErr) {
          throw new Error(`Failed to persist sensor_reading to Supabase: ${rErr.message}`);
        }

        await Promise.all([
          Promise.resolve(client.from("predictions").insert([predictionRow])).catch((err: any) => {
            console.warn("[HistoryStore] Async predictions write warning:", err?.message || err);
          }),
          Promise.resolve(client.from("ai_predictions").insert([aiPredRow])).catch((err: any) => {
            console.warn("[HistoryStore] Async ai_predictions write warning:", err?.message || err);
          }),
          Promise.resolve(client.from("ai_decisions").insert([decisionRow])).catch((err: any) => {
            console.warn("[HistoryStore] Async ai_decisions write warning:", err?.message || err);
          }),
        ]);
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
    return this.items.find((item) => item.reading.data_source === "esp32") || null;
  }

  getLatestSimulated(): HistoryRecord | null {
    return this.items.find((item) => item.reading.data_source === "simulated") || null;
  }

  getSensorHealth(): SensorHealthStatus {
    const physicalItems = this.items.filter((item) => item.reading.data_source === "esp32");
    const simulatedItems = this.items.filter((item) => item.reading.data_source === "simulated");
    const latestItem = this.items[0] || null;
    const latestPhysical = physicalItems[0] || null;
    const latestSimulated = simulatedItems[0] || null;

    const totalPhysical = physicalItems.length;
    const totalSimulated = simulatedItems.length;

    if (!latestPhysical) {
      if (totalSimulated > 0) {
        return {
          backendStatus: "online",
          physicalSensorConnected: false,
          status: "simulated_only",
          statusText: "Sensors Disconnected · Showing SIMULATED DATA only",
          lastPhysicalReadingTime: null,
          physicalAgeSeconds: null,
          totalPhysicalReadings: 0,
          totalSimulatedReadings: totalSimulated,
          totalRecords: this.items.length,
          latestDataSource: latestItem ? latestItem.reading.data_source || "unknown" : null,
          latestPhysicalReading: null,
          latestSimulatedReading: latestSimulated,
          latestRecord: latestItem,
          configuredDeviceId: this.configuredDeviceId,
          lastValidPacketTime: null,
          staleThresholdSeconds: this.staleThresholdSeconds,
          sensorErrors: this.sensorErrors.slice(0, 10),
        };
      }
      return {
        backendStatus: "online",
        physicalSensorConnected: false,
        status: "disconnected",
        statusText: "Awaiting ESP32 · No live physical data available",
        lastPhysicalReadingTime: null,
        physicalAgeSeconds: null,
        totalPhysicalReadings: 0,
        totalSimulatedReadings: 0,
        totalRecords: this.items.length,
        latestDataSource: null,
        latestPhysicalReading: null,
        latestSimulatedReading: null,
        latestRecord: null,
        configuredDeviceId: this.configuredDeviceId,
        lastValidPacketTime: null,
        staleThresholdSeconds: this.staleThresholdSeconds,
        sensorErrors: this.sensorErrors.slice(0, 10),
      };
    }

    const ageMs = Date.now() - new Date(latestPhysical.timestamp).getTime();
    const physicalAgeSeconds = Math.max(0, Math.round(ageMs / 1000));
    const isLive = ageMs <= this.staleThresholdSeconds * 1000;

    return {
      backendStatus: "online",
      physicalSensorConnected: isLive,
      status: isLive ? "live" : "stale",
      statusText: isLive
        ? "Physical ESP32 Sensor Connected · Live Data"
        : `Physical ESP32 Sensor Stale (Last reported ${physicalAgeSeconds}s ago)`,
      lastPhysicalReadingTime: latestPhysical.timestamp,
      physicalAgeSeconds,
      totalPhysicalReadings: totalPhysical,
      totalSimulatedReadings: totalSimulated,
      totalRecords: this.items.length,
      latestDataSource: latestItem ? latestItem.reading.data_source || "unknown" : null,
      latestPhysicalReading: latestPhysical,
      latestSimulatedReading: latestSimulated,
      latestRecord: latestItem,
      configuredDeviceId: this.configuredDeviceId,
      lastValidPacketTime: latestPhysical.timestamp,
      staleThresholdSeconds: this.staleThresholdSeconds,
      sensorErrors: this.sensorErrors.slice(0, 10),
    };
  }

  count(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.recordSensorEvent("History memory reset. Awaiting ESP32 hardware connection.", "info");
  }
}

export const history = new DemoHistoryStore();
