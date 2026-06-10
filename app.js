const phases = ["Todos", "Grupo A", "Grupo B", "Grupo C", "Grupo D", "Grupo E", "Grupo F", "Grupo G", "Grupo H", "Grupo I", "Grupo J", "Grupo K", "Grupo L"];

let state = {
  user: null,
  matches: [],
  picks: {},
  leaderboard: [],
  settings: {}
};

const matchesEl = document.querySelector("#matches");
const template = document.querySelector("#matchTemplate");
const phaseFilter = document.querySelector("#phaseFilter");
const searchBox = document.querySelector("#searchBox");
const loginName = document.querySelector("#loginName");
const loginPassword = document.querySelector("#loginPassword");
const apiUrl = document.querySelector("#apiUrl");
const autoRefresh = document.querySelector("#autoRefresh");
const message = document.querySelector("#appMessage");
const authMessage = document.querySelector("#authMessage");
const authScreen = document.querySelector("#authScreen");
const appShell = document.querySelector(".shell");
let autoRefreshTimer = null;

phases.forEach((phase) => {
  const option = document.createElement("option");
  option.value = phase;
  option.textContent = phase;
  phaseFilter.append(option);
});

document.querySelector("#authForm").addEventListener("submit", (event) => {
  event.preventDefault();
  auth("login");
});
document.querySelector("#registerButton").addEventListener("click", () => auth("register"));
document.querySelector("#logoutButton").addEventListener("click", logout);
document.querySelector("#saveApi").addEventListener("click", saveSettings);
document.querySelector("#refreshResults").addEventListener("click", refreshResults);
document.querySelector("#exportData").addEventListener("click", exportData);
phaseFilter.addEventListener("change", render);
searchBox.addEventListener("input", render);
autoRefresh.addEventListener("change", setupAutoRefresh);
loginPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") auth("login");
});

loadState();

async function loadState() {
  try {
    state = await request("/api/state");
    apiUrl.value = state.settings.resultsUrl || "";
    render();
  } catch (error) {
    showMessage(`No pude conectar con el servidor: ${error.message}`, true);
  }
}

async function auth(mode) {
  const username = loginName.value.trim();
  const password = loginPassword.value;
  if (!username || !password) {
    showMessage("Escribe usuario y contrasena.", true, true);
    return;
  }

  try {
    const result = await request(`/api/${mode}`, {
      method: "POST",
      body: { username, password }
    });
    state.user = result.user;
    loginName.value = "";
    loginPassword.value = "";
    await loadState();
    showMessage(mode === "register" ? "Cuenta creada." : "Sesion iniciada.");
  } catch (error) {
    showMessage(error.message, true, true);
  }
}

async function logout() {
  await request("/api/logout", { method: "POST" });
  state.user = null;
  await loadState();
  showMessage("Sesion cerrada.");
}

function render() {
  const user = state.user;
  const isAdmin = Boolean(user?.isAdmin);
  authScreen.hidden = Boolean(user);
  appShell.hidden = !user;
  document.body.classList.toggle("is-admin", isAdmin);
  document.querySelector("#activePlayerLabel").textContent = user ? `${user.name}${isAdmin ? " · admin" : ""}` : "Sin sesion";
  document.querySelector("#playerCount").textContent = `${state.leaderboard.length} jugadores`;
  document.querySelector("#lastSync").textContent = state.settings.lastSync ? `Actualizado ${state.settings.lastSync}` : "Sin refrescar";

  matchesEl.replaceChildren();
  const query = searchBox.value.trim().toLowerCase();
  const selectedPhase = phaseFilter.value || "Todos";
  const filtered = state.matches.filter((match) => {
    const phaseOk = selectedPhase === "Todos" || match.phase.endsWith(selectedPhase);
    const text = `${match.home} ${match.away} ${match.venue}`.toLowerCase();
    return phaseOk && text.includes(query);
  });

  let currentDate = "";
  filtered.forEach((match) => {
    if (match.date !== currentDate) {
      currentDate = match.date;
      matchesEl.append(renderDateDivider(match.date));
    }
    matchesEl.append(renderMatch(match, user, isAdmin));
  });
  renderLeaderboard();
  updateSummary(filtered);
}

function renderMatch(match, user, isAdmin) {
  const node = template.content.firstElementChild.cloneNode(true);
  const pick = state.picks[match.id] || { home: "", away: "", outcome: "" };

  node.querySelector(".dateText").textContent = formatDate(match.date);
  node.querySelector(".phaseText").textContent = match.phase.replace("Primera ronda - ", "");
  node.querySelector(".homeText").textContent = match.home;
  node.querySelector(".awayText").textContent = match.away;

  bindOutcomeButtons(node, match.id, pick, !user);
  bindPick(node, ".pickHome", match.id, pick, "home", !user);
  bindPick(node, ".pickAway", match.id, pick, "away", !user);
  bindAdminNumber(node, ".realHome", match, "realHome", isAdmin);
  bindAdminNumber(node, ".realAway", match, "realAway", isAdmin);

  node.querySelector(".points").textContent = `${scoreMatch(match, pick)} pts`;

  return node;
}

function bindAdminText(node, selector, match, key, isAdmin) {
  const input = node.querySelector(selector);
  input.value = match[key];
  input.disabled = !isAdmin;
  input.addEventListener("change", () => updateMatch(match.id, { [key]: input.value }));
}

function bindAdminNumber(node, selector, match, key, isAdmin) {
  const input = node.querySelector(selector);
  input.value = match[key];
  input.disabled = !isAdmin;
  input.addEventListener("change", () => updateMatch(match.id, { [key]: cleanNumber(input.value) }));
}

function bindPick(node, selector, matchId, pick, key, locked) {
  const input = node.querySelector(selector);
  input.value = pick[key] ?? "";
  input.disabled = locked;
  input.placeholder = locked ? "Login" : "";
  input.addEventListener("change", async () => {
    state.picks[matchId] ||= { home: "", away: "", outcome: "" };
    state.picks[matchId][key] = cleanNumber(input.value);
    await request(`/api/picks/${matchId}`, {
      method: "PATCH",
      body: state.picks[matchId]
    });
    await loadState();
  });
}

function bindOutcomeButtons(node, matchId, pick, locked) {
  const current = pickOutcome(pick);
  node.querySelectorAll(".pickOutcome").forEach((button) => {
    button.disabled = locked;
    button.classList.toggle("selected", button.dataset.outcome === current);
    button.addEventListener("click", async () => {
      const nextPick = {
        home: pick.home ?? "",
        away: pick.away ?? "",
        outcome: button.dataset.outcome
      };
      state.picks[matchId] = nextPick;
      await request(`/api/picks/${matchId}`, {
        method: "PATCH",
        body: nextPick
      });
      await loadState();
    });
  });
}

function pickOutcome(pick) {
  if (pick.outcome) return pick.outcome;
  if (pick.home === "" || pick.away === "" || pick.home === undefined || pick.away === undefined) return "";
  return outcome(Number(pick.home), Number(pick.away));
}

async function updateMatch(matchId, patch) {
  try {
    await request(`/api/matches/${matchId}`, { method: "PATCH", body: patch });
    await loadState();
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function saveSettings() {
  try {
    await request("/api/settings", {
      method: "PATCH",
      body: { resultsUrl: apiUrl.value.trim() }
    });
    setupAutoRefresh();
    await loadState();
    showMessage("Configuracion guardada.");
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function refreshResults(silent = false) {
  const url = apiUrl.value.trim() || state.settings.resultsUrl;
  if (!url) {
    if (!silent) showMessage("Primero agrega una URL de resultados.", true);
    return;
  }

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const incoming = normalizeResults(payload);
    let updated = 0;

    for (const result of incoming) {
      const match = findMatch(result);
      if (!match) continue;
      await request(`/api/matches/${match.id}`, {
        method: "PATCH",
        body: {
          home: result.home || match.home,
          away: result.away || match.away,
          date: result.date || match.date,
          venue: result.venue || match.venue,
          realHome: result.realHome,
          realAway: result.realAway
        }
      });
      updated += 1;
    }

    await loadState();
    if (!silent) showMessage(`Resultados actualizados: ${updated} partidos.`);
  } catch (error) {
    if (!silent) showMessage(`No pude refrescar resultados: ${error.message}`, true);
  }
}

function setupAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
  if (!autoRefresh.checked) return;
  autoRefreshTimer = setInterval(() => refreshResults(true), 5 * 60 * 1000);
}

function renderLeaderboard() {
  const board = document.querySelector("#leaderboard");
  board.replaceChildren();

  state.leaderboard.forEach((player) => {
    const item = document.createElement("li");
    item.className = state.user?.id === player.id ? "active" : "";
    item.innerHTML = `<span>${escapeHtml(player.name)}${player.isAdmin ? " · admin" : ""}</span><strong>${player.points} pts</strong><small>${player.exact} exactos · ${player.trend} tendencia</small>`;
    board.append(item);
  });
}

function updateSummary(matches) {
  const me = state.leaderboard.find((player) => player.id === state.user?.id);
  document.querySelector("#playerScore").textContent = `${me?.points || 0} pts`;
  document.querySelector("#exactCount").textContent = me?.exact || 0;
  document.querySelector("#trendCount").textContent = me?.trend || 0;
  document.querySelector("#matchCount").textContent = matches.length;
}

function scoreMatch(match, pick) {
  const values = [pick.home, pick.away, match.realHome, match.realAway];
  if (match.realHome === "" || match.realAway === "" || match.realHome === null || match.realAway === null) return 0;
  const rh = Number(match.realHome);
  const ra = Number(match.realAway);
  const hasScore = ![pick.home, pick.away].some((value) => value === "" || value === null || Number.isNaN(Number(value)));
  if (hasScore && Number(pick.home) === rh && Number(pick.away) === ra) return 3;
  const selectedOutcome = pick.outcome || (hasScore ? outcome(Number(pick.home), Number(pick.away)) : "");
  return selectedOutcome === outcome(rh, ra) ? 1 : 0;
}

function outcome(home, away) {
  if (home === away) return "draw";
  return home > away ? "home" : "away";
}

function cleanNumber(value) {
  return value === "" ? "" : Math.max(0, Number(value));
}

function normalizeResults(payload) {
  const list = Array.isArray(payload) ? payload : payload.matches || payload.results || [];
  return list.map((item) => ({
    id: item.id || item.matchId || item.number,
    home: item.home || item.homeTeam || item.team1,
    away: item.away || item.awayTeam || item.team2,
    venue: item.venue || item.stadium || "",
    date: item.date || "",
    realHome: item.realHome ?? item.homeScore ?? item.scoreHome ?? item.goalsHome ?? "",
    realAway: item.realAway ?? item.awayScore ?? item.scoreAway ?? item.goalsAway ?? ""
  }));
}

function findMatch(result) {
  if (result.id) {
    const byId = state.matches.find((match) => String(match.id) === String(result.id) || String(match.number) === String(result.id));
    if (byId) return byId;
  }
  return state.matches.find((match) => normalize(match.home) === normalize(result.home) && normalize(match.away) === normalize(result.away));
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "quiniela-mundial-2026-liga.json";
  link.click();
  URL.revokeObjectURL(url);
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString("es-MX", { day: "2-digit", month: "short" });
}

function renderDateDivider(value) {
  const divider = document.createElement("div");
  divider.className = "date-divider";
  const date = new Date(`${value}T12:00:00`);
  divider.textContent = date.toLocaleDateString("es-MX", {
    weekday: "long",
    day: "2-digit",
    month: "long"
  });
  return divider;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error del servidor");
  return data;
}

function showMessage(text, isError = false, authOnly = false) {
  const target = authOnly || !state.user ? authMessage : message;
  target.textContent = text;
  target.className = `message ${isError ? "error" : ""}`;
  if (target === authMessage) {
    message.textContent = "";
  } else {
    authMessage.textContent = "";
  }
}

function normalize(value = "") {
  return String(value).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
