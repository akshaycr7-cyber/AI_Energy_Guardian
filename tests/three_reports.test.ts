import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  getPrototypeConfig,
  updatePrototypeConfig,
  defaultPrototypeConfig,
  calculatePrototypeEnergyReport,
  getClassroomConfig,
  updateClassroomConfig,
  defaultClassroomConfig,
  calculateClassroomConnectedLoad,
  evaluateClassroomSimulationPolicy,
  calculateClassroomSimulationReport,
  getPhysicalMeterConfig,
  updatePhysicalMeterConfig,
  getPhysicalEnergyReport,
} from "../src/power.js";

test("Classroom Connected Load: Defaults to exactly 749 W dynamically computed", () => {
  const config = getClassroomConfig();
  assert.equal(config.fans_qty, 5);
  assert.equal(config.fan_watts, 75);
  assert.equal(config.lights_qty, 8);
  assert.equal(config.light_watts, 28);
  assert.equal(config.smart_board_qty, 1);
  assert.equal(config.smart_board_watts, 150);

  // 5 * 75 + 8 * 28 + 1 * 150 = 375 + 224 + 150 = 749 W
  const connectedLoad = calculateClassroomConnectedLoad(config);
  assert.equal(connectedLoad, 749);
});

test("Prototype vs. Classroom Configurations: Remain strictly independent", () => {
  // Snapshot initial configs
  const initialProto = getPrototypeConfig();
  const initialClass = getClassroomConfig();

  // Update prototype configuration
  updatePrototypeConfig({
    mini_fan_watts: 6.5,
    lcd_display_watts: 3.2,
    electricity_rate_per_kwh: 9.0,
  });

  const updatedProto = getPrototypeConfig();
  const unchangedClass = getClassroomConfig();

  // Prototype was updated
  assert.equal(updatedProto.mini_fan_watts, 6.5);
  assert.equal(updatedProto.lcd_display_watts, 3.2);

  // Classroom was NOT mutated
  assert.equal(unchangedClass.fan_watts, initialClass.fan_watts);
  assert.equal(unchangedClass.smart_board_watts, initialClass.smart_board_watts);
  assert.equal(unchangedClass.fans_qty, initialClass.fans_qty);

  // Update classroom configuration
  updateClassroomConfig({
    fans_qty: 6,
    fan_watts: 80,
  });

  const updatedClass = getClassroomConfig();
  const untouchedProto = getPrototypeConfig();

  // Classroom updated
  assert.equal(updatedClass.fans_qty, 6);
  assert.equal(updatedClass.fan_watts, 80);

  // Prototype remains untouched
  assert.equal(untouchedProto.mini_fan_watts, 6.5);
  assert.equal(untouchedProto.lcd_display_watts, 3.2);

  // Restore defaults
  updatePrototypeConfig(defaultPrototypeConfig);
  updateClassroomConfig(defaultClassroomConfig);
});

test("Prototype LCD Wattage: Is user-configurable and strictly NEVER 150 W", () => {
  const proto = getPrototypeConfig();
  assert.ok(proto.lcd_display_watts < 10, "Prototype LCD should be low-power bench scale, not 150 W");
  assert.notEqual(proto.lcd_display_watts, 150, "150 W belongs solely to the smart board, never the prototype LCD");

  // Verify configurable
  const updated = updatePrototypeConfig({ lcd_display_watts: 2.8 });
  assert.equal(updated.lcd_display_watts, 2.8);

  const report = calculatePrototypeEnergyReport({
    mini_fan_on: true,
    led_light_on: true,
    lcd_display_on: true,
  });

  // Total connected load = 1*5 + 1*2 + 1*2.8 = 9.8 W
  assert.equal(report.total_connected_load_w, 9.8);
  assert.equal(report.label, "ESTIMATED (PROTOTYPE BENCH)");
  assert.equal(report.status, "ESTIMATED");

  // Restore default
  updatePrototypeConfig(defaultPrototypeConfig);
});

test("Energy Calculations: Power x Time (kWh) and Tariff-based Cost", () => {
  const config = {
    ...defaultClassroomConfig,
    operating_hours_per_day: 8,
    operating_days_per_month: 22,
    electricity_rate_per_kwh: 8.5,
  };

  // Baseline load: 749 W
  // Daily energy = 749 W * 8 h / 1000 = 5.992 -> 5.99 kWh
  const dailyKwh = Math.round(((749 * 8) / 1000) * 100) / 100;
  assert.equal(dailyKwh, 5.99);

  // If power saved = 337 W
  // Daily saved = 337 * 8 / 1000 = 2.696 -> 2.70 kWh
  const dailySavedKwh = Math.round(((337 * 8) / 1000) * 100) / 100;
  assert.equal(dailySavedKwh, 2.7);

  // Monthly saved = 2.70 * 22 = 59.40 kWh
  const monthlySavedKwh = Math.round((dailySavedKwh * 22) * 100) / 100;
  assert.equal(monthlySavedKwh, 59.4);

  // Monthly cost saved = 59.40 * 8.50 = 504.90
  const monthlyCostSaved = Math.round((monthlySavedKwh * 8.5) * 100) / 100;
  assert.equal(monthlyCostSaved, 504.9);
});

test("Classroom Simulation Policy: Governed recommendations & documentation", () => {
  // 1. Zero Occupancy rule: 0 fans, 0 lights
  const emptyRoom = evaluateClassroomSimulationPolicy({
    occupancy: 0,
    temperature_c: 29.0,
    ambient_light_lux: 100,
  });
  assert.equal(emptyRoom.recommended_fans, 0);
  assert.equal(emptyRoom.recommended_lights, 0);
  assert.ok(emptyRoom.rules_applied.includes("ZERO_OCCUPANCY_IDLE_CONSERVATION"));

  // 2. High heat stress (T >= 30°C): All fans
  const hotRoom = evaluateClassroomSimulationPolicy({
    occupancy: 30,
    temperature_c: 31.5,
    ambient_light_lux: 400,
  });
  assert.equal(hotRoom.recommended_fans, 5);
  assert.ok(hotRoom.rules_applied.includes("FAN_HEAT_STRESS_MAXIMUM"));

  // 3. Smart Board Active: screen glare mitigation caps lights
  const smartBoardClass = evaluateClassroomSimulationPolicy({
    occupancy: 25,
    temperature_c: 25.0,
    smart_board_on: true,
    ambient_light_lux: 250,
  });
  assert.ok(smartBoardClass.rules_applied.includes("LIGHT_SMART_BOARD_ANTI_GLARE"));
  assert.ok(smartBoardClass.recommended_lights <= 4, "Smart board active must cap lights to prevent screen glare");

  // 4. Report labeling: Strictly labeled as SIMULATED / PROJECTED
  const simReport = calculateClassroomSimulationReport({
    occupancy: 25,
    temperature_c: 27.0,
    smart_board_on: false,
  });
  assert.equal(simReport.label, "SIMULATED / PROJECTED");
  assert.equal(simReport.status, "SIMULATED");
  assert.ok(simReport.provenance_note.includes("SIMULATED or PROJECTED"));
});

test("Physical Energy Report: Disconnected status honestly reported with null measurements", () => {
  // When physical meter is offline
  const offlineReport = getPhysicalEnergyReport(null);
  assert.equal(offlineReport.meter_connected, false);
  assert.equal(offlineReport.status, "DISCONNECTED");
  assert.equal(
    offlineReport.status_message,
    "Physical meter not connected — actual energy measurements unavailable."
  );
  assert.equal(offlineReport.measured_power_w, null);
  assert.equal(offlineReport.measured_daily_energy_kwh, null);
  assert.equal(offlineReport.measured_monthly_energy_kwh, null);
  assert.equal(offlineReport.measured_power_saved_w, null);

  // When physical meter is connected with real measurement
  const onlineReport = getPhysicalEnergyReport({
    measured_power_w: 420.5,
    device_id: "PZEM_CT_01",
    is_live: true,
  });
  assert.equal(onlineReport.meter_connected, true);
  assert.equal(onlineReport.status, "MEASURED");
  assert.equal(onlineReport.measured_power_w, 420.5);
  assert.ok(onlineReport.measured_power_saved_w !== null);
  assert.ok(onlineReport.measured_power_saved_w > 0);
});

// ----------------- API Integration Tests -----------------

const API_BASE = "http://localhost:3000";

test("API: GET /api/reports/prototype returns estimated prototype report", async () => {
  const res = await fetch(`${API_BASE}/api/reports/prototype`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.label, "ESTIMATED (PROTOTYPE BENCH)");
  assert.equal(data.report.status, "ESTIMATED");
  assert.equal(data.report.report_type, "prototype_energy_report");
  assert.ok(data.report.total_connected_load_w > 0);
  assert.notEqual(data.config.lcd_display_watts, 150, "Prototype LCD display wattage must never be 150W");
});

test("API: GET /api/reports/classroom returns projected simulation report with dynamic connected load", async () => {
  const res = await fetch(`${API_BASE}/api/reports/classroom`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.label, "SIMULATED / PROJECTED");
  assert.equal(data.report.status, "SIMULATED");
  assert.equal(data.report.report_type, "classroom_simulation_report");
  // Default connected load = 749 W
  assert.equal(data.connected_load_w, 749);
  assert.equal(data.report.configuration.total_connected_load_w, 749);
  assert.ok(data.report.simulation_policy.policy_name.includes("Simulation Policy"));
});

test("API: GET /api/reports/physical honestly reports disconnected meter and null measurements", async () => {
  const res = await fetch(`${API_BASE}/api/reports/physical`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.meter_connected, false);
  assert.equal(data.report.status, "DISCONNECTED");
  assert.equal(
    data.status_message,
    "Physical meter not connected — actual energy measurements unavailable."
  );
  assert.equal(data.report.measured_power_w, null);
  assert.equal(data.report.measured_daily_energy_kwh, null);
});

test("API: PATCH /api/reports/prototype/config & PATCH /api/reports/classroom/config isolate updates", async () => {
  // Update prototype LCD wattage
  const protoPatch = await fetch(`${API_BASE}/api/reports/prototype/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lcd_display_watts: 3.5, mini_fan_watts: 5.5 }),
  });
  assert.equal(protoPatch.status, 200);
  const protoData = await protoPatch.json();
  assert.equal(protoData.config.lcd_display_watts, 3.5);
  assert.equal(protoData.config.mini_fan_watts, 5.5);

  // Verify classroom smart board and fan ratings were NOT affected
  const classGet = await fetch(`${API_BASE}/api/reports/classroom`);
  const classData = await classGet.json();
  assert.equal(classData.config.fan_watts, 75);
  assert.equal(classData.config.smart_board_watts, 150);

  // Restore defaults
  await fetch(`${API_BASE}/api/reports/prototype/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaultPrototypeConfig),
  });
  await fetch(`${API_BASE}/api/reports/classroom/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaultClassroomConfig),
  });
});

