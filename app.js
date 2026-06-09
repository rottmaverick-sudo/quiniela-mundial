const phases = ["Todos", "Grupos", "Dieciseisavos", "Octavos", "Cuartos", "Semifinales", "Tercer lugar", "Final"];

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
let autoRefreshTimer = null;

phases.forEach((phase) => {
  const option = document.createElement("option");
  option.value = phase;
  option.textContent = phase;
  phaseFilter.append(option);
});

document.querySelector("#loginButton").addEventListener("click", () => auth("login"));
document.querySelector("#registerButton").addEventListener("click", () => auth("register"));
document.querySelector("#logoutButton").addEventListener("click", logout);
document.querySelector("#saveApi").addEventListener("click", saveSettings);
document.querySelector("#refreshResults").addEventListener("click", refreshResults);
document.querySelector("#addMatch").addEventListener("click", addMatch);
document.querySelector("#exportData").addEventListener("click", exportData);
document.querySelector("#importData").addEventListener("change", importData);
document.querySelector("#resetData").addEventListener("click", () => showMessage("Con base de datos no reinicio todo desde el navegador."));
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
    showMessage("Escribe usuario y contrasena.", true);
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
    showMessage(error.message, true);
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
  document.querySelector("#activePlayerLabel").textContent = user ? `${user.name}${isAdmin ? " · admin" : ""}` : "Sin sesion";
  document.querySelector("#playerCount").textContent = `${state.leaderboard.length} jugadores`;
  document.querySelector("#lastSync").textContent = state.settings.lastSync ? `Actualizado ${state.settings.lastSync}` : "Sin refrescar";

  matchesEl.replaceChildren();
  const query = searchBox.value.trim().toLowerCase();
  const selectedPhase = phaseFilter.value || "Todos";
  const filtered = state.matches.filter((match) => {
    const phaseOk = selectedPhase === "Todos" || match.phase === selectedPhase;
    const text = `${match.home} ${match.away} ${match.venue}`.toLowerCase();
    return phaseOk && text.includes(query);
  });

  filtered.forEach((match) => matchesEl.append(renderMatch(match, user, isAdmin)));
  renderLeaderboard();
  updateSummary(filtered);
}

function renderMatch(match, user, isAdmin) {
  const node = template.content.firstElementChild.cloneNode(true);
  const pick = state.picks[match.id] || { home: "", away: "" };

  bindAdminText(node, ".phase", match, "phase", isAdmin);
  bindAdminText(node, ".date", match, "date", isAdmin);
  bindAdminText(node, ".venue", match, "venue", isAdmin);
  bindAdminText(node, ".home", match, "home", isAdmin);
  bindAdminText(node, ".away", match, "away", isAdmin);
  bindAdminNumber(node, ".realHome", match, "realHome", isAdmin);
  bindAdminNumber(node, ".realAway", match, "realAway", isAdmin);
  bindPick(node, ".pickHome", match.id, pick, "home", !user);
  bindPick(node, ".pickAway", match.id, pick, "away", !user);

  node.querySelector(".points").textContent = `${scoreMatch(match, pick)} pts`;
  const deleteButton = node.querySelector(".delete");
  deleteButton.disabled = !isAdmin;
  deleteButton.addEventListener("click", async () => {
    if (!confirm("Eliminar este partido de la quiniela?")) return;
    await request(`/api/matches/${match.id}`, { method: "DELETE" });
    await loadState();
  });

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
    state.picks[matchId] ||= { home: "", away: "" };
    state.picks[matchId][key] = cleanNumber(input.value);
    await request(`/api/picks/${matchId}`, {
      method: "PATCH",
      body: state.picks[matchId]
    });
    await loadState();
  });
}

async function updateMatch(matchId, patch) {
  try {
    await request(`/api/matches/${matchId}`, { method: "PATCH", body: patch });
    await loadState();
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function addMatch() {
  try {
    await request("/api/matches", { method: "POST", body: {} });
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
  if (values.some((value) => value === "" || value === null || Number.isNaN(Number(value)))) return 0;
  const [ph, pa, rh, ra] = values.map(Number);
  if (ph === rh && pa === ra) return 3;
  return outcome(ph, pa) === outcome(rh, ra) ? 1 : 0;
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

function importData() {
  showMessage("La importacion directa queda desactivada cuando usas base de datos.");
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

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = `message ${isError ? "error" : ""}`;
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
