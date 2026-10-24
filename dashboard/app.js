const $ = id => document.getElementById(id);
const api = path => {
  const token = getStoredToken();
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { headers }).then(async response => {
    if (!response.ok) {
      let detail = response.statusText;
      try { detail = (await response.json()).detail || detail; } catch (_) { /* Use safe status text. */ }
      throw new Error(detail);
    }
    return response.json();
  });
};

let lastHistory = [];
let cachedDataset = null;
let activeHistoryTab = "session"; // "session" | "dataset"
let isRefreshing = false;
let isContinuousSimActive = false;
let currentUser = null; // null | { id, email, role, assignedRoom }

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function valueOrDash(value) {
  return value === undefined || value === null || value === "" ? "—" : value;
}

function formatNumber(value, suffix = "") {
  return value === undefined || value === null || value === "" ? "—" : `${value}${suffix}`;
}

function refreshButtons() {
  return [$("refresh"), $("refresh-top")].filter(Boolean);
}

function setRefreshState(isLoading) {
  document.body.classList.toggle("is-loading", isLoading);
  refreshButtons().forEach(button => { button.disabled = isLoading; });
}

function setDashboardStatus(message, state) {
  const status = $("dashboard-status");
  if (!status) return;
  status.dataset.state = state;
  if (status.lastElementChild) {
    status.lastElementChild.textContent = message;
  }
}

function markSuccessfulUpdate() {
  const updatedAt = new Date();
  const time = $("last-update");
  if (time) {
    time.dateTime = updatedAt.toISOString();
    time.textContent = updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}

// ----------------- Sensor & Connection Updates -----------------

function updateConnectionAndSensors(health, sensorHealth) {
  const isApiOk = health?.status === "ok";
  const apiBadge = $("connection");
  if (apiBadge) {
    apiBadge.textContent = isApiOk ? "Backend: Online" : "Backend: Offline";
    apiBadge.dataset.status = isApiOk ? "ok" : "error";
  }
  setText("sidebar-status", isApiOk ? "API Server: Online" : "API Server: Offline");

  const sensorBadge = $("sensor-connection");
  const sidebarSensor = $("sidebar-sensor-status");
  const sidebarDot = $("sidebar-dot");
  const hwBanner = $("hardware-status-banner");
  const isPrivileged = currentUser && (currentUser.role === "admin" || currentUser.role === "operator");

  const simBanner = $("sim-active-banner");
  const isSimActive = isContinuousSimActive || (sensorHealth && sensorHealth.status === "simulated_only");
  if (simBanner) {
    simBanner.style.display = isSimActive ? "block" : "none";
  }

  if (!sensorHealth) {
    if (sensorBadge) {
      sensorBadge.textContent = "Sensors: NOT CONNECTED";
      sensorBadge.dataset.status = "disconnected";
    }
    if (sidebarSensor) sidebarSensor.textContent = "Sensors: NOT CONNECTED";
    return;
  }

  const { physicalSensorConnected, status, lastPhysicalReadingTime, physicalAgeSeconds, configuredDeviceId, staleThresholdSeconds } = sensorHealth;

  if (physicalSensorConnected) {
    // 1. LIVE PHYSICAL DATA
    if (sensorBadge) {
      sensorBadge.textContent = isPrivileged ? "Sensors: CONNECTED (ESP32 Live)" : "Sensors: CONNECTED";
      sensorBadge.dataset.status = "live";
    }
    if (sidebarSensor) sidebarSensor.textContent = isPrivileged ? "Sensors: CONNECTED (ESP32)" : "Sensors: CONNECTED";
    if (sidebarDot) {
      sidebarDot.style.background = "var(--green)";
      sidebarDot.style.boxShadow = "0 0 10px var(--green)";
    }
    setText("data-source", isPrivileged ? "Mode: Live ESP32 Telemetry" : "Mode: Live Room Telemetry");

    // Hardware Status Banner
    if (hwBanner) hwBanner.classList.add("is-live");
    setText("hw-icon", "🟢");
    setText("hw-kicker", isPrivileged ? "HARDWARE STATUS · ESP32 ONLINE" : "SENSOR STATUS");
    setText("hw-title", "Physical ESP32 Sensor Connected · Live Data");
    setText("hw-desc", "Classroom ESP32 microcontroller is actively transmitting live physical environmental telemetry.");

    const techRow = $("hw-meta-tech-row");
    if (techRow) {
      techRow.style.display = "flex";
      setText("hw-device-id", configuredDeviceId || "ESP32_LAB_CLASSROOM_01");
      const timeStr = lastPhysicalReadingTime ? new Date(lastPhysicalReadingTime).toLocaleTimeString() : "Just now";
      setText("hw-last-physical-time", `Last physical packet: ${timeStr} (${physicalAgeSeconds ?? 0}s ago)`);
    }
  } else if (status === "stale") {
    // 2. STALE PHYSICAL DATA (Exceeded stale-data timeout threshold)
    if (sensorBadge) {
      sensorBadge.textContent = "Sensors: STALE";
      sensorBadge.dataset.status = "stale";
    }
    if (sidebarSensor) sidebarSensor.textContent = `Sensors: STALE (${physicalAgeSeconds}s)`;
    if (sidebarDot) {
      sidebarDot.style.background = "var(--pink)";
      sidebarDot.style.boxShadow = "var(--glow-pink)";
    }
    setText("data-source", isPrivileged ? "Mode: Stale Physical Data" : "Mode: Stale Data");

    if (hwBanner) hwBanner.classList.remove("is-live");
    setText("hw-icon", "⚠️");
    setText("hw-kicker", "HARDWARE STATUS · ESP32 STALE");
    setText("hw-title", `Physical Sensor Stale (Last reported ${physicalAgeSeconds}s ago)`);
    setText("hw-desc", `Physical ESP32 telemetry is older than the ${staleThresholdSeconds || 30}s timeout threshold. Live readings are unavailable.`);

    const techRow = $("hw-meta-tech-row");
    if (techRow) {
      techRow.style.display = "flex";
      setText("hw-device-id", configuredDeviceId || "ESP32_LAB_CLASSROOM_01");
      const timeStr = lastPhysicalReadingTime ? new Date(lastPhysicalReadingTime).toLocaleTimeString() : "Unknown";
      setText("hw-last-physical-time", `Last physical packet: ${timeStr}`);
    }
  } else {
    // 3. NOT CONNECTED (No valid authenticated physical sensor telemetry)
    if (sensorBadge) {
      sensorBadge.textContent = "Sensors: NOT CONNECTED";
      sensorBadge.dataset.status = "disconnected";
    }
    if (sidebarSensor) sidebarSensor.textContent = "Sensors: NOT CONNECTED";
    if (sidebarDot) {
      sidebarDot.style.background = "var(--amber)";
      sidebarDot.style.boxShadow = "0 0 10px var(--amber)";
    }
    setText("data-source", sensorHealth.totalSimulatedReadings > 0
      ? "Mode: Simulation Active (Hardware Not Connected)"
      : "Mode: Awaiting Hardware Telemetry");

    if (hwBanner) hwBanner.classList.remove("is-live");
    setText("hw-icon", "📡");
    setText("hw-kicker", "SENSOR STATUS");
    setText("hw-title", "Physical sensors are not connected.");
    setText("hw-desc", "Live readings will appear after the ESP32 and sensors are connected and valid telemetry is received.");

    const techRow = $("hw-meta-tech-row");
    if (techRow) {
      techRow.style.display = isPrivileged ? "flex" : "none";
      setText("hw-device-id", configuredDeviceId || "ESP32_LAB_CLASSROOM_01");
      setText("hw-last-physical-time", lastPhysicalReadingTime
        ? `Last physical packet: ${new Date(lastPhysicalReadingTime).toLocaleTimeString()}`
        : "Last physical packet: None recorded");
    }
  }

  // Diagnostics panel update (if visible to admin/operator)
  if (isPrivileged) {
    updateDiagnosticsUI(sensorHealth);
  }
}

// ----------------- Role-Based Diagnostics Update -----------------

function updateDiagnosticsUI(sensorHealth) {
  setText("diag-conn-state", sensorHealth.physicalSensorConnected ? "Connected (Live)" : sensorHealth.status.toUpperCase());
  setText("diag-device-id", sensorHealth.configuredDeviceId || "ESP32_LAB_CLASSROOM_01");
  setText("diag-last-packet", sensorHealth.lastPhysicalReadingTime
    ? new Date(sensorHealth.lastPhysicalReadingTime).toLocaleTimeString()
    : "None recorded");
  setText("diag-stale-thresh", `${sensorHealth.staleThresholdSeconds} seconds`);
  setText("diag-stale-dur", sensorHealth.physicalAgeSeconds !== null ? `${sensorHealth.physicalAgeSeconds}s` : "N/A");
  setText("diag-storage", history ? "Process-local memory" : "Active");

  const logsEl = $("diag-logs-list");
  if (logsEl && sensorHealth.sensorErrors) {
    if (!sensorHealth.sensorErrors.length) {
      logsEl.textContent = "No hardware events logged.";
      return;
    }
    logsEl.replaceChildren();
    sensorHealth.sensorErrors.forEach(err => {
      const line = document.createElement("div");
      line.className = "diag-log-line";
      const timeStr = new Date(err.timestamp).toLocaleTimeString();
      line.innerHTML = `
        <span class="diag-log-time">[${timeStr}]</span>
        <span class="diag-log-${err.severity}">[${err.severity.toUpperCase()}]</span>
        <span style="color: #ffffff;">${err.message}</span>
      `;
      logsEl.appendChild(line);
    });
  }
}

// ----------------- Monitored Rooms Loading -----------------

async function loadMonitoredRooms() {
  const grid = $("room-grid");
  if (!grid) return;
  try {
    const data = await api("/api/rooms");
    const rooms = data.rooms || [];
    grid.replaceChildren();

    const scopeBadge = $("rooms-scope-badge");
    const isPrivileged = currentUser && (currentUser.role === "admin" || currentUser.role === "operator");
    if (scopeBadge) {
      scopeBadge.textContent = data.access_level === "all_rooms" ? "All Facility Rooms" : "Assigned Room Only";
    }

    rooms.forEach(room => {
      const card = document.createElement("article");
      card.className = "room-card";
      const statusColor = room.status === "live" ? "var(--green)" : room.status === "stale" ? "var(--pink)" : "var(--amber)";
      const statusLabel = room.status === "live" ? "Sensors Live" : room.status === "stale" ? "Sensors Stale" : "Sensors Disconnected";
      const metaLine = isPrivileged ? `${room.building} · Device: ${room.deviceId}` : `${room.building}`;

      card.innerHTML = `
        <div class="room-card-header">
          <h3>${room.name}</h3>
          <span style="font-size: 0.68rem; font-weight: 700; color: ${statusColor};">${statusLabel}</span>
        </div>
        <p>${metaLine}</p>
        <div class="room-appliances">
          <strong>Monitored loads:</strong>
          <ul style="margin: 4px 0 0 16px; padding: 0;">
            ${room.monitoredAppliances.map(a => `<li>${a}</li>`).join("")}
          </ul>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.textContent = "Unable to load rooms.";
  }
}

// ----------------- Telemetry, Simulator & AI Forecasts -----------------

function updateLiveTelemetryCards(sensorHealth) {
  const isPhysicalLive = sensorHealth && sensorHealth.physicalSensorConnected;
  const isStale = sensorHealth && sensorHealth.status === "stale";
  const physicalReading = sensorHealth ? sensorHealth.latestPhysicalReading : null;

  const liveBadge = $("live-provenance-badge");

  if (isPhysicalLive && physicalReading) {
    const r = physicalReading.reading;
    setText("occupancy", valueOrDash(r.occupancy));
    setText("occupancy-sub", "Live ESP32 count");

    setText("temperature", formatNumber(r.temperature_c, " °C"));
    setText("temperature-sub", `Live ESP32 · ${r.weather_condition || "Clear"}`);

    setText("humidity", formatNumber(r.humidity_pct, " %"));
    setText("humidity-sub", "Live ESP32 sensor");

    setText("board", r.smart_board_on ? "ON" : "OFF");
    setText("board-sub", "Live state");

    if (liveBadge) {
      liveBadge.textContent = "ESP32 Live Telemetry";
      liveBadge.style.color = "var(--green)";
      liveBadge.style.borderColor = "rgba(72, 245, 166, 0.5)";
    }
  } else if (isStale) {
    // Stale: Stop presenting readings as current; show explicit N/A and Waiting for sensor data
    setText("occupancy", "N/A");
    setText("occupancy-sub", `Stale packet (${sensorHealth?.physicalAgeSeconds ?? 0}s ago) — waiting for data`);

    setText("temperature", "N/A");
    setText("temperature-sub", "Telemetry stale — waiting for data");

    setText("humidity", "N/A");
    setText("humidity-sub", "Telemetry stale — waiting for data");

    setText("board", "N/A");
    setText("board-sub", "Telemetry stale — waiting for data");

    if (liveBadge) {
      liveBadge.textContent = "Sensors: STALE";
      liveBadge.style.color = "var(--pink)";
      liveBadge.style.borderColor = "rgba(244, 86, 198, 0.5)";
    }
  } else {
    // Disconnected: Never display 0 or simulated values; show N/A and Waiting for sensor data
    setText("occupancy", "N/A");
    setText("occupancy-sub", "Waiting for sensor data");

    setText("temperature", "N/A");
    setText("temperature-sub", "Waiting for sensor data");

    setText("humidity", "N/A");
    setText("humidity-sub", "Waiting for sensor data");

    setText("board", "N/A");
    setText("board-sub", "Waiting for sensor data");

    if (liveBadge) {
      liveBadge.textContent = "NOT CONNECTED";
      liveBadge.style.color = "var(--amber)";
      liveBadge.style.borderColor = "rgba(255, 190, 89, 0.4)";
    }
  }
}

function updateSimulatorSandbox(sensorHealth) {
  const isPrivileged = currentUser && (currentUser.role === "admin" || currentUser.role === "operator");
  if (!isPrivileged) return; // Do not process simulator data for normal users

  const simReading = sensorHealth ? sensorHealth.latestSimulatedReading : null;
  if (simReading) {
    const r = simReading.reading;
    setText("sim-occupancy", valueOrDash(r.occupancy));
    setText("sim-temp", formatNumber(r.temperature_c, " °C"));
    setText("sim-humidity", formatNumber(r.humidity_pct, " %"));
    setText("sim-board", r.smart_board_on ? "ON" : "OFF");
    setText("sim-last-time", `Last simulated: ${new Date(simReading.timestamp).toLocaleTimeString()}`);
  } else {
    setText("sim-occupancy", "—");
    setText("sim-temp", "—");
    setText("sim-humidity", "—");
    setText("sim-board", "—");
    setText("sim-last-time", "Last simulated reading: None");
  }
}

function updateAIPredictionsAndDecisions(sensorHealth) {
  const isPhysicalLive = sensorHealth && sensorHealth.physicalSensorConnected;

  if (isPhysicalLive && sensorHealth.latestPhysicalReading) {
    const targetRecord = sensorHealth.latestPhysicalReading;
    if (targetRecord.prediction && targetRecord.prediction.status !== "insufficient_data") {
      const p = targetRecord.prediction;
      const d = targetRecord.decision;

      setText("fans", formatNumber(p.predicted_fan_count, " fans"));
      setText("lights", formatNumber(p.predicted_light_count, " lights"));
      setText("model-status", "Model Forecast: Live (ESP32)");

      setText("recommendation", d.reason || "Optimal classroom comfort and energy profile calculated.");
      setText("recommended-fans", formatNumber(d.recommended_fan_count, " fans"));
      setText("recommended-lights", formatNumber(d.recommended_light_count, " lights"));
      setText("recommendation-evidence", `Mode: ${d.ai_mode} · Verified against live physical sensors.`);
      setText("ai-mode", `(${d.ai_mode})`);
      return;
    }
  }

  // If privileged and continuous simulator is active or simulated records exist, provide clearly labeled simulation mode
  const isPrivileged = currentUser && (currentUser.role === "admin" || currentUser.role === "operator");
  if (isPrivileged && sensorHealth?.latestSimulatedReading) {
    const sim = sensorHealth.latestSimulatedReading;
    if (sim.prediction && sim.prediction.status !== "insufficient_data") {
      const p = sim.prediction;
      const d = sim.decision;
      setText("fans", formatNumber(p.predicted_fan_count, " fans (simulated)"));
      setText("lights", formatNumber(p.predicted_light_count, " lights (simulated)"));
      setText("model-status", "SIMULATION MODE — NOT PHYSICAL SENSOR DATA");
      setText("recommendation", `[SIMULATION] ${d.reason || "Synthetic sandbox recommendation."}`);
      setText("recommended-fans", formatNumber(d.recommended_fan_count, " fans (sim)"));
      setText("recommended-lights", formatNumber(d.recommended_light_count, " lights (sim)"));
      setText("recommendation-evidence", "SIMULATED ADVISORY: Hardware offline. Calculated strictly from synthetic simulator sandbox.");
      setText("ai-mode", "(SIMULATION MODE)");
      return;
    }
  }

  // Default disconnected / hardware offline state: Do NOT fabricate or claim active monitoring
  setText("fans", "N/A");
  setText("lights", "N/A");
  setText("model-status", "Standing By (Hardware Offline)");

  setText("recommendation", "Physical sensors are not connected. Live readings will appear after the ESP32 and sensors are connected and valid telemetry is received.");
  setText("recommended-fans", "N/A");
  setText("recommended-lights", "N/A");
  setText("recommendation-evidence", "Live AI monitoring is suspended until authenticated ESP32 telemetry is received.");
  setText("ai-mode", "(Standing By - Hardware Offline)");
}

let activeReportTab = "classroom"; // "classroom" | "prototype" | "physical"
let cachedClassroomConfig = null;
let cachedPrototypeConfig = null;

function setReportTab(tab) {
  activeReportTab = tab;
  const tabs = ["classroom", "prototype", "physical"];
  tabs.forEach(t => {
    const btn = $(`tab-report-${t}`);
    const view = $(`view-report-${t}`);
    const isActive = t === tab;
    if (btn) btn.classList.toggle("active", isActive);
    if (view) view.style.display = isActive ? "block" : "none";
  });
}

async function updatePowerAudit(latestRecord) {
  try {
    const summaryData = await api("/api/power/summary");

    // 1. CLASSROOM SIMULATION REPORT
    const cr = summaryData?.classroom_report;
    if (cr) {
      cachedClassroomConfig = cr.configuration;
      setText("cr-connected-load", `${cr.configuration.total_connected_load_w} W`);
      setText("cr-connected-sub", `${cr.configuration.fans_qty}×${cr.configuration.fan_watts}W + ${cr.configuration.lights_qty}×${cr.configuration.light_watts}W + ${cr.configuration.smart_board_qty}×${cr.configuration.smart_board_watts}W`);
      setText("cr-baseline-power", `${cr.baseline_power_w} W`);
      setText("cr-optimized-power", `${cr.projected_optimized_power_w} W`);
      setText("cr-power-saved", `${cr.projected_power_saved_w} W (${cr.projected_savings_percentage}%)`);
      setText("cr-daily-saved", `${cr.projected_daily_energy_saved_kwh.toFixed(2)} kWh`);
      setText("cr-monthly-saved", `${cr.projected_monthly_energy_saved_kwh.toFixed(2)} kWh`);
      setText("cr-monthly-cost", `₹${cr.projected_monthly_cost_saved.toFixed(2)}`);

      if (cr.simulation_policy) {
        setText("cr-policy-summary", cr.simulation_policy.reason || "Classroom Policy: Thermal comfort & visual rules applied.");
        if (cr.simulation_policy.fan_reasoning) {
          setText("cr-policy-fan-text", cr.simulation_policy.fan_reasoning);
        }
        if (cr.simulation_policy.light_reasoning) {
          setText("cr-policy-light-text", cr.simulation_policy.light_reasoning);
        }
      }

      // Populate form inputs if not active
      if (document.activeElement?.id?.indexOf("cr-cfg-") === -1) {
        const fQty = $("cr-cfg-fans-qty");
        const fW = $("cr-cfg-fan-watts");
        const lQty = $("cr-cfg-lights-qty");
        const lW = $("cr-cfg-light-watts");
        const bW = $("cr-cfg-board-watts");
        const rate = $("cr-cfg-rate");
        const hours = $("cr-cfg-hours");
        const days = $("cr-cfg-days");

        if (fQty) fQty.value = cr.configuration.fans_qty;
        if (fW) fW.value = cr.configuration.fan_watts;
        if (lQty) lQty.value = cr.configuration.lights_qty;
        if (lW) lW.value = cr.configuration.light_watts;
        if (bW) bW.value = cr.configuration.smart_board_watts;
        if (rate) rate.value = cr.configuration.electricity_rate_per_kwh;
        if (hours) hours.value = cr.configuration.operating_hours_per_day;
        if (days) days.value = cr.configuration.operating_days_per_month;
      }
    }

    // 2. PROTOTYPE ENERGY REPORT
    const pr = summaryData?.prototype_report;
    if (pr) {
      cachedPrototypeConfig = pr.configuration;
      setText("pr-connected-load", `${pr.total_connected_load_w} W`);
      setText("pr-connected-sub", `${pr.configuration.mini_fan_qty} Fan (${pr.configuration.mini_fan_watts}W) + ${pr.configuration.led_light_qty} LED (${pr.configuration.led_light_watts}W) + ${pr.configuration.lcd_display_qty} LCD (${pr.configuration.lcd_display_watts}W)`);
      setText("pr-baseline-power", `${pr.baseline_power_w} W`);
      setText("pr-active-power", `${pr.active_power_w} W`);
      setText("pr-power-saved", `${pr.power_saved_w} W (${pr.savings_percentage}%)`);
      setText("pr-daily-consumption", `${pr.daily_energy_consumption_kwh.toFixed(3)} kWh`);
      setText("pr-monthly-saved", `${pr.monthly_energy_saved_kwh.toFixed(2)} kWh`);
      setText("pr-monthly-cost", `₹${pr.monthly_cost_saved.toFixed(2)}`);

      if (document.activeElement?.id?.indexOf("pr-cfg-") === -1) {
        const fQty = $("pr-cfg-fan-qty");
        const fW = $("pr-cfg-fan-watts");
        const lQty = $("pr-cfg-light-qty");
        const lW = $("pr-cfg-light-watts");
        const lcdQty = $("pr-cfg-lcd-qty");
        const lcdW = $("pr-cfg-lcd-watts");
        const rate = $("pr-cfg-rate");
        const hours = $("pr-cfg-hours");

        if (fQty) fQty.value = pr.configuration.mini_fan_qty;
        if (fW) fW.value = pr.configuration.mini_fan_watts;
        if (lQty) lQty.value = pr.configuration.led_light_qty;
        if (lW) lW.value = pr.configuration.led_light_watts;
        if (lcdQty) lcdQty.value = pr.configuration.lcd_display_qty;
        if (lcdW) lcdW.value = pr.configuration.lcd_display_watts;
        if (rate) rate.value = pr.configuration.electricity_rate_per_kwh;
        if (hours) hours.value = pr.configuration.operating_hours_per_day;
      }
    }

    // 3. PHYSICAL ENERGY REPORT
    const ph = summaryData?.physical_report;
    const isMeterOnline = ph && ph.meter_connected;

    if (isMeterOnline) {
      setText("ph-status-banner-text", "Physical power meter active — live electrical measurements received.");
      const phBanner = $("ph-status-banner");
      if (phBanner) {
        phBanner.style.background = "rgba(20, 50, 35, 0.45)";
        phBanner.style.borderColor = "rgba(72, 245, 166, 0.5)";
      }
      setText("ph-meter-state", "CT Meter Online");
      const stateEl = $("ph-meter-state");
      if (stateEl) stateEl.style.color = "var(--green)";
      setText("ph-meter-sub", `Device: ${ph.meter_device_id || "Active"}`);

      setText("ph-measured-power", `${ph.measured_power_w} W`);
      setText("ph-measured-power-sub", "Live measured electrical load");
      setText("ph-measured-savings", `${ph.measured_power_saved_w} W (${ph.measured_savings_percentage}%)`);
      setText("ph-measured-savings-sub", "Measured reduction vs 749W baseline");

      setText("ph-ref-baseline", `${ph.baseline_reference_load_w} W`);
      setText("ph-daily-kwh", `${ph.measured_daily_energy_kwh?.toFixed(2) || "0.00"} kWh`);
      setText("ph-monthly-kwh", `${ph.measured_monthly_energy_kwh?.toFixed(2) || "0.00"} kWh`);
      setText("ph-monthly-cost", `₹${ph.measured_monthly_cost_saved?.toFixed(2) || "0.00"}`);
    } else {
      // Disconnected: Enforce exact required phrase and null placeholders
      setText("ph-status-banner-text", "Physical meter not connected — actual energy measurements unavailable.");
      const phBanner = $("ph-status-banner");
      if (phBanner) {
        phBanner.style.background = "rgba(45, 25, 20, 0.45)";
        phBanner.style.borderColor = "rgba(255, 190, 89, 0.5)";
      }
      setText("ph-meter-state", "CT Meter Disconnected");
      const stateEl = $("ph-meter-state");
      if (stateEl) stateEl.style.color = "var(--amber)";
      setText("ph-meter-sub", "Physical telemetry port awaiting hardware");

      setText("ph-measured-power", "—");
      setText("ph-measured-power-sub", "Actual measurements unavailable");
      setText("ph-measured-savings", "—");
      setText("ph-measured-savings-sub", "Zero-fabrication enforced");

      setText("ph-ref-baseline", `${ph?.baseline_reference_load_w || 749} W`);
      setText("ph-daily-kwh", "—");
      setText("ph-monthly-kwh", "—");
      setText("ph-monthly-cost", "—");
    }

    if (summaryData?.power_summary?.transparency_note) {
      setText("power-provenance-note", summaryData.power_summary.transparency_note);
    }
  } catch (err) {
    console.warn("Failed to update power audit reports:", err);
  }
}

// ----------------- Canvas Chart -----------------

function canvasFont(context, size, weight = "600") {
  context.font = `${weight} ${size}px 'Space Grotesk', system-ui, sans-serif`;
}

function drawPlot(context, series, bounds, { color, label, unit }) {
  if (!series.length) return;
  const { left, right, top, bottom } = bounds;
  const width = right - left;
  const height = bottom - top;
  const values = series.map(point => point.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const padding = (maxVal - minVal) * 0.15 || 2;
  const min = minVal - padding;
  const max = maxVal + padding;
  const range = Math.max(max - min, 1);

  context.save();

  // Grid line
  context.strokeStyle = "rgba(138, 112, 255, 0.14)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(left, top);
  context.lineTo(right, top);
  context.moveTo(left, bottom);
  context.lineTo(right, bottom);
  context.stroke();

  // Y-axis labels
  context.fillStyle = "#8a96c4";
  canvasFont(context, 10);
  context.textAlign = "right";
  context.fillText(`${Math.round(max)}${unit}`, left - 8, top + 10);
  context.fillText(`${Math.round(min)}${unit}`, left - 8, bottom);

  // Label banner
  context.textAlign = "left";
  context.fillStyle = color;
  canvasFont(context, 11, "700");
  context.fillText(label, left + 4, top - 8);

  const pointX = index => left + width * (index / Math.max(series.length - 1, 1));
  const pointY = point => bottom - ((point.value - min) / range) * height;

  // Area Fill
  const areaGradient = context.createLinearGradient(0, top, 0, bottom);
  areaGradient.addColorStop(0, color === "#bd7cff" ? "rgba(189, 124, 255, 0.22)" : "rgba(62, 228, 255, 0.2)");
  areaGradient.addColorStop(1, "rgba(5, 10, 28, 0.0)");
  context.fillStyle = areaGradient;
  context.beginPath();
  series.forEach((point, index) => index ? context.lineTo(pointX(index), pointY(point)) : context.moveTo(pointX(index), pointY(point)));
  context.lineTo(right, bottom);
  context.lineTo(left, bottom);
  context.closePath();
  context.fill();

  // Neon Stroke
  context.shadowColor = color;
  context.shadowBlur = 10;
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.beginPath();
  series.forEach((point, index) => index ? context.lineTo(pointX(index), pointY(point)) : context.moveTo(pointX(index), pointY(point)));
  context.stroke();

  // Points
  context.fillStyle = "#ffffff";
  series.forEach((point, index) => {
    context.beginPath();
    context.arc(pointX(index), pointY(point), 3, 0, Math.PI * 2);
    context.fill();
  });

  context.restore();
}

function renderEnvironmentChart(items) {
  const canvas = $("environment-chart");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const width = Math.max(canvas.clientWidth, 280);
  const height = Math.max(canvas.clientHeight, 250);
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  const chronological = [...items].reverse();
  const temperature = chronological.map(item => {
    const val = Number(item.reading ? item.reading.temperature_c : item.temperature_c);
    return { timestamp: item.timestamp || item.time, value: val };
  }).filter(p => Number.isFinite(p.value));

  const humidity = chronological.map(item => {
    const val = Number(item.reading ? item.reading.humidity_pct : item.humidity_pct);
    return { timestamp: item.timestamp || item.time, value: val };
  }).filter(p => Number.isFinite(p.value));

  if (!temperature.length && !humidity.length) {
    context.fillStyle = "#aab3df";
    canvasFont(context, 13);
    context.textAlign = "center";
    context.fillText("No observations available to render", width / 2, height / 2);
    context.textAlign = "start";
    return;
  }

  const left = 48;
  const right = width - 18;
  const gap = 42;
  const topHeight = (height - 66 - gap) / 2;

  if (temperature.length) drawPlot(context, temperature, { left, right, top: 27, bottom: 27 + topHeight }, { color: "#bd7cff", label: "Temperature (°C)", unit: " °C" });
  if (humidity.length) drawPlot(context, humidity, { left, right, top: 27 + topHeight + gap, bottom: height - 39 }, { color: "#4ce8ff", label: "Humidity (%)", unit: "%" });

  const timeline = temperature.length ? temperature : humidity;
  context.fillStyle = "#8692bd";
  canvasFont(context, 10);
  context.textAlign = "center";
  [0, Math.floor((timeline.length - 1) / 2), timeline.length - 1].filter((val, idx, arr) => arr.indexOf(val) === idx).forEach(index => {
    const point = timeline[index];
    const parsedDate = point.timestamp ? new Date(point.timestamp) : null;
    const label = parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : (String(point.timestamp || "—"));
    const x = left + (right - left) * (index / Math.max(timeline.length - 1, 1));
    context.fillText(label, x, height - 15);
  });
  context.textAlign = "start";
}

// ----------------- Main Refresh Flow -----------------

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  setRefreshState(true);
  setDashboardStatus("Synchronizing command center telemetry…", "loading");

  try {
    const [health, historyData] = await Promise.all([
      api("/health").catch(() => null),
      api("/history?limit=30").catch(() => null),
    ]);

    const sensorHealth = health?.sensor_health || null;

    updateConnectionAndSensors(health, sensorHealth);
    updateLiveTelemetryCards(sensorHealth);
    updateSimulatorSandbox(sensorHealth);
    updateAIPredictionsAndDecisions(sensorHealth);
    updatePowerAudit(sensorHealth?.latestRecord);

    if (historyData?.items) {
      lastHistory = historyData.items;
      setText("session-count", lastHistory.length);
      if (activeHistoryTab === "session") {
        renderHistoryList(lastHistory, "session");
        renderEnvironmentChart(lastHistory);
      }
    }

    markSuccessfulUpdate();
    setDashboardStatus("Telemetry synchronized.", "idle");
  } catch (err) {
    setDashboardStatus(`Synchronization failed: ${err.message}`, "error");
  } finally {
    isRefreshing = false;
    setRefreshState(false);
  }
}

// ----------------- History Tabs -----------------

async function setHistoryTab(tab) {
  activeHistoryTab = tab;
  const tabSession = $("tab-session-history");
  const tabDataset = $("tab-dataset-history");
  const rangeBadge = $("history-range-badge");

  if (tab === "session") {
    if (tabSession) tabSession.classList.add("active");
    if (tabDataset) tabDataset.classList.remove("active");
    if (rangeBadge) rangeBadge.textContent = "Range: Current API Session";
    renderHistoryList(lastHistory, "session");
    renderEnvironmentChart(lastHistory);
  } else {
    if (tabSession) tabSession.classList.remove("active");
    if (tabDataset) tabDataset.classList.add("active");
    if (rangeBadge) rangeBadge.textContent = "Range: 2024-06-25 to 2024-07-06 (Excel Source)";
    await loadHistoricalDataset();
  }
}

async function loadHistoricalDataset() {
  if (!cachedDataset) {
    setDashboardStatus("Loading historical Excel baseline dataset…", "loading");
    try {
      cachedDataset = await api("/history/dataset");
    } catch (err) {
      setDashboardStatus(`Failed to load dataset: ${err.message}`, "error");
      return;
    }
  }
  const records = cachedDataset?.records || [];
  renderHistoryList(records, "dataset");
  renderEnvironmentChart(records.slice(0, 40));
  setDashboardStatus("Historical training dataset loaded.", "idle");
}

function renderHistoryList(items, type = "session") {
  const container = $("history-list");
  if (!container) return;
  container.replaceChildren();

  if (!items.length) {
    container.textContent = type === "session"
      ? "No observation telemetry recorded this session."
      : "No historical baseline records found.";
    return;
  }

  const template = $("history-row");
  const isPrivileged = currentUser && (currentUser.role === "admin" || currentUser.role === "operator");

  items.slice(0, 30).forEach(item => {
    let clone;
    if (template && template.content) {
      clone = template.content.cloneNode(true);
    } else {
      const art = document.createElement("article");
      art.className = "history-row";
      art.innerHTML = "<time></time><span class='source'></span><span class='reading'></span><span class='prediction'></span>";
      clone = art;
    }

    const timeEl = clone.querySelector("time");
    const sourceEl = clone.querySelector(".source");
    const readingEl = clone.querySelector(".reading");
    const predEl = clone.querySelector(".prediction");

    if (type === "session") {
      const src = (item.reading?.data_source || "manual").toLowerCase();
      const timeStr = new Date(item.timestamp).toLocaleTimeString();
      if (timeEl) timeEl.textContent = timeStr;

      if (sourceEl) {
        if (src === "esp32") {
          sourceEl.textContent = isPrivileged ? "ESP32 (Hardware)" : "Classroom Sensor";
          sourceEl.className = "source source-esp32";
        } else if (src === "simulated") {
          sourceEl.textContent = "SIMULATED DATA";
          sourceEl.className = "source source-simulated";
        } else {
          sourceEl.textContent = "Calibrated Historical";
          sourceEl.className = "source source-imported";
        }
      }

      const r = item.reading || {};
      if (readingEl) {
        readingEl.textContent = `${valueOrDash(r.occupancy)} occ · ${formatNumber(r.temperature_c, "°C")} · ${formatNumber(r.humidity_pct, "%")} · Board ${r.smart_board_on ? "ON" : "OFF"}`;
      }

      if (predEl) {
        const d = item.decision;
        if (d && d.recommended_fan_count !== null) {
          predEl.textContent = `Forecast: ${d.recommended_fan_count} fans, ${d.recommended_light_count} lights (${d.ai_mode})`;
        } else {
          predEl.textContent = "Forecast: Insufficient data";
        }
      }
    } else {
      // Historical dataset record
      if (timeEl) timeEl.textContent = `${item.date || ""} ${item.time || ""}`;
      if (sourceEl) {
        sourceEl.textContent = "HISTORICAL DATASET";
        sourceEl.className = "source source-imported";
      }
      if (readingEl) {
        readingEl.textContent = `${item.occupancy} occ · ${item.temperature_c}°C · ${item.humidity_pct}% · Fans: ${item.fans_on} · Lights: ${item.lights_on}`;
      }
      if (predEl) {
        predEl.textContent = `Lect: ${item.lecture_code || "—"} · Weather: ${item.weather || "—"}`;
      }
    }

    container.appendChild(clone);
  });
}

// ----------------- Simulator Actions -----------------

async function runSimulatorStep() {
  const token = getStoredToken();
  if (!token) {
    alert("Operator or Administrator authentication required to run simulator.");
    return;
  }
  setDashboardStatus("Executing simulator step…", "loading");
  try {
    const res = await fetch("/simulator/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ count: 1 })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Simulator error: ${err.detail || "Permission denied"}`);
      return;
    }
    await refresh();
  } catch (err) {
    setDashboardStatus(`Simulator execution error: ${err.message}`, "error");
  }
}

async function toggleContinuousSimulator() {
  const token = getStoredToken();
  if (!token) {
    alert("Operator or Administrator authentication required to toggle simulator.");
    return;
  }
  isContinuousSimActive = !isContinuousSimActive;
  try {
    const res = await fetch("/simulator/toggle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ enabled: isContinuousSimActive })
    });
    const pill = $("sim-stream-status");
    const btn = $("btn-toggle-sim-stream");
    if (pill) {
      pill.textContent = isContinuousSimActive ? "Stream: Active (2s interval)" : "Stream: Inactive";
      pill.classList.toggle("is-active", isContinuousSimActive);
    }
    if (btn) {
      btn.textContent = isContinuousSimActive ? "⏹ Stop Continuous Stream" : "▶ Start Continuous Stream";
    }
    await refresh();
  } catch (err) {
    setDashboardStatus(`Failed to toggle continuous simulation: ${err.message}`, "error");
  }
}

// ----------------- Authentication & Role Management -----------------

function getStoredToken() {
  return localStorage.getItem("aieg_auth_token") || sessionStorage.getItem("aieg_auth_token");
}

function clearStoredToken() {
  localStorage.removeItem("aieg_auth_token");
  sessionStorage.removeItem("aieg_auth_token");
}

async function checkAuthSession() {
  const token = getStoredToken();
  if (!token) {
    updateProfileUI(null);
    loadMonitoredRooms();
    return;
  }

  try {
    const res = await fetch("/api/auth/me", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      clearStoredToken();
      updateProfileUI(null);
      loadMonitoredRooms();
      return;
    }
    const data = await res.json();
    currentUser = data.user;
    updateProfileUI(currentUser);
    loadMonitoredRooms();
    if (currentUser && currentUser.role === "admin") {
      loadAdminUsers();
      loadAdminStats();
    }
  } catch (err) {
    console.warn("Session check failed:", err);
    loadMonitoredRooms();
  }
}

function updateProfileUI(user) {
  const emailEl = $("profile-email");
  const roleEl = $("profile-role");
  const avatarEl = $("profile-avatar");
  const actionBtn = $("profile-action-btn");
  const headerBtn = $("header-auth-btn");
  const headerText = $("header-auth-text");

  // Nav items
  const navAdmin = $("nav-admin");
  const navSimulator = $("nav-simulator");
  const navDiagnostics = $("nav-diagnostics");

  // Sections
  const adminPanel = $("admin-panel");
  const simSection = $("simulator-section");
  const diagSection = $("diagnostics-section");
  const topbarRole = $("topbar-role-badge");

  if (user) {
    const isAdmin = user.role === "admin";
    const isOperator = user.role === "operator";

    let roleTitle = "Role: Classroom Occupant";
    let avatarChar = "👤";
    let avatarColor = "var(--green)";

    if (isAdmin) {
      roleTitle = "Role: System Admin";
      avatarChar = "★";
      avatarColor = "var(--pink)";
      if (topbarRole) topbarRole.textContent = "AI ENERGY GUARDIAN · ADMIN CONSOLE";
    } else if (isOperator) {
      roleTitle = "Role: Facility Operator";
      avatarChar = "⚡";
      avatarColor = "var(--cyan)";
      if (topbarRole) topbarRole.textContent = "AI ENERGY GUARDIAN · OPERATOR CONSOLE";
    } else {
      if (topbarRole) topbarRole.textContent = "AI ENERGY GUARDIAN · OCCUPANT VIEW";
    }

    if (emailEl) emailEl.textContent = user.email;
    if (roleEl) roleEl.textContent = roleTitle;
    if (avatarEl) {
      avatarEl.textContent = avatarChar;
      avatarEl.style.color = avatarColor;
    }
    if (actionBtn) {
      actionBtn.textContent = "Sign Out";
      actionBtn.onclick = logoutUser;
    }
    if (headerText) headerText.textContent = "Sign Out";
    if (headerBtn) {
      headerBtn.href = "#";
      headerBtn.onclick = event => { event.preventDefault(); logoutUser(); };
    }

    // Role-based visibility
    if (navAdmin) navAdmin.style.display = isAdmin ? "flex" : "none";
    if (adminPanel) adminPanel.style.display = isAdmin ? "block" : "none";

    if (navSimulator) navSimulator.style.display = (isAdmin || isOperator) ? "flex" : "none";
    if (simSection) simSection.style.display = (isAdmin || isOperator) ? "block" : "none";

    if (navDiagnostics) navDiagnostics.style.display = (isAdmin || isOperator) ? "flex" : "none";
    if (diagSection) diagSection.style.display = (isAdmin || isOperator) ? "block" : "none";

    const diagBadge = $("diag-auth-badge");
    if (diagBadge) diagBadge.textContent = isAdmin ? "Administrator Verified" : "Operator Verified";

    // Hardware Connection Audit panel is restricted to privileged roles
    const deviceStatusSection = $("device-status");
    if (deviceStatusSection) deviceStatusSection.style.display = (isAdmin || isOperator) ? "block" : "none";

    if (isAdmin) {
      setAdminTab("users");
      loadAdminStats();
    }
  } else {
    currentUser = null;
    if (emailEl) emailEl.textContent = "No authenticated session";
    if (roleEl) roleEl.textContent = "Classroom Occupant";
    if (avatarEl) {
      avatarEl.textContent = "◌";
      avatarEl.style.color = "var(--ice)";
    }
    if (actionBtn) {
      actionBtn.textContent = "Sign In";
      actionBtn.onclick = () => { window.location.href = "/login"; };
    }
    if (headerText) headerText.textContent = "Sign In";
    if (headerBtn) {
      headerBtn.href = "/login";
      headerBtn.onclick = null;
    }
    if (topbarRole) topbarRole.textContent = "AI ENERGY GUARDIAN";

    // Non-authenticated users see normal view only
    if (navAdmin) navAdmin.style.display = "none";
    if (adminPanel) adminPanel.style.display = "none";
    if (navSimulator) navSimulator.style.display = "none";
    if (simSection) simSection.style.display = "none";
    if (navDiagnostics) navDiagnostics.style.display = "none";
    if (diagSection) diagSection.style.display = "none";

    const deviceStatusSection = $("device-status");
    if (deviceStatusSection) deviceStatusSection.style.display = "none";
  }
}

async function logoutUser() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (_) {}
  clearStoredToken();
  updateProfileUI(null);
  window.location.reload();
}

async function loadAdminStats() {
  const statsBar = $("admin-stats-bar");
  if (!statsBar) return;
  const token = getStoredToken();
  if (!token) return;

  try {
    const res = await fetch("/api/admin/stats", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (res.ok) {
      const s = await res.json();
      statsBar.innerHTML = `
        <span>👥 Total Users: <strong>${s.totalUsers}</strong></span>
        <span>★ Admins: <strong>${s.adminsCount}</strong></span>
        <span>⚡ Operators: <strong>${s.operatorsCount}</strong></span>
        <span>👤 Occupants: <strong>${s.normalUsersCount}</strong></span>
        <span>💾 Storage: <strong>${s.activeStorage}</strong></span>
      `;
    }
  } catch (_) {}
}

async function loadAdminUsers() {
  const listEl = $("admin-users-list");
  if (!listEl) return;
  const token = getStoredToken();
  if (!token) return;

  try {
    const res = await fetch("/api/admin/users", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      listEl.textContent = "Unable to load users. Administrative privileges required.";
      return;
    }
    const data = await res.json();
    renderAdminUsers(data.users || []);
  } catch (err) {
    listEl.textContent = `Error loading users: ${err.message}`;
  }
}

function renderAdminUsers(users) {
  const listEl = $("admin-users-list");
  if (!listEl) return;
  listEl.replaceChildren();

  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  table.style.fontSize = "0.78rem";
  table.style.textAlign = "left";

  table.innerHTML = `
    <thead>
      <tr style="border-bottom: 1px solid rgba(138, 112, 255, 0.25); color: var(--muted);">
        <th style="padding: 8px 6px;">Email</th>
        <th style="padding: 8px 6px;">Current Role</th>
        <th style="padding: 8px 6px;">Assigned Space</th>
        <th style="padding: 8px 6px;">Created</th>
        <th style="padding: 8px 6px; text-align: right;">Assign Role</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  users.forEach(u => {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid rgba(88, 107, 164, 0.15)";

    const isCurrentAdmin = currentUser && currentUser.email === u.email;
    const roleBadgeClass = u.role === "admin" ? "accent" : "";
    const roleDisplay = u.role === "admin" ? "ADMIN" : u.role === "operator" ? "OPERATOR" : "NORMAL (OCCUPANT)";

    tr.innerHTML = `
      <td style="padding: 10px 6px; color: #ffffff; font-weight: 600;">${u.email}</td>
      <td style="padding: 10px 6px;"><span class="panel-badge ${roleBadgeClass}">${roleDisplay}</span></td>
      <td style="padding: 10px 6px; color: var(--ice);">${u.assignedRoom || "Lab Classroom 101"}</td>
      <td style="padding: 10px 6px; color: var(--muted);">${new Date(u.createdAt).toLocaleDateString()}</td>
      <td style="padding: 10px 6px; text-align: right;">
        <select class="role-select" style="background: rgba(10, 14, 34, 0.9); border: 1px solid rgba(138, 112, 255, 0.35); color: #fff; padding: 4px 8px; border-radius: 6px; font: inherit; font-size: 0.72rem; cursor: pointer;" ${isCurrentAdmin ? 'disabled title="Cannot modify own role"' : ''}>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          <option value="operator" ${u.role === 'operator' ? 'selected' : ''}>Operator</option>
          <option value="occupant" ${u.role === 'occupant' || u.role === 'user' ? 'selected' : ''}>Normal User (Occupant)</option>
        </select>
      </td>
    `;

    const select = tr.querySelector(".role-select");
    if (!isCurrentAdmin) {
      select.addEventListener("change", async () => {
        const token = getStoredToken();
        const newRole = select.value;
        select.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${u.id}/role`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ role: newRole })
          });
          if (res.ok) {
            loadAdminUsers();
            loadAdminStats();
          } else {
            alert("Failed to update role: Permission denied or invalid request.");
            loadAdminUsers();
          }
        } finally {
          select.disabled = false;
        }
      });
    }

    tbody.appendChild(tr);
  });

  listEl.appendChild(table);
}

function setAdminTab(tab) {
  const tabs = ["users", "ml", "audit", "settings"];
  tabs.forEach(t => {
    const btn = $(`admin-tab-${t}`);
    const content = $(`admin-tab-content-${t}`);
    const isActive = t === tab;
    if (btn) btn.classList.toggle("active", isActive);
    if (content) content.style.display = isActive ? "block" : "none";
  });

  if (tab === "users") loadAdminUsers();
  else if (tab === "ml") loadAdminMLStatus();
  else if (tab === "audit") loadAdminAuditLogs();
  else if (tab === "settings") loadAdminSettings();
}

async function loadAdminMLStatus() {
  const container = $("admin-ml-content");
  if (!container) return;
  const token = getStoredToken();
  if (!token) return;
  try {
    const res = await fetch("/api/admin/ml-status", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      container.textContent = "Unable to load ML model status.";
      return;
    }
    const data = await res.json();
    container.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 16px;">
        ${data.models.map(m => `
          <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <strong style="color: #fff; font-size: 0.82rem;">${m.name}</strong>
              <span class="panel-badge accent" style="font-size: 0.65rem;">${m.version}</span>
            </div>
            <p style="margin: 0 0 6px; font-size: 0.72rem; color: var(--ice);">${m.type}</p>
            <p style="margin: 0; font-size: 0.68rem; color: var(--muted);">${m.purpose}</p>
          </div>
        `).join("")}
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
        <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
          <strong style="color: var(--cyan); font-size: 0.8rem; display: block; margin-bottom: 6px;">Calibrated Training Baseline</strong>
          <ul style="margin: 0; padding-left: 18px; font-size: 0.72rem; color: var(--ice); line-height: 1.6;">
            <li>Source: <strong>${data.training_baseline.source}</strong></li>
            <li>Records: <strong>${data.training_baseline.record_count} observations</strong></li>
            <li>Date Range: <strong>${data.training_baseline.date_range}</strong></li>
            <li>Data Quality Score: <strong>${data.training_baseline.quality_score}</strong></li>
          </ul>
        </div>
        <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
          <strong style="color: var(--pink); font-size: 0.8rem; display: block; margin-bottom: 6px;">Data Quality Enforcement Guardrails</strong>
          <ul style="margin: 0; padding-left: 18px; font-size: 0.72rem; color: var(--ice); line-height: 1.5;">
            ${data.data_quality_enforcement.map(r => `<li>${r}</li>`).join("")}
          </ul>
        </div>
      </div>

      <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px; font-size: 0.75rem;">
        <span style="color: var(--muted);">Prediction Telemetry & Inferences:</span>
        <strong style="color: #fff; margin-left: 6px;">${data.prediction_telemetry.total_predictions_stored} decisions processed</strong> ·
        <span style="color: var(--ice);">Status: <strong>${data.prediction_telemetry.latest_prediction_status}</strong></span> ·
        <span style="color: var(--muted);">Latest reasoning: <em>${data.prediction_telemetry.latest_reason}</em></span>
      </div>
    `;
  } catch (err) {
    container.textContent = `Error loading ML status: ${err.message}`;
  }
}

async function loadAdminAuditLogs() {
  const container = $("admin-audit-content");
  if (!container) return;
  const token = getStoredToken();
  if (!token) return;
  try {
    const res = await fetch("/api/admin/audit-logs", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      container.textContent = "Unable to load audit logs.";
      return;
    }
    const data = await res.json();
    const logs = data.audit_logs || [];
    if (!logs.length) {
      container.textContent = "No audit log entries recorded.";
      return;
    }
    container.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.74rem; text-align: left;">
        <thead>
          <tr style="border-bottom: 1px solid rgba(138, 112, 255, 0.25); color: var(--muted);">
            <th style="padding: 6px 8px;">Timestamp</th>
            <th style="padding: 6px 8px;">Action</th>
            <th style="padding: 6px 8px;">Actor</th>
            <th style="padding: 6px 8px;">Details</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(log => `
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <td style="padding: 8px; color: var(--muted);">${new Date(log.timestamp).toLocaleTimeString()}</td>
              <td style="padding: 8px; font-weight: 700; color: var(--cyan);">${log.action}</td>
              <td style="padding: 8px; color: var(--ice);">${log.actor || 'System'}</td>
              <td style="padding: 8px; color: #fff;">${log.details}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.textContent = `Error loading audit logs: ${err.message}`;
  }
}

async function loadAdminSettings() {
  const container = $("admin-settings-content");
  if (!container) return;
  const token = getStoredToken();
  if (!token) return;
  try {
    const res = await fetch("/api/admin/settings", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      container.textContent = "Unable to load settings.";
      return;
    }
    const s = await res.json();
    container.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 16px;">
        <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
          <span style="font-size: 0.68rem; color: var(--muted); text-transform: uppercase;">Configured Hardware ID</span>
          <strong style="display: block; font-size: 0.95rem; color: #fff; margin-top: 4px;">${s.configured_device_id}</strong>
        </div>
        <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
          <span style="font-size: 0.68rem; color: var(--muted); text-transform: uppercase;">Stale Timeout Threshold</span>
          <strong style="display: block; font-size: 0.95rem; color: #fff; margin-top: 4px;">${s.stale_threshold_seconds} seconds</strong>
        </div>
        <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
          <span style="font-size: 0.68rem; color: var(--muted); text-transform: uppercase;">Active Storage Engine</span>
          <strong style="display: block; font-size: 0.95rem; color: #fff; margin-top: 4px;">${s.storage_engine}</strong>
        </div>
        <div style="background: rgba(12, 14, 32, 0.7); border: 1px solid rgba(138, 112, 255, 0.25); border-radius: 8px; padding: 12px;">
          <span style="font-size: 0.68rem; color: var(--muted); text-transform: uppercase;">Power Meter Requirement</span>
          <strong style="display: block; font-size: 0.95rem; color: var(--green); margin-top: 4px;">Enforced (Zero-Fabrication)</strong>
        </div>
      </div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <button id="btn-export-report" type="button" class="sim-btn" style="background: linear-gradient(135deg, #7141dd, #22a2bb);">📊 Export System Audit Report (JSON)</button>
        <span id="report-export-status" style="font-size: 0.74rem; color: var(--muted);"></span>
      </div>
    `;

    const exportBtn = $("btn-export-report");
    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        const reportStatus = $("report-export-status");
        if (reportStatus) reportStatus.textContent = "Generating report…";
        const diagData = await api("/api/diagnostics").catch(() => ({}));
        const blob = new Blob([JSON.stringify({ generated_at: new Date().toISOString(), settings: s, diagnostics: diagData }, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `ai-energy-guardian-report-${Date.now()}.json`;
        a.click();
        if (reportStatus) reportStatus.textContent = "Report downloaded successfully.";
      });
    }
  } catch (err) {
    container.textContent = `Error loading settings: ${err.message}`;
  }
}

function toggleNavigation() {
  const sidebar = $("sidebar");
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle("is-open");
  const menuToggle = $("menu-toggle");
  if (menuToggle) menuToggle.setAttribute("aria-expanded", String(isOpen));
}

// ----------------- Appliance Wattage Configuration & Interactive Tester -----------------

let currentWattageConfig = null;

async function loadPowerConfig() {
  try {
    const data = await api("/api/power/config");
    currentWattageConfig = data?.config;
    if (currentWattageConfig) {
      const fanIn = $("cfg-fan-watts");
      const lightIn = $("cfg-light-watts");
      const boardIn = $("cfg-board-watts");
      const rateIn = $("cfg-rate");
      const hoursIn = $("cfg-hours");

      if (fanIn) fanIn.value = currentWattageConfig.fan_watts;
      if (lightIn) lightIn.value = currentWattageConfig.light_watts;
      if (boardIn) boardIn.value = currentWattageConfig.smart_board_watts;
      if (rateIn) rateIn.value = currentWattageConfig.electricity_rate_per_kwh;
      if (hoursIn) hoursIn.value = currentWattageConfig.operating_hours_per_day;

      updatePresetButtons(currentWattageConfig.fan_watts, currentWattageConfig.light_watts);
    }
  } catch (_) {}
}

function updatePresetButtons(fanWatts, lightWatts) {
  const pClassroom = $("preset-classroom");
  const pBench = $("preset-bench");
  if (pClassroom && pBench) {
    if (Math.abs(fanWatts - 75) < 1 && Math.abs(lightWatts - 28) < 1) {
      pClassroom.classList.add("active");
      pBench.classList.remove("active");
    } else if (Math.abs(fanWatts - 5) < 1 && Math.abs(lightWatts - 2) < 1) {
      pClassroom.classList.remove("active");
      pBench.classList.add("active");
    } else {
      pClassroom.classList.remove("active");
      pBench.classList.remove("active");
    }
  }
}

async function saveWattageConfig(updates) {
  const token = getStoredToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch("/api/power/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Could not save wattage config: ${err.detail || "Error"}`);
      return;
    }
    const data = await res.json();
    currentWattageConfig = data.config;
    updatePresetButtons(currentWattageConfig.fan_watts, currentWattageConfig.light_watts);
    await refresh();
  } catch (err) {
    alert(`Failed to save wattage config: ${err.message}`);
  }
}

async function saveClassroomConfig() {
  const token = getStoredToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const payload = {
    fans_qty: parseInt($("cr-cfg-fans-qty")?.value || "5", 10),
    fan_watts: parseFloat($("cr-cfg-fan-watts")?.value || "75"),
    lights_qty: parseInt($("cr-cfg-lights-qty")?.value || "8", 10),
    light_watts: parseFloat($("cr-cfg-light-watts")?.value || "28"),
    smart_board_watts: parseFloat($("cr-cfg-board-watts")?.value || "150"),
    electricity_rate_per_kwh: parseFloat($("cr-cfg-rate")?.value || "8.5"),
    operating_hours_per_day: parseFloat($("cr-cfg-hours")?.value || "8"),
    operating_days_per_month: parseInt($("cr-cfg-days")?.value || "22", 10),
  };

  const statusEl = $("cr-save-status");
  if (statusEl) statusEl.textContent = "Saving…";

  try {
    const res = await fetch("/api/reports/classroom/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (statusEl) {
        statusEl.textContent = `Error: ${err.detail || "Save failed"}`;
        statusEl.style.color = "var(--pink)";
      }
      return;
    }
    if (statusEl) {
      statusEl.textContent = "Classroom configuration saved.";
      statusEl.style.color = "var(--green)";
      setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
    }
    await refresh();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = "var(--pink)";
    }
  }
}

async function savePrototypeConfig() {
  const token = getStoredToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const payload = {
    mini_fan_qty: parseInt($("pr-cfg-fan-qty")?.value || "1", 10),
    mini_fan_watts: parseFloat($("pr-cfg-fan-watts")?.value || "5"),
    led_light_qty: parseInt($("pr-cfg-light-qty")?.value || "1", 10),
    led_light_watts: parseFloat($("pr-cfg-light-watts")?.value || "2"),
    lcd_display_qty: parseInt($("pr-cfg-lcd-qty")?.value || "1", 10),
    lcd_display_watts: parseFloat($("pr-cfg-lcd-watts")?.value || "2.5"),
    electricity_rate_per_kwh: parseFloat($("pr-cfg-rate")?.value || "8.5"),
    operating_hours_per_day: parseFloat($("pr-cfg-hours")?.value || "8"),
  };

  const statusEl = $("pr-save-status");
  if (statusEl) statusEl.textContent = "Saving…";

  try {
    const res = await fetch("/api/reports/prototype/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (statusEl) {
        statusEl.textContent = `Error: ${err.detail || "Save failed"}`;
        statusEl.style.color = "var(--pink)";
      }
      return;
    }
    if (statusEl) {
      statusEl.textContent = "Prototype configuration saved.";
      statusEl.style.color = "var(--green)";
      setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 3000);
    }
    await refresh();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = "var(--pink)";
    }
  }
}

function initPowerControls() {
  const tabCr = $("tab-report-classroom");
  const tabPr = $("tab-report-prototype");
  const tabPh = $("tab-report-physical");

  if (tabCr) tabCr.addEventListener("click", () => setReportTab("classroom"));
  if (tabPr) tabPr.addEventListener("click", () => setReportTab("prototype"));
  if (tabPh) tabPh.addEventListener("click", () => setReportTab("physical"));

  const btnSaveCr = $("btn-save-classroom-cfg");
  if (btnSaveCr) btnSaveCr.addEventListener("click", saveClassroomConfig);

  const btnSavePr = $("btn-save-prototype-cfg");
  if (btnSavePr) btnSavePr.addEventListener("click", savePrototypeConfig);

  const btnClassroom = $("preset-classroom");
  const btnBench = $("preset-bench");
  const btnSave = $("btn-save-wattage");

  if (btnClassroom) {
    btnClassroom.addEventListener("click", () => {
      const fanIn = $("cfg-fan-watts");
      const lightIn = $("cfg-light-watts");
      if (fanIn) fanIn.value = "75";
      if (lightIn) lightIn.value = "28";
      saveWattageConfig({ fan_watts: 75, light_watts: 28 });
    });
  }

  if (btnBench) {
    btnBench.addEventListener("click", () => {
      const fanIn = $("cfg-fan-watts");
      const lightIn = $("cfg-light-watts");
      if (fanIn) fanIn.value = "5";
      if (lightIn) lightIn.value = "2";
      saveWattageConfig({ fan_watts: 5, light_watts: 2 });
    });
  }

  if (btnSave) {
    btnSave.addEventListener("click", () => {
      const fanWatts = parseFloat($("cfg-fan-watts")?.value || "75");
      const lightWatts = parseFloat($("cfg-light-watts")?.value || "28");
      const boardWatts = parseFloat($("cfg-board-watts")?.value || "150");
      const rate = parseFloat($("cfg-rate")?.value || "8.5");
      const hours = parseFloat($("cfg-hours")?.value || "8");

      saveWattageConfig({
        fan_watts: fanWatts,
        light_watts: lightWatts,
        smart_board_watts: boardWatts,
        electricity_rate_per_kwh: rate,
        operating_hours_per_day: hours,
      });
    });
  }
}

function initRecommendationTester() {
  const btnTest = $("btn-run-rec-test");
  if (!btnTest) return;

  btnTest.addEventListener("click", async () => {
    const occ = parseInt($("test-occupancy")?.value || "25", 10);
    const temp = parseFloat($("test-temp")?.value || "27.5");
    const hum = parseFloat($("test-humidity")?.value || "60");
    const board = $("test-board")?.value === "true";
    const fans = parseInt($("test-fans-on")?.value || "5", 10);
    const lights = parseInt($("test-lights-on")?.value || "8", 10);

    try {
      const res = await fetch("/api/recommendation/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          occupancy: occ,
          temperature_c: temp,
          humidity_pct: hum,
          smart_board_on: board,
          no_of_fans_on: fans,
          no_of_lights_on: lights,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Validation error: ${err.detail || "Invalid input"}`);
        return;
      }

      const data = await res.json();
      const card = $("rec-test-result");
      if (card) card.style.display = "block";

      setText("test-result-mode", data.recommendation.mode);
      setText("test-result-reason", data.recommendation.reason);
      setText("test-result-fans", `${data.recommendation.fan_count} fans`);
      setText("test-result-lights", `${data.recommendation.light_count} lights`);
      setText("test-result-baseline", `${data.power_breakdown.baseline_power_w} W`);
      setText("test-result-optimized", `${data.power_breakdown.ai_recommended_power_w} W`);
      setText("test-result-saved", `${data.power_breakdown.power_saved_w} W (-${data.power_breakdown.savings_percentage}%)`);
      setText("test-result-cost", `₹${data.power_breakdown.monthly_cost_saved.toFixed(2)} / mo`);
    } catch (err) {
      alert(`Testing error: ${err.message}`);
    }
  });
}

// ----------------- Initialization & Event Listeners -----------------

if ($("refresh")) $("refresh").addEventListener("click", refresh);
if ($("refresh-top")) $("refresh-top").addEventListener("click", refresh);
if ($("menu-toggle")) $("menu-toggle").addEventListener("click", toggleNavigation);
if ($("tab-session-history")) $("tab-session-history").addEventListener("click", () => setHistoryTab("session"));
if ($("tab-dataset-history")) $("tab-dataset-history").addEventListener("click", () => setHistoryTab("dataset"));
if ($("btn-run-sim-step")) $("btn-run-sim-step").addEventListener("click", runSimulatorStep);
if ($("btn-toggle-sim-stream")) $("btn-toggle-sim-stream").addEventListener("click", toggleContinuousSimulator);

if ($("admin-tab-users")) $("admin-tab-users").addEventListener("click", () => setAdminTab("users"));
if ($("admin-tab-ml")) $("admin-tab-ml").addEventListener("click", () => setAdminTab("ml"));
if ($("admin-tab-audit")) $("admin-tab-audit").addEventListener("click", () => setAdminTab("audit"));
if ($("admin-tab-settings")) $("admin-tab-settings").addEventListener("click", () => setAdminTab("settings"));

window.addEventListener("resize", () => {
  if (activeHistoryTab === "session") renderEnvironmentChart(lastHistory);
  else if (cachedDataset) renderEnvironmentChart(cachedDataset.records || []);
});

initPowerControls();
initRecommendationTester();
loadPowerConfig();
checkAuthSession();
refresh();
setInterval(refresh, 10000);

