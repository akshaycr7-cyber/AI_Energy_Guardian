import { ClassroomReadingInput, predictAll, recommendStates } from "./ml.js";
import { history, sensorDataStatus, HistoryRecord } from "./history.js";

const lectures = ["EM", "SOM", "BSE", "UHV"];
const weatherTypes = ["Clear", "Cloudy", "Rainy"];

let simulatorIntervalTimer: NodeJS.Timeout | null = null;
let continuousSimulatorActive = false;

export function generateReading(): ClassroomReadingInput {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const displayHour = hours % 12 || 12;
  const suffix = hours >= 12 ? "pm" : "am";
  const weather = weatherTypes[Math.floor(Math.random() * weatherTypes.length)];

  return {
    timestamp: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    time: `${displayHour}:${minutes.toString().padStart(2, "0")} ${suffix}`,
    lecture: lectures[Math.floor(Math.random() * lectures.length)],
    occupancy: Math.floor(Math.random() * 45) + 10,
    temperature_c: Math.round((23 + Math.random() * 10) * 10) / 10,
    humidity_pct: Math.round((45 + Math.random() * 40) * 10) / 10,
    cloud_cover_pct: Math.floor(Math.random() * 100),
    precipitation_mm: weather === "Rainy" ? Math.round(Math.random() * 4 * 10) / 10 : 0.0,
    weather_condition: weather,
    light_level: Math.round(150 + Math.random() * 500),
    no_of_lights_on: Math.floor(Math.random() * 6),
    no_of_fans_on: Math.floor(Math.random() * 5),
    smart_board_on: Math.random() > 0.5,
    measured_power_w: null,
    data_source: "simulated",
  };
}

export function evaluateAndStoreReading(reading: ClassroomReadingInput, deviceId?: string): HistoryRecord {
  const prediction = predictAll(reading);
  const decision = recommendStates(reading, prediction);
  const evaluatedAt = new Date().toISOString();
  const effectiveTimestamp = reading.timestamp || evaluatedAt;

  const record: Omit<HistoryRecord, "id"> = {
    timestamp: effectiveTimestamp,
    evaluated_at: evaluatedAt,
    reading: {
      ...reading,
      timestamp: effectiveTimestamp,
    },
    prediction,
    decision: {
      recommended_fan_count: decision.fan_count,
      recommended_light_count: decision.light_count,
      reason: decision.reason,
      ai_mode: decision.mode,
      hardware_control_enabled: false,
    },
    sensor_data_status: sensorDataStatus(reading.data_source || "simulated", deviceId),
    power_status: "unavailable: no physical power meter hardware connected",
  };

  const id = history.add(record);
  return { id, ...record };
}

export async function evaluateAndStoreReadingAsync(reading: ClassroomReadingInput, deviceId?: string): Promise<HistoryRecord> {
  const prediction = predictAll(reading);
  const decision = recommendStates(reading, prediction);
  const evaluatedAt = new Date().toISOString();
  const effectiveTimestamp = reading.timestamp || evaluatedAt;

  const record: Omit<HistoryRecord, "id"> = {
    timestamp: effectiveTimestamp,
    evaluated_at: evaluatedAt,
    reading: {
      ...reading,
      timestamp: effectiveTimestamp,
    },
    prediction,
    decision: {
      recommended_fan_count: decision.fan_count,
      recommended_light_count: decision.light_count,
      reason: decision.reason,
      ai_mode: decision.mode,
      hardware_control_enabled: false,
    },
    sensor_data_status: sensorDataStatus(reading.data_source || "simulated", deviceId),
    power_status: "unavailable: no physical power meter hardware connected",
  };

  return await history.addAsync(record);
}

export function runSimulatorStep(): HistoryRecord {
  const reading = generateReading();
  return evaluateAndStoreReading(reading);
}

export function getSimulatorStatus() {
  return {
    active: continuousSimulatorActive,
    totalSimulated: history.getSensorHealth().totalSimulatedReadings,
    sampleIntervalMs: 15000,
  };
}

export function setContinuousSimulator(enabled: boolean, intervalMs = 15000) {
  if (enabled && !continuousSimulatorActive) {
    continuousSimulatorActive = true;
    history.setSimulatorStreamActive(true);
    simulatorIntervalTimer = setInterval(() => {
      try {
        runSimulatorStep();
      } catch (err) {
        console.warn("Continuous simulator error:", err);
      }
    }, intervalMs);
  } else if (!enabled && continuousSimulatorActive) {
    if (simulatorIntervalTimer) {
      clearInterval(simulatorIntervalTimer);
      simulatorIntervalTimer = null;
    }
    continuousSimulatorActive = false;
    history.setSimulatorStreamActive(false);
  } else {
    history.setSimulatorStreamActive(continuousSimulatorActive);
  }
  return getSimulatorStatus();
}

export function startBackgroundSimulator(intervalMs = 30000) {
  return setContinuousSimulator(true, intervalMs);
}
