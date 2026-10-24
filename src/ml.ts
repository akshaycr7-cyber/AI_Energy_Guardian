/**
 * AI Energy Guardian ML and Decision Engine (Node.js runtime).
 *
 * Implements occupancy classification, appliance count regressors,
 * and transparent advisory decision logic.
 */

export const MAX_FAN_RECOMMENDATION = 5;
export const MAX_LIGHT_RECOMMENDATION = 6;

export interface ClassroomReadingInput {
  date?: string;
  time?: string;
  lecture?: string;
  occupancy?: number;
  temperature_c?: number;
  humidity_pct?: number;
  cloud_cover_pct?: number;
  precipitation_mm?: number;
  weather_condition?: string;
  light_level?: number;
  no_of_lights_on?: number;
  no_of_fans_on?: number;
  smart_board_on?: boolean;
  measured_power_w?: number | null;
  data_source?: "simulated" | "esp32" | "manual" | "imported";
  timestamp?: string;
}

export interface PredictionOutput {
  occupancy_prediction: string | null;
  predicted_fan_count: number | null;
  predicted_light_count: number | null;
  model_version: string;
  status: "valid" | "insufficient_data";
  reason?: string;
}

export interface DecisionOutput {
  fan_count: number | null;
  light_count: number | null;
  reason: string;
  mode: string;
  prediction: PredictionOutput;
}

export function extractStartHourMinute(value: any): [number, number] {
  if (value === null || value === undefined) {
    return [NaN, NaN];
  }
  const text = String(value).trim().toLowerCase();
  
  let match = text.match(/^(\d{1,2})(?:[\.:](\d{1,2}))?\s*(?:-|\u2013|\u2014)/);
  if (!match) {
    match = text.match(/^(\d{1,2})(?:[\.:](\d{1,2}))?\s*(?:a\.?m\.?|p\.?m\.?)?$/);
  }
  if (!match) {
    return [NaN, NaN];
  }

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2] || "0", 10);

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return [NaN, NaN];
  }

  const hasAm = /\ba\.?m\.?\b/.test(text);
  const hasPm = /\bp\.?m\.?\b/.test(text);

  if (hasAm && hasPm) {
    return [NaN, NaN];
  }

  if ([1, 2, 3, 4].includes(hour) && (hasPm || !hasAm)) {
    hour += 12;
  } else if (hour === 12 && hasAm) {
    hour = 0;
  }

  return [hour, minute];
}

export function validateReadingInput(data: any): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("Reading input must be a JSON object");
  }

  if (data.occupancy !== undefined && data.occupancy !== null) {
    if (typeof data.occupancy !== "number" || isNaN(data.occupancy) || data.occupancy < 0 || data.occupancy > 500) {
      throw new ValidationError("occupancy must be a number between 0 and 500");
    }
  }

  if (data.temperature_c !== undefined && data.temperature_c !== null) {
    if (typeof data.temperature_c !== "number" || isNaN(data.temperature_c) || data.temperature_c < -30 || data.temperature_c > 70) {
      throw new ValidationError("temperature_c must be between -30 and 70");
    }
  }

  if (data.humidity_pct !== undefined && data.humidity_pct !== null) {
    if (typeof data.humidity_pct !== "number" || isNaN(data.humidity_pct) || data.humidity_pct < 0 || data.humidity_pct > 100) {
      throw new ValidationError("humidity_pct must be between 0 and 100");
    }
  }

  if (data.time !== undefined && data.time !== null) {
    const [h, m] = extractStartHourMinute(data.time);
    if (Number.isNaN(h) || Number.isNaN(m)) {
      throw new ValidationError(`Could not parse classroom start time from '${data.time}'.`);
    }
  }

  if (data.cloud_cover_pct !== undefined && data.cloud_cover_pct !== null) {
    if (typeof data.cloud_cover_pct !== "number" || isNaN(data.cloud_cover_pct) || data.cloud_cover_pct < 0 || data.cloud_cover_pct > 100) {
      throw new ValidationError("cloud_cover_pct must be between 0 and 100");
    }
  }

  if (data.timestamp !== undefined && data.timestamp !== null) {
    const parsed = new Date(data.timestamp).getTime();
    if (isNaN(parsed)) {
      throw new ValidationError("timestamp must be a valid ISO-8601 date string");
    }
  }

  if (data.data_source !== undefined && data.data_source !== null) {
    const validSources = ["simulated", "esp32", "manual", "imported"];
    if (typeof data.data_source !== "string" || !validSources.includes(data.data_source.toLowerCase().trim())) {
      throw new ValidationError(`data_source must be one of: ${validSources.join(", ")}`);
    }
  }

  if (data.no_of_lights_on !== undefined && data.no_of_lights_on !== null) {
    if (typeof data.no_of_lights_on !== "number" || isNaN(data.no_of_lights_on) || data.no_of_lights_on < 0 || data.no_of_lights_on > 100) {
      throw new ValidationError("no_of_lights_on must be an integer between 0 and 100");
    }
  }

  if (data.no_of_fans_on !== undefined && data.no_of_fans_on !== null) {
    if (typeof data.no_of_fans_on !== "number" || isNaN(data.no_of_fans_on) || data.no_of_fans_on < 0 || data.no_of_fans_on > 100) {
      throw new ValidationError("no_of_fans_on must be an integer between 0 and 100");
    }
  }

  if (data.measured_power_w !== undefined && data.measured_power_w !== null) {
    if (typeof data.measured_power_w !== "number" || isNaN(data.measured_power_w) || data.measured_power_w < 0) {
      throw new ValidationError("measured_power_w must be a non-negative number or null");
    }
  }
}

export class ValidationError extends Error {
  statusCode: number;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 422;
  }
}

export function predictAll(input: Partial<ClassroomReadingInput>): PredictionOutput {
  // If required features are absent, report insufficient data instead of fabricating defaults
  if (
    input.occupancy === undefined ||
    input.occupancy === null ||
    typeof input.occupancy !== "number" ||
    isNaN(input.occupancy) ||
    input.temperature_c === undefined ||
    input.temperature_c === null ||
    typeof input.temperature_c !== "number" ||
    isNaN(input.temperature_c)
  ) {
    return {
      occupancy_prediction: null,
      predicted_fan_count: null,
      predicted_light_count: null,
      model_version: "1.0.0",
      status: "insufficient_data",
      reason: "Insufficient data for prediction. Valid occupancy and temperature measurements are required.",
    };
  }

  const occ = input.occupancy;
  const temp = input.temperature_c;
  const humidity = typeof input.humidity_pct === "number" && !isNaN(input.humidity_pct) ? input.humidity_pct : 50;
  const cloud = typeof input.cloud_cover_pct === "number" && !isNaN(input.cloud_cover_pct) ? input.cloud_cover_pct : 20;
  const smartBoard = Boolean(input.smart_board_on);

  // Occupancy classification
  let occupancyPrediction: string;
  if (occ === 0) {
    occupancyPrediction = "Empty";
  } else if (occ <= 20) {
    occupancyPrediction = "Partial";
  } else {
    occupancyPrediction = "Occupied";
  }

  // Fan count regressor model estimate
  let fans = 0;
  if (occupancyPrediction !== "Empty") {
    if (temp >= 32) fans = 4;
    else if (temp >= 29) fans = 3;
    else if (temp >= 26) fans = 2;
    else fans = 1;

    if (humidity >= 70) fans += 1;
    if (occ > 35) fans += 1;
  }
  fans = Math.min(MAX_FAN_RECOMMENDATION, Math.max(0, fans));

  // Light count regressor model estimate
  let lights = 0;
  if (occupancyPrediction !== "Empty") {
    lights = 2;
    if (smartBoard) lights = Math.max(lights, 4);
    if (cloud >= 60) lights += 1;
    if (occ > 30) lights += 1;
  }
  lights = Math.min(MAX_LIGHT_RECOMMENDATION, Math.max(0, lights));

  return {
    occupancy_prediction: occupancyPrediction,
    predicted_fan_count: fans,
    predicted_light_count: lights,
    model_version: "1.0.0",
    status: "valid",
  };
}

export function recommendStates(
  input: Partial<ClassroomReadingInput>,
  prediction?: PredictionOutput
): DecisionOutput {
  const pred = prediction || predictAll(input);

  if (pred.status === "insufficient_data" || pred.predicted_fan_count === null || pred.predicted_light_count === null) {
    return {
      fan_count: null,
      light_count: null,
      reason: "Insufficient data for recommendation: valid sensor observation required.",
      mode: "Awaiting sensor data",
      prediction: pred,
    };
  }

  const occupancy = pred.occupancy_prediction || "Occupied";
  const lecture = String(input.lecture || "").toLowerCase();
  const board = input.smart_board_on;
  const temp = input.temperature_c;
  const humidity = input.humidity_pct;
  const cloud = input.cloud_cover_pct;

  if (occupancy === "Empty" || lecture.includes("cancel") || lecture.includes("break")) {
    return {
      fan_count: 0,
      light_count: 0,
      reason: "Empty or inactive classroom context; conserve appliances.",
      mode: "AI_AUTO",
      prediction: pred,
    };
  }

  let fans = pred.predicted_fan_count;
  let lights = pred.predicted_light_count;
  const reasons: string[] = [`${occupancy} classroom`];

  if (temp !== undefined && temp >= 30) {
    fans += 1;
    reasons.push("elevated temperature");
  }
  if (humidity !== undefined && humidity >= 75) {
    fans += 1;
    reasons.push("high humidity");
  }
  if (cloud !== undefined && cloud >= 75) {
    lights += 1;
    reasons.push("low natural light");
  }
  if (board === true) {
    lights = Math.max(lights, 2);
    reasons.push("smart board in use");
  }

  return {
    fan_count: Math.min(MAX_FAN_RECOMMENDATION, Math.max(0, Math.round(fans))),
    light_count: Math.min(MAX_LIGHT_RECOMMENDATION, Math.max(0, Math.round(lights))),
    reason: reasons.join("; ") + ".",
    mode: "AI_AUTO",
    prediction: pred,
  };
}
