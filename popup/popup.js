const $ = (selector) => document.querySelector(selector);
const state = { settings: null, catalog: null, claimedGames: [], auth: null, isClaimRunning: false, sessionLogs: [], errors: {} };
let loadInFlight = false;
let loadQueued = false;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadState();
  setInterval(() => loadState(), 5000);
});

function bindEvents() {
  // Refresh catalog (force fetch new data)
  $("#refresh")?.addEventListener("click", async () => {
    const btn = $("#refresh");
    btn.classList.add("refreshing");
    setStatus("Refreshing catalog…");
    const response = await send({ type: "refresh-catalog", force: true });
    btn.classList.remove("refreshing");
    if (response.ok) {
      state.catalog = response.catalog;
      render();
      setStatus("Catalog updated successfully.");
    } else setStatus(`Failed to refresh: ${response.error}`);
  });

  // Epic Games Logo click -> Open Store
  $("#app-logo-btn")?.addEventListener("click", () => send({ type: "open-login" }));

  // Login initiate
  $("#initiate")?.addEventListener("click", async () => {
    const response = await send({ type: "initiate" });
    if (response.ok) {
      state.settings = response.settings;
      if (response.authCheck) state.auth = response.authCheck;
      render();
      setStatus("Opened Epic Games Store login page.");
    }
  });

  // Logout button
  $("#logout")?.addEventListener("click", async () => {
    const logoutBtn = $("#logout");
    logoutBtn.disabled = true;
    setStatus("Logging out from Epic Games account...");
    const response = await send({ type: "logout" });
    logoutBtn.disabled = false;
    if (response.ok) {
      state.settings = response.settings;
      state.accountEmail = null;
      state.auth = { status: "logged_out", source: "api" };
      render();
      setStatus("Logged out. Please log in with a new Epic Games account.");
    } else {
      setStatus(`Logout failed: ${response.error}`);
    }
  });

  // Manual Start button
  $("#run-now")?.addEventListener("click", async () => {
    const button = $("#run-now");
    const textSpan = button.querySelector("span");
    button.disabled = true;
    if (textSpan) textSpan.textContent = "Running…";
    setStatus("Running manual auto-claim scan…");

    const response = await send({ type: "run-claim-now" });
    if (!response?.ok) {
      setStatus(response?.error || "Failed to start claim scan.");
    } else {
      setStatus(response.summary.message);
    }
    await loadState();
  });

  // Activity Log Sliding Drawer Sheet Toggle (Synchronized Triangle Animations)
  const toggleSheet = () => {
    const sheet = $("#activity-log-sheet");
    if (!sheet) return;
    const isOpen = sheet.classList.toggle("open");
    document.querySelectorAll(".triangle-icon").forEach((icon) => {
      icon.classList.toggle("open", isOpen);
    });
  };

  $("#log-toggle-btn")?.addEventListener("click", toggleSheet);

  const closeClaimedLibrary = () => $("#claimed-library-modal")?.classList.add("hidden");
  const openClaimedLibrary = () => {
    if (newestClaimedGames(state.claimedGames).length > 0) $("#claimed-library-modal")?.classList.remove("hidden");
  };
  $("#claimed-library-preview")?.addEventListener("click", openClaimedLibrary);
  $("#claimed-library-preview")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openClaimedLibrary();
    }
  });
  $("#close-claimed-library")?.addEventListener("click", closeClaimedLibrary);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeClaimedLibrary();
  });

  // Kill Instance Button
  $("#kill-instance")?.addEventListener("click", async () => {
    const killBtn = $("#kill-instance");
    if (killBtn.disabled) return;
    killBtn.disabled = true;
    setStatus("Terminating running task...");
    const response = await send({ type: "kill-instance" });
    if (response.ok) {
      state.isClaimRunning = false;
      if (response.sessionLogs) state.sessionLogs = response.sessionLogs;
      setStatus(response.noInstance ? "No claim instance is running." : "Task terminated by user. Manual Start re-enabled.");
      render();
    } else {
      setStatus(`Failed to kill task: ${response.error}`);
      await loadState();
    }
  });

  // M3 Automation Switches
  $("#auto-claim")?.addEventListener("change", async (event) => {
    const response = await send({ type: "update-settings", settings: { autoClaim: event.target.checked } });
    if (response.ok) state.settings = response.settings;
    render();
  });

  $("#run-on-startup")?.addEventListener("change", async (event) => {
    const response = await send({ type: "update-settings", settings: { runOnStartup: event.target.checked } });
    if (response.ok) state.settings = response.settings;
    render();
  });

  // Country select
  $("#country")?.addEventListener("change", async (event) => {
    const response = await send({ type: "update-settings", settings: { country: event.target.value } });
    if (response.ok) {
      state.settings = response.settings;
      setStatus("Loading catalog for new region…");
      const refreshed = await send({ type: "refresh-catalog", force: true });
      if (refreshed.ok) state.catalog = refreshed.catalog;
    }
    render();
  });
}

async function loadState() {
  if (loadInFlight) {
    loadQueued = true;
    return;
  }
  loadInFlight = true;
  try {
    const response = await send({ type: "get-state" });
    if (response && response.ok) Object.assign(state, response);
    render();
  } finally {
    loadInFlight = false;
    if (loadQueued) {
      loadQueued = false;
      loadState();
    }
  }
}

function render() {
  const { settings, auth = { status: "unknown" }, catalog = { epic: [] }, claimedGames = [], isClaimRunning = false, sessionLogs = [] } = state;
  if (!settings) return;

  // Connected Account Status Card & Email Display
  const accountStatus = $("#account-status");
  const accountEmail = $("#account-email");
  const logoutBtn = $("#logout");
  const setupCard = $("#setup");

  const isLoggedIn = auth.status === "logged_in";
  const isLoggedOut = auth.status === "logged_out";
  const isUnknown = auth.status === "unknown";
  const canShowLogout = isLoggedIn || (isUnknown && auth.source === "cached");
  if (isLoggedIn) {
    accountStatus.textContent = "Connected";
    accountStatus.className = "status-connected";
    setupCard.classList.add("hidden");
    if (logoutBtn) logoutBtn.classList.toggle("hidden", !canShowLogout);

    if (state.accountEmail) {
      if (accountEmail) {
        accountEmail.textContent = state.accountEmail;
        accountEmail.classList.remove("hidden");
      }
    } else if (accountEmail) {
      accountEmail.classList.add("hidden");
    }
  } else if (isLoggedOut) {
    accountStatus.textContent = "Needs Login";
    accountStatus.className = "status-disconnected";
    setupCard.classList.remove("hidden");
    if (logoutBtn) logoutBtn.classList.add("hidden");
    if (accountEmail) accountEmail.classList.add("hidden");
  } else {
    accountStatus.textContent = "Unable to verify";
    accountStatus.className = "status-disconnected";
    setupCard.classList.add("hidden");
    if (logoutBtn) logoutBtn.classList.toggle("hidden", !canShowLogout);
    if (accountEmail) accountEmail.classList.add("hidden");
  }

  // Switches
  if ($("#auto-claim")) $("#auto-claim").checked = settings.autoClaim;
  if ($("#run-on-startup")) $("#run-on-startup").checked = settings.runOnStartup ?? true;
  if ($("#country")) $("#country").value = settings.country || "VN";

  // Manual Start button state
  const runNow = $("#run-now");
  const textSpan = runNow?.querySelector("span");
  if (runNow) {
    if (isClaimRunning) {
      runNow.disabled = true;
      if (textSpan) textSpan.textContent = "Running…";
    } else {
      runNow.disabled = isLoggedOut;
      if (textSpan) textSpan.textContent = "Manual Start";
    }
  }

  const killInstance = $("#kill-instance");
  if (killInstance) {
    killInstance.disabled = !isClaimRunning;
    killInstance.title = isClaimRunning ? "Terminate current running task immediately" : "No claim instance is running";
  }

  // Activity Log Box with Color-Coded Categories
  const logBox = $("#activity-log-box");
  if (logBox) {
    renderLogs(logBox, sessionLogs);
  }

  // Lists and Badges
  const freeGames = catalog.epic || [];
  renderGames("epic", freeGames);
  renderClaimedOnMain(claimedGames);

  const doneCount = claimedGames.filter(isDone).length;
  const actionableCount = freeGames.filter((game) => !claimedGames.some((claimed) => claimed.id === game.id && isDone(claimed))).length;
  $("#epic-count-badge").textContent = `${freeGames.length} current · ${actionableCount} to claim`;
  $("#claimed-count-badge").textContent = `${doneCount} claimed`;

  const errors = [...Object.values(catalog.errors || {}), ...Object.values(state.errors || {})];
  if (auth.status === "unknown" && auth.error) errors.push(auth.error);
  setStatus(errors.length ? `Partial data — ${errors.join(" · ")}` : refreshedLabel(catalog.refreshedAt));
}

function renderGames(platform, games) {
  const container = $(`#${platform}-list`);
  container.replaceChildren();
  if (!games.length) {
    container.append(empty("No free games currently available."));
    return;
  }
  const claims = new Map(state.claimedGames.map((game) => [game.id, game]));
  for (const game of games) {
    const card = $("#game-template").content.firstElementChild.cloneNode(true);
    makeGameCardOpenable(card, game);
    const image = card.querySelector(".cover");
    image.src = game.image || "";
    image.alt = "";
    image.addEventListener("error", () => image.remove());
    card.querySelector(".title").textContent = game.title;
    card.querySelector(".expiry").textContent = formatExpiry(game.expiresAt);
    const button = card.querySelector(".claim-btn");
    const existing = claims.get(game.id);
    if (existing && isDone(existing)) {
      button.textContent = "Claimed";
      button.disabled = true;
    } else if (existing?.status === "attempting") {
      button.textContent = "Claiming…";
      button.disabled = true;
    } else {
      if (existing?.status === "needs_attention" || existing?.status === "needs_login") {
        button.textContent = "Retry";
      }
      button.addEventListener("click", async () => {
        button.textContent = "Opening…";
        button.disabled = true;
        const response = await send({ type: "claim-item", platform, id: game.id });
        if (!response.ok) {
          button.textContent = "Claim";
          button.disabled = false;
          setStatus(response.error);
        } else setStatus(`Opened background tab for ${game.title}.`);
      });
    }
    container.append(card);
  }
}

// Render Claimed Games with Cover Banners on main panel
function renderClaimedOnMain(games) {
  const container = $("#claimed-list");
  container.replaceChildren();
  const claimed = newestClaimedGames(games);
  const recent = claimed.slice(0, 3);
  if (!recent.length) {
    container.append(empty("Claimed games will appear here."));
  } else {
    renderClaimedCards(container, recent);
  }

  const allContainer = $("#claimed-library-all-list");
  if (allContainer) {
    allContainer.replaceChildren();
    if (claimed.length) renderClaimedCards(allContainer, claimed, 3);
    else allContainer.append(empty("No claimed games yet."));
  }
  const modalCount = $("#claimed-library-modal-count");
  if (modalCount) modalCount.textContent = `${claimed.length} claimed game${claimed.length === 1 ? "" : "s"}`;
}

function newestClaimedGames(games) {
  return games.filter(isDone).slice().sort((left, right) => {
    const leftTime = Date.parse(left.claimedAt || "") || 0;
    const rightTime = Date.parse(right.claimedAt || "") || 0;
    return rightTime - leftTime;
  });
}

function renderClaimedCards(container, games, highlightedCount = 0) {
  games.forEach((game, index) => {
    const card = createClaimedCard(game);
    if (index < highlightedCount) card.classList.add("is-recent-preview");
    container.append(card);
  });
}

function createClaimedCard(game) {
  const card = $("#claimed-template").content.firstElementChild.cloneNode(true);
  makeGameCardOpenable(card, game);
  const img = card.querySelector(".claimed-cover");
  if (game.image) {
    img.src = game.image;
    img.alt = "";
    img.addEventListener("error", () => card.querySelector(".m3-cover-wrapper").remove());
  } else {
    card.querySelector(".m3-cover-wrapper").remove();
  }
  card.querySelector(".claimed-title").textContent = game.title;
  card.querySelector(".claimed-date").textContent = formatDate(game.claimedAt);
  return card;
}

function makeGameCardOpenable(card, game) {
  if (!game?.url) return;
  card.classList.add("m3-game-link-card");
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  card.setAttribute("aria-label", `Open ${game.title || "game"} in Epic Games Store`);
  const open = async () => {
    const response = await send({ type: "open-game", url: game.url });
    if (!response.ok) setStatus(response.error || "Unable to open the Epic Games Store page.");
  };
  card.addEventListener("click", (event) => {
    if (!event.target.closest("button")) open();
  });
  card.addEventListener("keydown", (event) => {
    if (event.target.closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
}

function formatDate(isoStr) {
  if (!isoStr) return "Claimed";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "Claimed";
  return `Claimed on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function isDone(game) {
  return game.status === "claimed" || game.status === "owned";
}

function empty(text) {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function formatExpiry(value) {
  if (!value) return "Free now";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Free now" : `Free until ${date.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function refreshedLabel(value) {
  if (!value) return "No data — click refresh.";
  return `Updated ${new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
}

function setStatus(message) {
  const statusEl = $("#status");
  if (statusEl) statusEl.textContent = message;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: "No response from extension background." });
    });
  });
}

function renderLogs(container, logs) {
  if (!container) return;
  container.replaceChildren();
  if (!logs || logs.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "log-entry log-cyan";
    emptyDiv.textContent = "[Session Started] Waiting for activity...";
    container.append(emptyDiv);
    return;
  }

  let previousDateKey = null;
  for (const line of logs) {
    const parsed = parseLogLine(line);
    if (parsed.dateKey !== previousDateKey) {
      const divider = document.createElement("div");
      divider.className = "log-date-divider";
      divider.textContent = formatLogDateLabel(parsed.dateKey);
      container.append(divider);
      previousDateKey = parsed.dateKey;
    }

    const div = document.createElement("div");
    const text = parsed.message.toLowerCase();
    let colorClass = "log-green"; // default green for normal operation

    if (text.includes("error") || text.includes("fail") || text.includes("kill") || text.includes("terminated") || text.includes("rejected") || text.includes("http")) {
      colorClass = "log-red";
    } else if (text.includes("no free games") || text.includes("already claimed") || text.includes("skipped") || text.includes("cached") || text.includes("needs_") || text.includes("waiting")) {
      colorClass = "log-yellow";
    } else if (text.includes("manual start") || text.includes("daily startup") || text.includes("refreshing") || text.includes("settings updated")) {
      colorClass = "log-cyan";
    }

    div.className = `log-entry ${colorClass}`;
    div.textContent = parsed.time ? `[${parsed.time}] ${parsed.message}` : line;
    container.append(div);
  }
}

function parseLogLine(line) {
  const value = String(line || "");
  const match = value.match(/^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  if (match) return { dateKey: match[1], time: match[2], message: match[3] };

  const legacy = value.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  if (legacy) return { dateKey: "earlier", time: legacy[1], message: legacy[2] };
  return { dateKey: "earlier", time: "", message: value };
}

function formatLogDateLabel(dateKey) {
  if (dateKey === "earlier") return "Earlier logs";
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  if (dateKey === todayKey) return "Today";
  if (dateKey === yesterdayKey) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
