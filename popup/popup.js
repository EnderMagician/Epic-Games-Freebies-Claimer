const $ = (selector) => document.querySelector(selector);
const state = { settings: null, catalog: null, claimedGames: [], auth: null, isClaimRunning: false, sessionLogs: [], errors: {} };
let loadInFlight = false;
let loadQueued = false;
const LIBRARY_PAGE_SIZE = 60;
const RECENT_DAYS = 14;
const library = { query: "", filter: "all", sort: "newest", limit: LIBRARY_PAGE_SIZE, dataKey: "", viewKey: "", observer: null };
const THUMBS_KEY = "libraryThumbs";
// Covers cached once by the background worker as small data URLs.
let thumbs = {};
let thumbsVersion = 0;
// A one-off message (e.g. a scan result) that the poll's "Updated" label must not hide.
let statusNote = null;
const STATUS_NOTE_MS = 10_000;
const POLL_IDLE_MS = 5000;
const POLL_RUNNING_MS = 1500;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  // Poll from the start so a slow first answer never leaves the popup frozen.
  schedulePoll();
  await loadThumbs();
  await loadState();
  // Cheap when everything is cached: the worker only looks up missing covers.
  send({ type: "resolve-thumbnails" });
});

// Poll faster while a scan runs so the button and result update promptly.
function schedulePoll() {
  setTimeout(async () => {
    await loadState();
    schedulePoll();
  }, state.isClaimRunning ? POLL_RUNNING_MS : POLL_IDLE_MS);
}

function showNote(message) {
  statusNote = { text: message, until: Date.now() + STATUS_NOTE_MS };
  setStatus(message);
}

function bindEvents() {
  for (const select of document.querySelectorAll("select[data-dropdown]")) enhanceSelect(select);

  // Refresh catalog (force fetch new data)
  $("#refresh")?.addEventListener("click", async () => {
    const btn = $("#refresh");
    btn.classList.add("refreshing");
    setStatus("Refreshing catalog…");
    const response = await send({ type: "refresh-catalog", force: true });
    if (!response.ok) {
      btn.classList.remove("refreshing");
      setStatus(`Failed to refresh: ${response.error}`);
      return;
    }
    state.catalog = response.catalog;
    setStatus("Syncing Epic library…");
    const synced = await send({ type: "sync-library" });
    btn.classList.remove("refreshing");
    await loadState();
    if (synced.ok && !synced.library?.error) setStatus(`Catalog and library updated (${synced.library.itemCount} owned item(s)).`);
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
    state.isClaimRunning = true;
    state.claimPhase = "checking";
    render();
    showNote("Checking for free games…");

    // The scan lives in the background worker, so closing the popup is safe;
    // the poll picks up the result if this response never arrives.
    const response = await send({ type: "run-claim-now" });
    showNote(response?.ok ? response.summary.message : response?.error || "Failed to start claim scan.");
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

  const closeClaimedLibrary = () => {
    $("#claimed-library-modal")?.classList.add("hidden");
    $("#claimed-library-preview")?.focus();
  };
  const openClaimedLibrary = () => {
    if (newestClaimedGames(state.claimedGames).length === 0) return;
    $("#claimed-library-modal")?.classList.remove("hidden");
    renderLibrary(true);
    $("#lib-search")?.focus();
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
    const open = !$("#claimed-library-modal")?.classList.contains("hidden");
    if (!open) return;
    const search = $("#lib-search");
    if (event.key === "Escape") {
      event.preventDefault();
      // First Escape clears an active search, the next one closes the library.
      if (search?.value) {
        search.value = "";
        library.query = "";
        renderLibrary(true);
      } else closeClaimedLibrary();
    } else if (event.key === "/" && document.activeElement !== search) {
      event.preventDefault();
      search?.focus();
    }
  });

  let searchTimer = null;
  $("#lib-search")?.addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      library.query = event.target.value.trim();
      renderLibrary(true);
    }, 80);
  });
  $("#lib-sort")?.addEventListener("change", (event) => {
    library.sort = event.target.value;
    renderLibrary(true);
  });
  $("#lib-chips")?.addEventListener("click", (event) => {
    const chip = event.target.closest(".lib-chip");
    if (!chip) return;
    library.filter = chip.dataset.filter;
    renderLibrary(true);
  });
  $("#lib-sync")?.addEventListener("click", async () => {
    const button = $("#lib-sync");
    button.disabled = true;
    button.classList.add("refreshing");
    setStatus("Syncing Epic library…");
    const response = await send({ type: "sync-library" });
    button.disabled = false;
    button.classList.remove("refreshing");
    await loadState();
    if (response.ok && !response.library?.error) setStatus(`Library synced (${response.library.itemCount} owned item(s)).`);
    else setStatus(`Library sync failed: ${response.error || response.library?.error}`);
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
      showNote(response.noInstance ? "No claim instance is running." : "Task terminated by user. Manual Start re-enabled.");
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

async function loadThumbs() {
  try {
    const stored = await chrome.storage.local.get(THUMBS_KEY);
    thumbs = stored[THUMBS_KEY] || {};
  } catch (error) {
    thumbs = {};
  }
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[THUMBS_KEY]) return;
    thumbs = changes[THUMBS_KEY].newValue || {};
    thumbsVersion += 1;
    renderClaimedOnMain(state.claimedGames || []);
  });
}

async function loadState() {
  if (loadInFlight) {
    loadQueued = true;
    return;
  }
  loadInFlight = true;
  try {
    const wasRunning = state.isClaimRunning;
    const response = await send({ type: "get-state" });
    if (response && response.ok) {
      Object.assign(state, response);
      // Surface the outcome even when the popup was reopened mid-scan.
      if (wasRunning && !state.isClaimRunning && state.settings?.lastRunMessage) showNote(state.settings.lastRunMessage);
    }
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
  } else if (isLoggedOut && auth.remembered) {
    // The ~8 hour web session lapsed; claims reselect the remembered account.
    accountStatus.textContent = "Session expired";
    accountStatus.className = "status-disconnected";
    setupCard.classList.add("hidden");
    if (logoutBtn) logoutBtn.classList.remove("hidden");
    if (accountEmail) accountEmail.classList.add("hidden");
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
  if ($("#country")) {
    $("#country").value = settings.country || "VN";
    syncDropdown($("#country"));
  }

  // Manual Start button state
  const runNow = $("#run-now");
  const textSpan = runNow?.querySelector("span");
  if (runNow) {
    if (isClaimRunning) {
      runNow.disabled = true;
      if (textSpan) textSpan.textContent = state.claimPhase === "checking" ? "Checking…" : "Claiming…";
    } else {
      runNow.disabled = isLoggedOut && !auth.remembered;
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
  $("#claimed-count-badge").title = state.library?.syncedAt
    ? `Synced with Epic order history ${new Date(state.library.syncedAt).toLocaleString()}`
    : "Not yet synced with Epic order history";

  const errors = [...Object.values(catalog.errors || {}), ...Object.values(state.errors || {})];
  if (auth.status === "unknown" && auth.error) errors.push(auth.error);
  if (state.library?.error) errors.push(`Library sync: ${state.library.error}`);
  if (statusNote && Date.now() < statusNote.until) setStatus(statusNote.text);
  else setStatus(errors.length ? `Partial data — ${errors.join(" · ")}` : refreshedLabel(catalog.refreshedAt));
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
    image.src = game.image ? thumbnailSrc(game.image, 128) : "";
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

// Claimed Library: a three-game preview on the main panel and a searchable,
// month-grouped full view that renders lazily (accounts often own 200+ games).
function renderClaimedOnMain(games) {
  const claimed = newestClaimedGames(games);
  const dataKey = `${thumbsVersion}#` + claimed.map((game) => `${game.id}:${game.claimedAt || ""}:${game.image ? 1 : 0}`).join("|");
  if (dataKey === library.dataKey) return;
  library.dataKey = dataKey;

  const container = $("#claimed-list");
  container.replaceChildren();
  if (!claimed.length) container.append(empty("Claimed games will appear here."));
  else for (const game of claimed.slice(0, 3)) container.append(createClaimedRow(game, { showYear: true }));
  const more = $("#claimed-preview-more");
  if (more) more.textContent = claimed.length > 3 ? `View all ${claimed.length} games` : "Open library";
  $(".lib-preview-footer")?.classList.toggle("hidden", claimed.length === 0);

  renderLibrary(false);
}

function newestClaimedGames(games) {
  return games.filter(isDone).slice().sort((left, right) => claimedTime(right) - claimedTime(left));
}

function claimedTime(game) {
  return Date.parse(game.claimedAt || "") || 0;
}

function isFromAccount(game) {
  return game.source === "epic_account";
}

function libraryCounts(games) {
  const year = new Date().getFullYear();
  return {
    all: games.length,
    extension: games.filter((game) => !isFromAccount(game)).length,
    account: games.filter(isFromAccount).length,
    thisYear: games.filter((game) => new Date(claimedTime(game)).getFullYear() === year).length
  };
}

function filteredLibrary(games) {
  const query = searchKey(library.query);
  const filtered = games.filter((game) => {
    if (library.filter === "extension" && isFromAccount(game)) return false;
    if (library.filter === "account" && !isFromAccount(game)) return false;
    return !query || searchKey(game.title).includes(query);
  });
  if (library.sort === "oldest") filtered.reverse();
  if (library.sort === "title") filtered.sort((left, right) => String(left.title || "").localeCompare(String(right.title || ""), undefined, { sensitivity: "base" }));
  return filtered;
}

function searchKey(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

// Re-render only when the data or the view settings change, so the 5-second
// state poll keeps the user's scroll position and search text intact.
function renderLibrary(resetScroll) {
  const modal = $("#claimed-library-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  const all = newestClaimedGames(state.claimedGames);
  if (resetScroll) library.limit = LIBRARY_PAGE_SIZE;
  const viewKey = [library.dataKey, library.query, library.filter, library.sort, library.limit].join("§");
  if (!resetScroll && viewKey === library.viewKey) return;
  library.viewKey = viewKey;

  const counts = libraryCounts(all);
  const synced = state.library?.syncedAt ? `Synced ${formatRelative(state.library.syncedAt)}` : "Not synced with Epic yet";
  $("#claimed-library-modal-count").textContent = `${counts.all} game${counts.all === 1 ? "" : "s"} · ${synced}`;
  renderLibraryStats(counts);
  for (const chip of document.querySelectorAll(".lib-chip")) {
    const active = chip.dataset.filter === library.filter;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-selected", String(active));
    chip.querySelector("span").textContent = counts[chip.dataset.filter];
  }
  const search = $("#lib-search");
  if (search) search.placeholder = `Search ${counts.all} games`;

  const list = $("#claimed-library-all-list");
  const scrollTop = list.scrollTop;
  library.observer?.disconnect();
  list.replaceChildren();

  const games = filteredLibrary(all);
  if (!games.length) {
    const box = document.createElement("div");
    box.className = "lib-empty";
    const title = document.createElement("strong");
    title.textContent = library.query ? `No games match "${library.query}"` : "Nothing here yet";
    const hint = document.createElement("span");
    hint.textContent = library.query ? "Try a shorter search or another filter." : "Claimed and synced games will show up here.";
    box.append(title, hint);
    list.append(box);
    return;
  }

  const visible = games.slice(0, library.limit);
  let currentGroup = null;
  const groupCounts = new Map();
  for (const game of games) {
    const key = groupKey(game);
    groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
  }
  const fragment = document.createDocumentFragment();
  for (const game of visible) {
    const key = groupKey(game);
    if (key !== currentGroup) {
      currentGroup = key;
      const header = document.createElement("div");
      header.className = "lib-group-header";
      header.textContent = groupLabel(game);
      const count = document.createElement("span");
      count.textContent = String(groupCounts.get(key));
      header.append(count);
      fragment.append(header);
    }
    fragment.append(createClaimedRow(game, { highlight: library.query, showYear: library.sort === "title" }));
  }
  list.append(fragment);

  if (games.length > visible.length) {
    const sentinel = document.createElement("div");
    sentinel.className = "lib-sentinel";
    list.append(sentinel);
    library.observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      library.limit += LIBRARY_PAGE_SIZE;
      renderLibrary(false);
    }, { root: list, rootMargin: "240px" });
    library.observer.observe(sentinel);
  }
  if (resetScroll) list.scrollTop = 0;
  else list.scrollTop = scrollTop;
}

function renderLibraryStats(counts) {
  const stats = $("#lib-stats");
  if (!stats) return;
  stats.replaceChildren();
  const tiles = [
    ["Total owned", counts.all, true],
    [`In ${new Date().getFullYear()}`, counts.thisYear, false],
    ["Claimed here", counts.extension, false]
  ];
  for (const [label, value, accent] of tiles) {
    const tile = document.createElement("div");
    tile.className = `lib-stat${accent ? " is-accent" : ""}`;
    const number = document.createElement("strong");
    number.textContent = String(value);
    const caption = document.createElement("span");
    caption.textContent = label;
    tile.append(number, caption);
    stats.append(tile);
  }
}

function groupKey(game) {
  if (library.sort === "title") {
    const first = searchKey(game.title).trim().charAt(0);
    return /[a-z]/.test(first) ? first : "#";
  }
  const time = claimedTime(game);
  if (!time) return "unknown";
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function groupLabel(game) {
  const key = groupKey(game);
  if (library.sort === "title") return key.toUpperCase();
  if (key === "unknown") return "Unknown date";
  return new Date(claimedTime(game)).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function createClaimedRow(game, { highlight = "", showYear = false } = {}) {
  const card = $("#claimed-template").content.firstElementChild.cloneNode(true);
  // Imported account items have no store URL; a store search still finds them.
  const url = game.url || `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(game.title || "")}`;
  makeGameCardOpenable(card, { ...game, url });

  const thumb = card.querySelector(".lib-thumb");
  thumb.style.setProperty("--hue", String(titleHue(game.title)));
  card.querySelector(".lib-monogram").textContent = monogram(game.title);
  const src = thumbs[game.id] || (game.image ? thumbnailSrc(game.image) : "");
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = src;
    img.addEventListener("error", () => img.remove());
    thumb.append(img);
  }

  appendHighlighted(card.querySelector(".lib-row-title"), game.title || "Untitled", highlight);
  card.querySelector(".lib-row-meta").textContent = formatClaimedDate(game.claimedAt, showYear);
  const source = card.querySelector(".lib-source");
  const fromAccount = isFromAccount(game);
  source.textContent = fromAccount ? "Account" : "Claimed";
  source.classList.add(fromAccount ? "is-account" : "is-extension");
  source.title = fromAccount ? "Found in your Epic order history" : "Claimed by this extension";
  if (Date.now() - claimedTime(game) < RECENT_DAYS * 86_400_000) card.classList.add("is-recent");
  return card;
}

// Until the worker caches a cover, ask Epic's CDN for a ~2 KB 112px version.
function thumbnailSrc(url, width = 112) {
  try {
    const parsed = new URL(url);
    if (!/(?:^|\.)(?:epicgames\.com|unrealengine\.com)$/i.test(parsed.hostname)) return url;
    parsed.search = `?resize=1&w=${width}&quality=low`;
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

function appendHighlighted(element, text, query) {
  const needle = searchKey(query);
  const index = needle ? searchKey(text).indexOf(needle) : -1;
  // searchKey keeps string length for Latin text; fall back to plain text otherwise.
  if (index < 0 || searchKey(text).length !== text.length) {
    element.textContent = text;
    return;
  }
  const mark = document.createElement("mark");
  mark.textContent = text.slice(index, index + needle.length);
  element.append(text.slice(0, index), mark, text.slice(index + needle.length));
}

function monogram(title) {
  const words = String(title || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

function titleHue(title) {
  let hash = 0;
  for (const char of String(title || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
}

function formatClaimedDate(isoStr, showYear) {
  const date = new Date(isoStr || "");
  if (Number.isNaN(date.getTime())) return "Date unknown";
  return date.toLocaleDateString("en-US", showYear || date.getFullYear() !== new Date().getFullYear()
    ? { month: "short", day: "numeric", year: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" });
}

function formatRelative(isoStr) {
  const minutes = Math.round((Date.now() - Date.parse(isoStr)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(isoStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

// Themed replacement for a native <select>: Chrome cannot style the native
// option menu. The hidden select stays the source of truth and still fires
// "change", so existing handlers keep working.
const dropdownSyncs = new WeakMap();

function syncDropdown(select) {
  dropdownSyncs.get(select)?.();
}

function enhanceSelect(select) {
  const wrap = document.createElement("div");
  wrap.className = `m3-dropdown ${select.dataset.dropdown ? `m3-dropdown--${select.dataset.dropdown}` : ""}`;
  select.before(wrap);
  wrap.append(select);
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const menuId = `${select.id}-menu`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "m3-dropdown-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", menuId);
  button.setAttribute("aria-label", select.getAttribute("aria-label") || select.title || "Choose an option");
  const label = document.createElement("span");
  label.className = "m3-dropdown-label";
  button.append(label);
  button.insertAdjacentHTML("beforeend", '<svg class="m3-dropdown-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"/></svg>');

  const menu = document.createElement("div");
  menu.id = menuId;
  menu.className = "m3-dropdown-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  const options = [...select.options].map((option) => {
    const item = document.createElement("div");
    item.className = "m3-dropdown-option";
    item.setAttribute("role", "option");
    item.tabIndex = -1;
    item.dataset.value = option.value;
    const text = document.createElement("span");
    text.textContent = option.textContent;
    item.append(text);
    item.insertAdjacentHTML("beforeend", '<svg class="m3-dropdown-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="20 6 9 17 4 12"/></svg>');
    menu.append(item);
    return item;
  });
  wrap.append(button, menu);

  const sync = () => {
    const current = select.options[select.selectedIndex];
    label.textContent = current?.dataset.short || current?.textContent || "";
    for (const item of options) item.setAttribute("aria-selected", String(item.dataset.value === select.value));
  };
  const isOpen = () => !menu.hidden;
  const close = (focusButton) => {
    if (!isOpen()) return;
    menu.hidden = true;
    wrap.classList.remove("is-open", "drop-up");
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  const open = () => {
    for (const other of document.querySelectorAll(".m3-dropdown.is-open")) if (other !== wrap) other.querySelector(".m3-dropdown-btn")?.dispatchEvent(new CustomEvent("dropdown-close"));
    menu.hidden = false;
    wrap.classList.add("is-open");
    // Open upward when the popup has no room below (e.g. the region setting).
    const rect = button.getBoundingClientRect();
    wrap.classList.toggle("drop-up", rect.bottom + menu.offsetHeight + 8 > window.innerHeight && rect.top > menu.offsetHeight + 8);
    button.setAttribute("aria-expanded", "true");
    (options.find((item) => item.dataset.value === select.value) || options[0])?.focus();
  };
  const choose = (value) => {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sync();
    close(true);
  };

  button.addEventListener("dropdown-close", () => close(false));
  button.addEventListener("click", () => (isOpen() ? close(true) : open()));
  button.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest(".m3-dropdown-option");
    if (item) choose(item.dataset.value);
  });
  menu.addEventListener("keydown", (event) => {
    const index = options.indexOf(document.activeElement);
    const move = (next) => options[(next + options.length) % options.length]?.focus();
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(options.length - 1);
    else if ((event.key === "Enter" || event.key === " ") && index >= 0) choose(options[index].dataset.value);
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") close(false);
    else return;
    event.preventDefault();
    // Keep Escape from also closing the library view behind the menu.
    event.stopPropagation();
  });
  document.addEventListener("pointerdown", (event) => {
    if (isOpen() && !wrap.contains(event.target)) close(false);
  });
  select.addEventListener("change", sync);
  dropdownSyncs.set(select, sync);
  sync();
}
