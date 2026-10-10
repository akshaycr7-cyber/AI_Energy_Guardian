const $ = id => document.getElementById(id);
const api = path => fetch(path).then(async response => {
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch (_) { /* Use safe status text. */ }
    throw new Error(detail);
  }
  return response.json();
});

let lastHistory = [];
let isRefreshing = false;

function setText(id, value) { $(id).textContent = value; }
function valueOrDash(value) { return value === undefined || value === null || value === "" ? "—" : value; }
function formatNumber(value, suffix = "") { return value === undefined || value === null || value === "" ? "—" : `${value}${suffix}`; }
function refreshButtons() { return [$("refresh"), $("refresh-top")].filter(Boolean); }

function setRefreshState(isLoading) {
  document.body.classList.toggle("is-loading", isLoading);
  refreshButtons().forEach(button => { button.disabled = isLoading; });
}

function updateSystemMeta(health, items) {
  setText("sidebar-status", health?.status ? `API ${health.status}` : "API unavailable");
  const source = items?.[0]?.sensor_data_status?.kind;
  const storage = health?.storage;
  setText("data-source", source ? `Source: ${source} · ${storage || "storage unavailable"}` : `Source: none · ${storage || "storage unavailable"}`);
}

function markSuccessfulUpdate() {
  const updatedAt = new Date();
  const time = $("last-update");
  time.dateTime = updatedAt.toISOString();
  time.textContent = updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setDashboardStatus(message, state) {
  const status = $("dashboard-status");
  status.dataset.state = state;
  status.lastElementChild.textContent = message;
}

function clearLatest(message = "No data received.") {
  ["occupancy", "temperature", "humidity", "board", "fans", "lights", "recommended-fans", "recommended-lights"].forEach(id => setText(id, "—"));
  setText("recommendation", "No recommendation available.");
  setText("recommendation-evidence", "No decision evidence available.");
  setText("ai-mode", "Awaiting sensor data");
  setText("model-status", "Insufficient data");
  setText("sensor-status", message);
}

function latest(item) {
  const reading = item.reading || {};
  const prediction = item.prediction || {};
  const decision = item.decision || {};
  setText("occupancy", valueOrDash(reading.occupancy));
  setText("temperature", formatNumber(reading.temperature_c, " °C"));
  setText("humidity", formatNumber(reading.humidity_pct, " %"));
  setText("board", reading.smart_board_on === true ? "ON" : reading.smart_board_on === false ? "OFF" : "—");
  setText("fans", valueOrDash(prediction.predicted_fan_count));
  setText("lights", valueOrDash(prediction.predicted_light_count));
  setText("recommended-fans", valueOrDash(decision.recommended_fan_count));
  setText("recommended-lights", valueOrDash(decision.recommended_light_count));
  setText("recommendation", decision.reason || "No recommendation available.");
  setText("recommendation-evidence", decision.reason || "No decision evidence available.");
  setText("ai-mode", decision.ai_mode || "Awaiting sensor data");
  setText("model-status", prediction.predicted_fan_count === undefined || prediction.predicted_light_count === undefined ? "Model unavailable" : "Recommendation available");
  setText("sensor-status", item.sensor_data_status?.message || "Data provenance was not provided.");
}

function recordAge(timestamp) {
  const then = new Date(timestamp).getTime();
  return Number.isFinite(then) ? Date.now() - then : null;
}

function latestStatus(item) {
  const age = recordAge(item.timestamp);
  if (age === null) return ["Latest record received; its timestamp is unavailable.", "ready"];
  if (age > 120000) return ["Latest record is over two minutes old. Values may be stale.", "stale"];
  return ["Latest record loaded from the API.", "ready"];
}

function showHistory(items) {
  const container = $("history-list");
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "No history is available yet. Send an evaluation to the API to populate this view.";
    container.append(empty);
    return;
  }
  items.forEach(item => {
    const fragment = $("history-row").content.cloneNode(true);
    const reading = item.reading || {};
    const prediction = item.prediction || {};
    const time = fragment.querySelector("time");
    const parsedTime = new Date(item.timestamp);
    time.dateTime = Number.isNaN(parsedTime.getTime()) ? "" : parsedTime.toISOString();
    time.textContent = Number.isNaN(parsedTime.getTime()) ? "Timestamp unavailable" : parsedTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    fragment.querySelector(".source").textContent = (item.sensor_data_status?.kind || "unknown").toUpperCase();
    fragment.querySelector(".reading").textContent = `Measured / supplied: ${formatNumber(reading.temperature_c, " °C")}, ${formatNumber(reading.humidity_pct, " %")}, occupancy ${valueOrDash(reading.occupancy)}`;
    fragment.querySelector(".prediction").textContent = `Model: fans ${valueOrDash(prediction.predicted_fan_count)}, lights ${valueOrDash(prediction.predicted_light_count)}`;
    container.append(fragment);
  });
}

function canvasFont(context, size, weight = "400") { context.font = `${weight} ${size}px Inter, Segoe UI, sans-serif`; }
function numericSeries(items, key) { return items.map(item => ({ timestamp: item.timestamp, value: Number(item.reading?.[key]) })).filter(point => Number.isFinite(point.value)); }

function drawPlot(context, series, bounds, { color, label, unit }) {
  const { left, right, top, bottom } = bounds;
  const width = right - left;
  const height = bottom - top;
  const values = series.map(point => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = Math.max((high - low) * 0.1, 1);
  const min = low - padding;
  const max = high + padding;
  const range = max - min || 1;
  context.strokeStyle = "#273f70";
  context.lineWidth = 1;
  context.fillStyle = "#aab3df";
  canvasFont(context, 10);
  for (let index = 0; index < 4; index += 1) {
    const y = top + (height * index / 3);
    const value = max - (range * index / 3);
    context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
    context.fillText(`${value.toFixed(1)}${unit}`, 4, y + 3);
  }
  context.fillStyle = color;
  canvasFont(context, 11, "700");
  context.fillText(label, left, top - 8);
  const pointX = index => left + width * (index / Math.max(series.length - 1, 1));
  const pointY = point => bottom - ((point.value - min) / range) * height;
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.beginPath();
  series.forEach((point, index) => index ? context.lineTo(pointX(index), pointY(point)) : context.moveTo(pointX(index), pointY(point)));
  context.stroke();
  context.fillStyle = color;
  series.forEach((point, index) => { context.beginPath(); context.arc(pointX(index), pointY(point), 3, 0, Math.PI * 2); context.fill(); });
}

function chart(items) {
  const canvas = $("environment-chart");
  const context = canvas.getContext("2d");
  const width = Math.max(canvas.clientWidth, 280);
  const height = Math.max(canvas.clientHeight, 250);
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  const chronological = [...items].reverse();
  const temperature = numericSeries(chronological, "temperature_c");
  const humidity = numericSeries(chronological, "humidity_pct");
  if (!temperature.length && !humidity.length) {
    context.fillStyle = "#aab3df";
    canvasFont(context, 13);
    context.textAlign = "center";
    context.fillText("No temperature or humidity history available", width / 2, height / 2);
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
  [0, Math.floor((timeline.length - 1) / 2), timeline.length - 1].filter((value, index, list) => list.indexOf(value) === index).forEach(index => {
    const point = timeline[index];
    const date = new Date(point.timestamp);
    const label = Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const x = left + (right - left) * (index / Math.max(timeline.length - 1, 1));
    context.fillText(label, x, height - 15);
  });
  context.textAlign = "start";
}

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  setRefreshState(true);
  setDashboardStatus("Refreshing dashboard data…", "loading");
  try {
    const [health, data] = await Promise.all([api("/health"), api("/history?limit=20")]);
    setText("connection", `API ${health.status}`);
    $("connection").dataset.status = "ok";
    lastHistory = Array.isArray(data.items) ? data.items : [];
    updateSystemMeta(health, lastHistory);
    markSuccessfulUpdate();
    showHistory(lastHistory);
    chart(lastHistory);
    if (lastHistory[0]) {
      latest(lastHistory[0]);
      const [message, state] = latestStatus(lastHistory[0]);
      setDashboardStatus(message, state);
    } else {
      clearLatest("No sensor data has been received.");
      setDashboardStatus("The API is available, but no history has been recorded yet.", "empty");
    }
  } catch (error) {
    lastHistory = [];
    clearLatest("Current sensor data is unavailable because the latest request failed.");
    showHistory([]);
    chart([]);
    setText("connection", "API unavailable");
    $("connection").dataset.status = "error";
    updateSystemMeta(null, []);
    setDashboardStatus(`Unable to load current data: ${error.message}. Displayed readings were cleared.`, "error");
  } finally {
    isRefreshing = false;
    setRefreshState(false);
  }
}

function toggleNavigation() {
  const sidebar = $("sidebar");
  const isOpen = sidebar.classList.toggle("is-open");
  $("menu-toggle").setAttribute("aria-expanded", String(isOpen));
}

$("refresh").addEventListener("click", refresh);
$("refresh-top").addEventListener("click", refresh);
$("menu-toggle").addEventListener("click", toggleNavigation);
window.addEventListener("resize", () => chart(lastHistory));
refresh();
setInterval(refresh, 10000);
