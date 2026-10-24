/**
 * AI Energy Guardian - Power & Energy Calculation Engine
 *
 * Implements three clearly separated energy models:
 * 1. Prototype Energy Report: Bench-scale hardware testbed (Mini fan, LED light, configurable LCD).
 * 2. Classroom Simulation Report: Full academic facility projection (5x75W fans, 8x28W lights, 150W smart board = 749W baseline).
 * 3. Physical Energy Report: Future physical CT clamp power meter telemetry (strictly honest disconnected status).
 *
 * Strict Data Provenance Rules:
 * - Prototype results are labeled as ESTIMATES.
 * - Classroom results are labeled as SIMULATED / PROJECTED (never "measured" or "actual").
 * - Physical report returns "Physical meter not connected — actual energy measurements unavailable."
 *   with null measurements whenever hardware is offline.
 * - Prototype and Classroom configurations are strictly independent.
 * - The prototype LCD display is user-configurable and NEVER assumed to consume 150W (150W belongs solely to the smart board).
 * - Connected load is calculated dynamically from current quantities and ratings (default: 749W).
 */

// ============================================================================
// 1. PROTOTYPE CONFIGURATION & MODEL
// ============================================================================

export interface PrototypeConfig {
  mini_fan_qty: number; // default: 1
  mini_fan_watts: number; // default: 5 W
  led_light_qty: number; // default: 1
  led_light_watts: number; // default: 2 W
  lcd_display_qty: number; // default: 1
  lcd_display_watts: number; // default: 2.5 W (user-configurable; strictly NEVER 150 W)
  operating_hours_per_day: number; // default: 8 hours
  operating_days_per_month: number; // default: 22 days
  electricity_rate_per_kwh: number; // default: 8.5 (₹/kWh)
  currency_symbol: string; // default: "₹"
}

export const defaultPrototypeConfig: PrototypeConfig = {
  mini_fan_qty: 1,
  mini_fan_watts: 5,
  led_light_qty: 1,
  led_light_watts: 2,
  lcd_display_qty: 1,
  lcd_display_watts: 2.5, // strictly never 150 W
  operating_hours_per_day: 8,
  operating_days_per_month: 22,
  electricity_rate_per_kwh: 8.5,
  currency_symbol: "₹",
};

let currentPrototypeConfig: PrototypeConfig = { ...defaultPrototypeConfig };

export function getPrototypeConfig(): PrototypeConfig {
  return { ...currentPrototypeConfig };
}

export function updatePrototypeConfig(partial: Partial<PrototypeConfig>): PrototypeConfig {
  if (partial.mini_fan_qty !== undefined && typeof partial.mini_fan_qty === "number" && partial.mini_fan_qty >= 0) {
    currentPrototypeConfig.mini_fan_qty = Math.round(partial.mini_fan_qty);
  }
  if (partial.mini_fan_watts !== undefined && typeof partial.mini_fan_watts === "number" && partial.mini_fan_watts > 0) {
    currentPrototypeConfig.mini_fan_watts = Math.round(partial.mini_fan_watts * 10) / 10;
  }
  if (partial.led_light_qty !== undefined && typeof partial.led_light_qty === "number" && partial.led_light_qty >= 0) {
    currentPrototypeConfig.led_light_qty = Math.round(partial.led_light_qty);
  }
  if (partial.led_light_watts !== undefined && typeof partial.led_light_watts === "number" && partial.led_light_watts > 0) {
    currentPrototypeConfig.led_light_watts = Math.round(partial.led_light_watts * 10) / 10;
  }
  if (partial.lcd_display_qty !== undefined && typeof partial.lcd_display_qty === "number" && partial.lcd_display_qty >= 0) {
    currentPrototypeConfig.lcd_display_qty = Math.round(partial.lcd_display_qty);
  }
  if (partial.lcd_display_watts !== undefined && typeof partial.lcd_display_watts === "number" && partial.lcd_display_watts >= 0) {
    currentPrototypeConfig.lcd_display_watts = Math.round(partial.lcd_display_watts * 10) / 10;
  }
  if (partial.operating_hours_per_day !== undefined && typeof partial.operating_hours_per_day === "number" && partial.operating_hours_per_day > 0) {
    currentPrototypeConfig.operating_hours_per_day = Math.min(24, Math.max(1, partial.operating_hours_per_day));
  }
  if (partial.operating_days_per_month !== undefined && typeof partial.operating_days_per_month === "number" && partial.operating_days_per_month > 0) {
    currentPrototypeConfig.operating_days_per_month = Math.min(31, Math.max(1, Math.round(partial.operating_days_per_month)));
  }
  if (partial.electricity_rate_per_kwh !== undefined && typeof partial.electricity_rate_per_kwh === "number" && partial.electricity_rate_per_kwh >= 0) {
    currentPrototypeConfig.electricity_rate_per_kwh = Math.round(partial.electricity_rate_per_kwh * 100) / 100;
  }
  if (partial.currency_symbol !== undefined && typeof partial.currency_symbol === "string") {
    currentPrototypeConfig.currency_symbol = partial.currency_symbol.trim() || "₹";
  }
  return { ...currentPrototypeConfig };
}

export interface PrototypeDeviceStateInput {
  mini_fan_on?: boolean | null;
  led_light_on?: boolean | null;
  lcd_display_on?: boolean | null;
}

export interface PrototypeEnergyReport {
  report_type: "prototype_energy_report";
  status: "ESTIMATED";
  label: "ESTIMATED (PROTOTYPE BENCH)";
  data_source: "Hardware Prototype Testbed";
  timestamp: string;
  configuration: PrototypeConfig;
  total_connected_load_w: number;
  baseline_power_w: number;
  active_power_w: number;
  power_saved_w: number;
  savings_percentage: number;
  daily_energy_consumption_kwh: number;
  daily_energy_saved_kwh: number;
  monthly_energy_saved_kwh: number;
  daily_cost_saved: number;
  monthly_cost_saved: number;
  device_states: {
    mini_fan_on: boolean;
    led_light_on: boolean;
    lcd_display_on: boolean;
  };
  calculation_method: "power_x_operating_duration";
  provenance_note: string;
}

export function calculatePrototypeEnergyReport(
  deviceStates?: PrototypeDeviceStateInput,
  config: PrototypeConfig = currentPrototypeConfig
): PrototypeEnergyReport {
  // Connected load when all prototype bench devices are active
  const totalConnectedLoadW =
    config.mini_fan_qty * config.mini_fan_watts +
    config.led_light_qty * config.led_light_watts +
    config.lcd_display_qty * config.lcd_display_watts;

  const baselinePowerW = totalConnectedLoadW;

  const miniFanOn = deviceStates?.mini_fan_on !== undefined && deviceStates.mini_fan_on !== null
    ? Boolean(deviceStates.mini_fan_on)
    : false;
  const ledLightOn = deviceStates?.led_light_on !== undefined && deviceStates.led_light_on !== null
    ? Boolean(deviceStates.led_light_on)
    : false;
  const lcdDisplayOn = deviceStates?.lcd_display_on !== undefined && deviceStates.lcd_display_on !== null
    ? Boolean(deviceStates.lcd_display_on)
    : true; // Display typically powers status UI

  const activePowerW =
    (miniFanOn ? config.mini_fan_qty * config.mini_fan_watts : 0) +
    (ledLightOn ? config.led_light_qty * config.led_light_watts : 0) +
    (lcdDisplayOn ? config.lcd_display_qty * config.lcd_display_watts : 0);

  const powerSavedW = Math.max(0, baselinePowerW - activePowerW);
  const savingsPct = baselinePowerW > 0 ? Math.round((powerSavedW / baselinePowerW) * 1000) / 10 : 0;

  // Energy consumption (kWh) = Power (W) * Hours / 1000
  const dailyConsumptionKwh = Math.round(((activePowerW * config.operating_hours_per_day) / 1000) * 1000) / 1000;
  const dailyEnergySavedKwh = Math.round(((powerSavedW * config.operating_hours_per_day) / 1000) * 1000) / 1000;
  const monthlyEnergySavedKwh = Math.round((dailyEnergySavedKwh * config.operating_days_per_month) * 100) / 100;

  const dailyCostSaved = Math.round((dailyEnergySavedKwh * config.electricity_rate_per_kwh) * 100) / 100;
  const monthlyCostSaved = Math.round((monthlyEnergySavedKwh * config.electricity_rate_per_kwh) * 100) / 100;

  return {
    report_type: "prototype_energy_report",
    status: "ESTIMATED",
    label: "ESTIMATED (PROTOTYPE BENCH)",
    data_source: "Hardware Prototype Testbed",
    timestamp: new Date().toISOString(),
    configuration: { ...config },
    total_connected_load_w: Math.round(totalConnectedLoadW * 10) / 10,
    baseline_power_w: Math.round(baselinePowerW * 10) / 10,
    active_power_w: Math.round(activePowerW * 10) / 10,
    power_saved_w: Math.round(powerSavedW * 10) / 10,
    savings_percentage: savingsPct,
    daily_energy_consumption_kwh: dailyConsumptionKwh,
    daily_energy_saved_kwh: dailyEnergySavedKwh,
    monthly_energy_saved_kwh: monthlyEnergySavedKwh,
    daily_cost_saved: dailyCostSaved,
    monthly_cost_saved: monthlyCostSaved,
    device_states: {
      mini_fan_on: miniFanOn,
      led_light_on: ledLightOn,
      lcd_display_on: lcdDisplayOn,
    },
    calculation_method: "power_x_operating_duration",
    provenance_note:
      "Estimated prototype calculations based on bench-scale mini fan, LED, and LCD ratings. Labeled as estimates unless actual electrical measurements are available.",
  };
}

// ============================================================================
// 2. CLASSROOM SIMULATION CONFIGURATION & POLICY MODEL
// ============================================================================

export interface ClassroomConfig {
  fans_qty: number; // default: 5
  fan_watts: number; // default: 75 W
  lights_qty: number; // default: 8
  light_watts: number; // default: 28 W
  smart_board_qty: number; // default: 1
  smart_board_watts: number; // default: 150 W
  operating_hours_per_day: number; // default: 8 hours
  operating_days_per_month: number; // default: 22 academic days
  electricity_rate_per_kwh: number; // default: 8.5 (₹/kWh)
  currency_symbol: string; // default: "₹"
}

export const defaultClassroomConfig: ClassroomConfig = {
  fans_qty: 5,
  fan_watts: 75,
  lights_qty: 8,
  light_watts: 28,
  smart_board_qty: 1,
  smart_board_watts: 150,
  operating_hours_per_day: 8,
  operating_days_per_month: 22,
  electricity_rate_per_kwh: 8.5,
  currency_symbol: "₹",
};

let currentClassroomConfig: ClassroomConfig = { ...defaultClassroomConfig };

export function getClassroomConfig(): ClassroomConfig {
  return { ...currentClassroomConfig };
}

/**
 * Calculates connected load dynamically from current quantities and ratings.
 * Default: (5 * 75) + (8 * 28) + (1 * 150) = 375 + 224 + 150 = 749 W.
 */
export function calculateClassroomConnectedLoad(config: ClassroomConfig = currentClassroomConfig): number {
  return (
    config.fans_qty * config.fan_watts +
    config.lights_qty * config.light_watts +
    config.smart_board_qty * config.smart_board_watts
  );
}

export function updateClassroomConfig(partial: Partial<ClassroomConfig>): ClassroomConfig {
  if (partial.fans_qty !== undefined && typeof partial.fans_qty === "number" && partial.fans_qty >= 0) {
    currentClassroomConfig.fans_qty = Math.round(partial.fans_qty);
  }
  if (partial.fan_watts !== undefined && typeof partial.fan_watts === "number" && partial.fan_watts > 0) {
    currentClassroomConfig.fan_watts = Math.round(partial.fan_watts * 10) / 10;
  }
  if (partial.lights_qty !== undefined && typeof partial.lights_qty === "number" && partial.lights_qty >= 0) {
    currentClassroomConfig.lights_qty = Math.round(partial.lights_qty);
  }
  if (partial.light_watts !== undefined && typeof partial.light_watts === "number" && partial.light_watts > 0) {
    currentClassroomConfig.light_watts = Math.round(partial.light_watts * 10) / 10;
  }
  if (partial.smart_board_qty !== undefined && typeof partial.smart_board_qty === "number" && partial.smart_board_qty >= 0) {
    currentClassroomConfig.smart_board_qty = Math.round(partial.smart_board_qty);
  }
  if (partial.smart_board_watts !== undefined && typeof partial.smart_board_watts === "number" && partial.smart_board_watts >= 0) {
    currentClassroomConfig.smart_board_watts = Math.round(partial.smart_board_watts * 10) / 10;
  }
  if (partial.operating_hours_per_day !== undefined && typeof partial.operating_hours_per_day === "number" && partial.operating_hours_per_day > 0) {
    currentClassroomConfig.operating_hours_per_day = Math.min(24, Math.max(1, partial.operating_hours_per_day));
  }
  if (partial.operating_days_per_month !== undefined && typeof partial.operating_days_per_month === "number" && partial.operating_days_per_month > 0) {
    currentClassroomConfig.operating_days_per_month = Math.min(31, Math.max(1, Math.round(partial.operating_days_per_month)));
  }
  if (partial.electricity_rate_per_kwh !== undefined && typeof partial.electricity_rate_per_kwh === "number" && partial.electricity_rate_per_kwh >= 0) {
    currentClassroomConfig.electricity_rate_per_kwh = Math.round(partial.electricity_rate_per_kwh * 100) / 100;
  }
  if (partial.currency_symbol !== undefined && typeof partial.currency_symbol === "string") {
    currentClassroomConfig.currency_symbol = partial.currency_symbol.trim() || "₹";
  }
  return { ...currentClassroomConfig };
}

// ----------------------------------------------------------------------------
// Classroom Simulation Policy Engine
// ----------------------------------------------------------------------------

export interface ClassroomSimulationPolicyInput {
  occupancy?: number | null;
  temperature_c?: number | null;
  humidity_pct?: number | null;
  ambient_light_lux?: number | null;
  smart_board_on?: boolean | null;
  actual_fans_on?: number | null;
  actual_lights_on?: number | null;
}

export interface ClassroomSimulationPolicyDecision {
  recommended_fans: number;
  recommended_lights: number;
  policy_name: string;
  rules_applied: string[];
  reason: string;
  fan_reasoning: string;
  light_reasoning: string;
}

/**
 * Explicit, configurable rule-based classroom simulation policy.
 *
 * POLICY DOCUMENTATION:
 * 1. Occupancy Zero Rule:
 *    When occupancy is 0 (classroom empty), all fans and lights are recommended OFF (0).
 *
 * 2. Classroom Fan Policy (when occupied):
 *    - Governed by temperature (thermal comfort) and occupant count:
 *      * High Temperature (T >= 30°C): All fans active (100% of fans_qty) to mitigate heat stress.
 *      * Moderate Warmth (26°C <= T < 30°C):
 *          - High occupancy (> 25): 80% of fans (e.g. 4 fans).
 *          - Medium occupancy (10-25): 60% of fans (e.g. 3 fans).
 *          - Low occupancy (< 10): 40% of fans (e.g. 2 fans).
 *      * Mild Comfort (22°C <= T < 26°C):
 *          - Occupancy > 20: 40% of fans (e.g. 2 fans).
 *          - Occupancy <= 20: 20% of fans (e.g. 1 fan).
 *      * Cool Conditions (T < 22°C):
 *          - Occupancy > 30: 1 fan for air circulation.
 *          - Else: 0 fans.
 *
 * 3. Classroom Light Policy (when occupied):
 *    - Governed by ambient light, smart board presentation mode, and occupant count:
 *      * Smart Board Active: Front lights should be dimmed/switched off to eliminate screen glare
 *        and enhance contrast for presentation visibility (caps active lights to ~50% of lights_qty).
 *      * High Ambient Daylight (lux >= 500): Natural lighting suffices; only 25% of lights (e.g. 2 lights).
 *      * Moderate Daylight (300 <= lux < 500): 50% of lights (e.g. 4 lights).
 *      * Low Ambient Light (lux < 300 or cloudy/evening):
 *          - If smart board is active: 50% of lights (e.g. 4 lights).
 *          - If smart board is off and occupancy > 20: 100% of lights (e.g. 8 lights).
 *          - If smart board is off and occupancy <= 20: 75% of lights (e.g. 6 lights).
 */
export function evaluateClassroomSimulationPolicy(
  input: ClassroomSimulationPolicyInput,
  config: ClassroomConfig = currentClassroomConfig
): ClassroomSimulationPolicyDecision {
  const occ = input.occupancy !== undefined && input.occupancy !== null ? Math.max(0, input.occupancy) : 0;
  const temp = input.temperature_c !== undefined && input.temperature_c !== null ? input.temperature_c : 25;
  const smartBoard = Boolean(input.smart_board_on);
  const lux = input.ambient_light_lux !== undefined && input.ambient_light_lux !== null ? input.ambient_light_lux : 350;

  const rules: string[] = [];

  // 1. Zero Occupancy Override
  if (occ === 0) {
    rules.push("ZERO_OCCUPANCY_IDLE_CONSERVATION");
    return {
      recommended_fans: 0,
      recommended_lights: 0,
      policy_name: "Classroom Idle Energy Conservation Policy",
      rules_applied: rules,
      reason: "Classroom is unoccupied; 0 fans and 0 lights recommended to eliminate standby electrical waste.",
      fan_reasoning: "0 fans: room unoccupied.",
      light_reasoning: "0 lights: room unoccupied.",
    };
  }

  // 2. Fan Policy
  let recFans = 0;
  let fanReason = "";

  if (temp >= 30) {
    recFans = config.fans_qty;
    rules.push("FAN_HEAT_STRESS_MAXIMUM");
    fanReason = `All ${config.fans_qty} fans recommended due to elevated temperature (${temp.toFixed(1)}°C >= 30°C).`;
  } else if (temp >= 26) {
    if (occ > 25) {
      recFans = Math.min(config.fans_qty, Math.max(1, Math.round(config.fans_qty * 0.8)));
      rules.push("FAN_WARM_HIGH_OCCUPANCY");
      fanReason = `${recFans} fans recommended for warm room (${temp.toFixed(1)}°C) with dense occupancy (${occ} persons).`;
    } else if (occ >= 10) {
      recFans = Math.min(config.fans_qty, Math.max(1, Math.round(config.fans_qty * 0.6)));
      rules.push("FAN_WARM_MEDIUM_OCCUPANCY");
      fanReason = `${recFans} fans recommended for warm room (${temp.toFixed(1)}°C) with moderate occupancy (${occ} persons).`;
    } else {
      recFans = Math.min(config.fans_qty, Math.max(1, Math.round(config.fans_qty * 0.4)));
      rules.push("FAN_WARM_LOW_OCCUPANCY");
      fanReason = `${recFans} fans recommended for warm room (${temp.toFixed(1)}°C) with low occupancy (${occ} persons).`;
    }
  } else if (temp >= 22) {
    if (occ > 20) {
      recFans = Math.min(config.fans_qty, Math.max(1, Math.round(config.fans_qty * 0.4)));
      rules.push("FAN_MILD_HIGH_OCCUPANCY");
      fanReason = `${recFans} fans recommended for mild room (${temp.toFixed(1)}°C) with high occupancy (${occ} persons).`;
    } else {
      recFans = Math.min(config.fans_qty, Math.max(1, Math.round(config.fans_qty * 0.2)));
      rules.push("FAN_MILD_LOW_OCCUPANCY");
      fanReason = `${recFans} fan recommended for mild room (${temp.toFixed(1)}°C) with light occupancy (${occ} persons).`;
    }
  } else {
    if (occ > 30) {
      recFans = 1;
      rules.push("FAN_COOL_MINIMAL_CIRCULATION");
      fanReason = `1 fan recommended for minimal ventilation in cool conditions (${temp.toFixed(1)}°C) with heavy occupancy (${occ} persons).`;
    } else {
      recFans = 0;
      rules.push("FAN_COOL_STANDBY");
      fanReason = `0 fans recommended in cool conditions (${temp.toFixed(1)}°C < 22°C).`;
    }
  }

  // 3. Light Policy
  let recLights = 0;
  let lightReason = "";

  if (smartBoard) {
    rules.push("LIGHT_SMART_BOARD_ANTI_GLARE");
    const glareCap = Math.max(2, Math.floor(config.lights_qty * 0.5));
    recLights = Math.min(glareCap, config.lights_qty);
    lightReason = `Smart board in use: capped at ${recLights} rear/accent lights to prevent presentation screen glare.`;
  } else if (lux >= 500) {
    rules.push("LIGHT_HIGH_NATURAL_DAYLIGHT");
    recLights = Math.max(1, Math.round(config.lights_qty * 0.25));
    lightReason = `Abundant natural daylight (${lux} lux >= 500 lux): ${recLights} perimeter lights recommended.`;
  } else if (lux >= 300) {
    rules.push("LIGHT_MODERATE_DAYLIGHT");
    recLights = Math.max(2, Math.round(config.lights_qty * 0.5));
    lightReason = `Moderate ambient light (${lux} lux): ${recLights} lights recommended for balanced desk illumination.`;
  } else {
    // Low ambient light (< 300 lux)
    if (occ > 20) {
      recLights = config.lights_qty;
      rules.push("LIGHT_LOW_AMBIENT_FULL_CLASS");
      lightReason = `Low ambient lighting (${lux} lux) with ${occ} occupants: all ${config.lights_qty} lights recommended for visual clarity.`;
    } else {
      recLights = Math.max(2, Math.round(config.lights_qty * 0.75));
      rules.push("LIGHT_LOW_AMBIENT_PARTIAL_CLASS");
      lightReason = `Low ambient lighting (${lux} lux) with ${occ} occupants: ${recLights} lights recommended for active seating zone.`;
    }
  }

  // Final bounds protection
  recFans = Math.max(0, Math.min(config.fans_qty, recFans));
  recLights = Math.max(0, Math.min(config.lights_qty, recLights));

  const overallReason = `Classroom Policy: Recommended ${recFans} fans and ${recLights} lights based on ${occ} occupants at ${temp.toFixed(1)}°C (smart board: ${smartBoard ? "ON" : "OFF"}).`;

  return {
    recommended_fans: recFans,
    recommended_lights: recLights,
    policy_name: "Classroom Environmental & Visual Comfort Simulation Policy",
    rules_applied: rules,
    reason: overallReason,
    fan_reasoning: fanReason,
    light_reasoning: lightReason,
  };
}

export interface ClassroomSimulationReport {
  report_type: "classroom_simulation_report";
  status: "SIMULATED";
  label: "SIMULATED / PROJECTED";
  data_source: "Classroom Observation Simulation Policy";
  timestamp: string;
  configuration: ClassroomConfig & { total_connected_load_w: number };
  simulation_policy: ClassroomSimulationPolicyDecision & {
    inputs: ClassroomSimulationPolicyInput;
  };
  baseline_power_w: number;
  projected_optimized_power_w: number;
  projected_power_saved_w: number;
  projected_savings_percentage: number;
  baseline_daily_energy_kwh: number;
  projected_daily_energy_kwh: number;
  projected_daily_energy_saved_kwh: number;
  projected_monthly_energy_saved_kwh: number;
  projected_daily_cost_saved: number;
  projected_monthly_cost_saved: number;
  calculation_method: "rule_based_policy_simulation_x_operating_duration";
  provenance_note: string;
}

export function calculateClassroomSimulationReport(
  input: ClassroomSimulationPolicyInput = {},
  config: ClassroomConfig = currentClassroomConfig
): ClassroomSimulationReport {
  const policyDecision = evaluateClassroomSimulationPolicy(input, config);

  const smartBoardOn = Boolean(input.smart_board_on);

  // Baseline load: unmanaged state where all classroom fans and lights are ON (or reported current count)
  const baselineFans = input.actual_fans_on !== undefined && input.actual_fans_on !== null && input.actual_fans_on > 0
    ? input.actual_fans_on
    : config.fans_qty;
  const baselineLights = input.actual_lights_on !== undefined && input.actual_lights_on !== null && input.actual_lights_on > 0
    ? input.actual_lights_on
    : config.lights_qty;

  const baselinePowerW =
    baselineFans * config.fan_watts +
    baselineLights * config.light_watts +
    (smartBoardOn ? config.smart_board_qty * config.smart_board_watts : 0);

  const optimizedPowerW =
    policyDecision.recommended_fans * config.fan_watts +
    policyDecision.recommended_lights * config.light_watts +
    (smartBoardOn ? config.smart_board_qty * config.smart_board_watts : 0);

  const powerSavedW = Math.max(0, baselinePowerW - optimizedPowerW);
  const savingsPct = baselinePowerW > 0 ? Math.round((powerSavedW / baselinePowerW) * 1000) / 10 : 0;

  // Energy calculations: Power (W) * Hours / 1000
  const baselineDailyEnergyKwh = Math.round(((baselinePowerW * config.operating_hours_per_day) / 1000) * 100) / 100;
  const projectedDailyEnergyKwh = Math.round(((optimizedPowerW * config.operating_hours_per_day) / 1000) * 100) / 100;
  const projectedDailySavedKwh = Math.round(((powerSavedW * config.operating_hours_per_day) / 1000) * 100) / 100;
  const projectedMonthlySavedKwh = Math.round((projectedDailySavedKwh * config.operating_days_per_month) * 100) / 100;

  const projectedDailyCostSaved = Math.round((projectedDailySavedKwh * config.electricity_rate_per_kwh) * 100) / 100;
  const projectedMonthlyCostSaved = Math.round((projectedMonthlySavedKwh * config.electricity_rate_per_kwh) * 100) / 100;

  const totalConnectedLoadW = calculateClassroomConnectedLoad(config);

  return {
    report_type: "classroom_simulation_report",
    status: "SIMULATED",
    label: "SIMULATED / PROJECTED",
    data_source: "Classroom Observation Simulation Policy",
    timestamp: new Date().toISOString(),
    configuration: {
      ...config,
      total_connected_load_w: Math.round(totalConnectedLoadW * 10) / 10,
    },
    simulation_policy: {
      ...policyDecision,
      inputs: { ...input },
    },
    baseline_power_w: Math.round(baselinePowerW * 10) / 10,
    projected_optimized_power_w: Math.round(optimizedPowerW * 10) / 10,
    projected_power_saved_w: Math.round(powerSavedW * 10) / 10,
    projected_savings_percentage: savingsPct,
    baseline_daily_energy_kwh: baselineDailyEnergyKwh,
    projected_daily_energy_kwh: projectedDailyEnergyKwh,
    projected_daily_energy_saved_kwh: projectedDailySavedKwh,
    projected_monthly_energy_saved_kwh: projectedMonthlySavedKwh,
    projected_daily_cost_saved: projectedDailyCostSaved,
    projected_monthly_cost_saved: projectedMonthlyCostSaved,
    calculation_method: "rule_based_policy_simulation_x_operating_duration",
    provenance_note:
      "Classroom figures are strictly SIMULATED or PROJECTED based on policy rules and configured classroom electrical ratings. They are never labeled as measured or actual savings.",
  };
}

// ============================================================================
// 3. PHYSICAL ENERGY REPORT & HARDWARE INTEGRATION MODEL
// ============================================================================

export interface PhysicalMeterConfig {
  baseline_reference_load_w: number; // default: 749 W
  operating_hours_per_day: number; // default: 8
  operating_days_per_month: number; // default: 22
  electricity_rate_per_kwh: number; // default: 8.5
  currency_symbol: string; // default: "₹"
  meter_connected: boolean; // default: false
  meter_device_id: string | null;
}

export const defaultPhysicalMeterConfig: PhysicalMeterConfig = {
  baseline_reference_load_w: 749,
  operating_hours_per_day: 8,
  operating_days_per_month: 22,
  electricity_rate_per_kwh: 8.5,
  currency_symbol: "₹",
  meter_connected: false,
  meter_device_id: null,
};

let currentPhysicalMeterConfig: PhysicalMeterConfig = { ...defaultPhysicalMeterConfig };

export function getPhysicalMeterConfig(): PhysicalMeterConfig {
  return { ...currentPhysicalMeterConfig };
}

export function updatePhysicalMeterConfig(partial: Partial<PhysicalMeterConfig>): PhysicalMeterConfig {
  if (partial.baseline_reference_load_w !== undefined && typeof partial.baseline_reference_load_w === "number") {
    currentPhysicalMeterConfig.baseline_reference_load_w = Math.round(partial.baseline_reference_load_w * 10) / 10;
  }
  if (partial.operating_hours_per_day !== undefined && typeof partial.operating_hours_per_day === "number") {
    currentPhysicalMeterConfig.operating_hours_per_day = Math.min(24, Math.max(1, partial.operating_hours_per_day));
  }
  if (partial.operating_days_per_month !== undefined && typeof partial.operating_days_per_month === "number") {
    currentPhysicalMeterConfig.operating_days_per_month = Math.min(31, Math.max(1, Math.round(partial.operating_days_per_month)));
  }
  if (partial.electricity_rate_per_kwh !== undefined && typeof partial.electricity_rate_per_kwh === "number") {
    currentPhysicalMeterConfig.electricity_rate_per_kwh = Math.round(partial.electricity_rate_per_kwh * 100) / 100;
  }
  if (partial.meter_connected !== undefined && typeof partial.meter_connected === "boolean") {
    currentPhysicalMeterConfig.meter_connected = partial.meter_connected;
  }
  if (partial.meter_device_id !== undefined) {
    currentPhysicalMeterConfig.meter_device_id = partial.meter_device_id;
  }
  return { ...currentPhysicalMeterConfig };
}

export interface PhysicalEnergyReport {
  report_type: "physical_energy_report";
  status: "DISCONNECTED" | "MEASURED";
  label: "PHYSICAL HARDWARE MEASUREMENT";
  data_source: "Classroom Physical Power Meter (CT Clamp)";
  timestamp: string;
  meter_connected: boolean;
  meter_device_id: string | null;
  status_message: string;
  baseline_reference_load_w: number;
  measured_power_w: number | null;
  measured_power_saved_w: number | null;
  measured_savings_percentage: number | null;
  measured_daily_energy_kwh: number | null;
  measured_monthly_energy_kwh: number | null;
  measured_daily_cost_saved: number | null;
  measured_monthly_cost_saved: number | null;
  transparency_note: string;
}

/**
 * Generates the Physical Energy Report.
 * CRITICAL RULE: When physical power meter readings are unavailable, it MUST report:
 * "Physical meter not connected — actual energy measurements unavailable."
 * It must NEVER substitute simulated values for missing physical readings.
 */
export function getPhysicalEnergyReport(
  latestPhysicalReading?: { measured_power_w?: number | null; device_id?: string | null; is_live?: boolean } | null,
  config: PhysicalMeterConfig = currentPhysicalMeterConfig
): PhysicalEnergyReport {
  const hasHardwareReading =
    latestPhysicalReading !== null &&
    latestPhysicalReading !== undefined &&
    typeof latestPhysicalReading.measured_power_w === "number" &&
    !isNaN(latestPhysicalReading.measured_power_w);

  const isMeterConnected = (config.meter_connected || hasHardwareReading) && Boolean(hasHardwareReading);

  if (!isMeterConnected) {
    return {
      report_type: "physical_energy_report",
      status: "DISCONNECTED",
      label: "PHYSICAL HARDWARE MEASUREMENT",
      data_source: "Classroom Physical Power Meter (CT Clamp)",
      timestamp: new Date().toISOString(),
      meter_connected: false,
      meter_device_id: null,
      status_message: "Physical meter not connected — actual energy measurements unavailable.",
      baseline_reference_load_w: config.baseline_reference_load_w,
      measured_power_w: null,
      measured_power_saved_w: null,
      measured_savings_percentage: null,
      measured_daily_energy_kwh: null,
      measured_monthly_energy_kwh: null,
      measured_daily_cost_saved: null,
      measured_monthly_cost_saved: null,
      transparency_note:
        "No physical electrical meter is connected. AI Energy Guardian never substitutes simulated values for missing physical readings.",
    };
  }

  const measuredPowerW = latestPhysicalReading?.measured_power_w || 0;
  const powerSavedW = Math.max(0, config.baseline_reference_load_w - measuredPowerW);
  const savingsPct = config.baseline_reference_load_w > 0
    ? Math.round((powerSavedW / config.baseline_reference_load_w) * 1000) / 10
    : 0;

  const dailySavedKwh = Math.round(((powerSavedW * config.operating_hours_per_day) / 1000) * 100) / 100;
  const monthlySavedKwh = Math.round((dailySavedKwh * config.operating_days_per_month) * 100) / 100;
  const dailyCost = Math.round((dailySavedKwh * config.electricity_rate_per_kwh) * 100) / 100;
  const monthlyCost = Math.round((monthlySavedKwh * config.electricity_rate_per_kwh) * 100) / 100;

  return {
    report_type: "physical_energy_report",
    status: "MEASURED",
    label: "PHYSICAL HARDWARE MEASUREMENT",
    data_source: "Classroom Physical Power Meter (CT Clamp)",
    timestamp: new Date().toISOString(),
    meter_connected: true,
    meter_device_id: latestPhysicalReading?.device_id || config.meter_device_id || "CT_CLAMP_METER_01",
    status_message: "Physical power meter active — live electrical measurements received.",
    baseline_reference_load_w: config.baseline_reference_load_w,
    measured_power_w: Math.round(measuredPowerW * 10) / 10,
    measured_power_saved_w: Math.round(powerSavedW * 10) / 10,
    measured_savings_percentage: savingsPct,
    measured_daily_energy_kwh: dailySavedKwh,
    measured_monthly_energy_kwh: monthlySavedKwh,
    measured_daily_cost_saved: dailyCost,
    measured_monthly_cost_saved: monthlyCost,
    transparency_note:
      "Measured savings calculated from live CT clamp electrical telemetry against documented baseline.",
  };
}

// ============================================================================
// 4. BACKWARDS COMPATIBILITY INTERFACES & EXPORTS
// ============================================================================

export interface ApplianceWattageConfig {
  fan_watts: number;
  light_watts: number;
  smart_board_watts: number;
  total_classroom_fans: number;
  total_classroom_lights: number;
  operating_hours_per_day: number;
  electricity_rate_per_kwh: number;
  currency_symbol: string;
}

export const defaultApplianceConfig: ApplianceWattageConfig = {
  fan_watts: 75,
  light_watts: 28,
  smart_board_watts: 150,
  total_classroom_fans: 5,
  total_classroom_lights: 8,
  operating_hours_per_day: 8,
  electricity_rate_per_kwh: 8.5,
  currency_symbol: "₹",
};

export function getApplianceConfig(): ApplianceWattageConfig {
  return {
    fan_watts: currentClassroomConfig.fan_watts,
    light_watts: currentClassroomConfig.light_watts,
    smart_board_watts: currentClassroomConfig.smart_board_watts,
    total_classroom_fans: currentClassroomConfig.fans_qty,
    total_classroom_lights: currentClassroomConfig.lights_qty,
    operating_hours_per_day: currentClassroomConfig.operating_hours_per_day,
    electricity_rate_per_kwh: currentClassroomConfig.electricity_rate_per_kwh,
    currency_symbol: currentClassroomConfig.currency_symbol,
  };
}

export function updateApplianceConfig(partial: Partial<ApplianceWattageConfig>): ApplianceWattageConfig {
  if (partial.fan_watts !== undefined) currentClassroomConfig.fan_watts = partial.fan_watts;
  if (partial.light_watts !== undefined) currentClassroomConfig.light_watts = partial.light_watts;
  if (partial.smart_board_watts !== undefined) currentClassroomConfig.smart_board_watts = partial.smart_board_watts;
  if (partial.total_classroom_fans !== undefined) currentClassroomConfig.fans_qty = partial.total_classroom_fans;
  if (partial.total_classroom_lights !== undefined) currentClassroomConfig.lights_qty = partial.total_classroom_lights;
  if (partial.operating_hours_per_day !== undefined) currentClassroomConfig.operating_hours_per_day = partial.operating_hours_per_day;
  if (partial.electricity_rate_per_kwh !== undefined) currentClassroomConfig.electricity_rate_per_kwh = partial.electricity_rate_per_kwh;
  if (partial.currency_symbol !== undefined) currentClassroomConfig.currency_symbol = partial.currency_symbol;

  return getApplianceConfig();
}

export interface PowerCalculationBreakdown {
  baseline_power_w: number;
  ai_recommended_power_w: number;
  power_saved_w: number;
  savings_percentage: number;
  daily_energy_saved_kwh: number;
  monthly_energy_saved_kwh: number;
  daily_cost_saved: number;
  monthly_cost_saved: number;
  baseline_fans: number;
  baseline_lights: number;
  recommended_fans: number;
  recommended_lights: number;
  smart_board_on: boolean;
  is_physical_reading: boolean;
  data_source: string;
  transparency_note: string;
}

export function calculatePowerAndSavings(
  recommendedFans: number | null,
  recommendedLights: number | null,
  smartBoardOn: boolean,
  actualFansOn?: number | null,
  actualLightsOn?: number | null,
  dataSource = "simulated",
  isPhysical = false,
  config = getApplianceConfig()
): PowerCalculationBreakdown {
  const fans = recommendedFans !== null && recommendedFans !== undefined ? recommendedFans : 0;
  const lights = recommendedLights !== null && recommendedLights !== undefined ? recommendedLights : 0;

  const baselineFans = actualFansOn !== null && actualFansOn !== undefined && actualFansOn > 0
    ? actualFansOn
    : config.total_classroom_fans;
  const baselineLights = actualLightsOn !== null && actualLightsOn !== undefined && actualLightsOn > 0
    ? actualLightsOn
    : config.total_classroom_lights;

  const baselinePowerW =
    baselineFans * config.fan_watts +
    baselineLights * config.light_watts +
    (smartBoardOn ? config.smart_board_watts : 0);

  const aiRecommendedPowerW =
    fans * config.fan_watts +
    lights * config.light_watts +
    (smartBoardOn ? config.smart_board_watts : 0);

  const powerSavedW = Math.max(0, baselinePowerW - aiRecommendedPowerW);
  const savingsPercentage = baselinePowerW > 0 ? Math.round((powerSavedW / baselinePowerW) * 1000) / 10 : 0;

  const dailyEnergyKwh = Math.round((powerSavedW * config.operating_hours_per_day / 1000) * 100) / 100;
  const monthlyEnergyKwh = Math.round((dailyEnergyKwh * 22) * 100) / 100;

  const dailyCost = Math.round((dailyEnergyKwh * config.electricity_rate_per_kwh) * 100) / 100;
  const monthlyCost = Math.round((monthlyEnergyKwh * config.electricity_rate_per_kwh) * 100) / 100;

  const transparencyNote = isPhysical
    ? "Appliance calculations based on live ESP32 telemetry and configured appliance ratings. Physical CT meter disconnected."
    : "Appliance calculations based on SIMULATED observation context and configured appliance ratings. Physical hardware is not connected.";

  return {
    baseline_power_w: Math.round(baselinePowerW * 10) / 10,
    ai_recommended_power_w: Math.round(aiRecommendedPowerW * 10) / 10,
    power_saved_w: Math.round(powerSavedW * 10) / 10,
    savings_percentage: savingsPercentage,
    daily_energy_saved_kwh: dailyEnergyKwh,
    monthly_energy_saved_kwh: monthlyEnergyKwh,
    daily_cost_saved: dailyCost,
    monthly_cost_saved: monthlyCost,
    baseline_fans: baselineFans,
    baseline_lights: baselineLights,
    recommended_fans: fans,
    recommended_lights: lights,
    smart_board_on: smartBoardOn,
    is_physical_reading: isPhysical,
    data_source: dataSource,
    transparency_note: transparencyNote,
  };
}
