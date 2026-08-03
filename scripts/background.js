importScripts("core/state-model.js", "core/auth-model.js", "core/auth-client.js", "core/claim-machine.js", "core/claim-routing.js", "core/claim-queue.js");

const { DEFAULT_SETTINGS: MODEL_DEFAULT_SETTINGS, normalizeSettings, normalizeClaimedGames, migrateStoredState, buildStateSnapshot } = FreebiesStateModel;
const { resolveAuthObservation, shouldLogAuthTransition } = FreebiesAuthModel;
const { fetchLoginState: fetchEpicLoginState } = FreebiesAuthClient;
const { createClaimTask, reduceClaimTask } = FreebiesClaimMachine;
const { findClaimableGameForUrl } = FreebiesClaimRouting;
const { createClaimQueue, beginNextClaim, rebindCurrentClaim, finishCurrentClaim, skipNextClaim, cancelClaimQueue } = FreebiesClaimQueue;

const CATALOG_KEY = "catalog";
const CLAIMED_KEY = "claimedGames";
const SETTINGS_KEY = "settings";
const LOGS_KEY = "sessionLogs";
const AUTH_KEY = "authState";
const TASKS_KEY = "activeClaimTasks";
const CLAIM_QUEUE_KEY = "claimQueue";
const STORAGE_VERSION_KEY = "storageSchemaVersion";
const MIGRATION_BACKUP_KEY = "migrationBackupV2";
const ALARM_NAME = "freebies-daily-check";
const AUTH_CACHE_TTL_MS = 15000;
const AUTH_CHANGE_DEBOUNCE_MS = 750;
const NOTIFICATION_COVER_TIMEOUT_MS = 2000;

let isClaimRunning = false;
let sessionLogs = [];
let spawnedClaimTabIds = new Set();
let authProbePromise = null;
let authRefreshTimer = null;
let authRefreshInFlight = false;
let authRefreshQueued = false;
let claimQueuePumpPromise = null;
const completionNotificationIds = new Set();

function taskStorage() {
  return chrome.storage.session || chrome.storage.local;
}

async function getSessionLogs() {
  const stored = await chrome.storage.local.get(LOGS_KEY);
  if (Array.isArray(stored[LOGS_KEY]) && stored[LOGS_KEY].length > 0) {
    sessionLogs = stored[LOGS_KEY];
  } else if (sessionLogs.length === 0) {
    const initEntry = `[${formatLogTimestamp()}] Session initialized.`;
    sessionLogs = [initEntry];
    await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
  }
  return sessionLogs;
}

async function addLog(msg) {
  await getSessionLogs();
  const entry = `[${formatLogTimestamp()}] ${msg}`;
  sessionLogs.unshift(entry);
  if (sessionLogs.length > 80) sessionLogs.pop();
  await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
}

function formatLogTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await addLog("Extension installed / reloaded.");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1440 });
  await refreshCatalog({ force: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  await addLog("Browser startup detected.");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1440 });
  await runDailyCheck();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await runDailyCheck();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const task = await getActiveTask(tabId);
  spawnedClaimTabIds.delete(tabId);
  await removeActiveTask(tabId);
  if (task) {
    const detail = "Claim tab was closed before Epic confirmed ownership.";
    await recordClaimStatus(task.platform || "epic", task.gameId, "failed", detail);
    await addLog(`Claim failed for ${task.gameId}: ${detail}`);
    await finishSerialQueueItem(tabId, "failed", detail);
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab?.id || !tab.openerTabId) return;
  const task = await getActiveTask(tab.openerTabId);
  if (!task) return;
  await removeActiveTask(tab.openerTabId);
  const rebound = { ...task, tabId: tab.id, frameId: 0, updatedAt: Date.now() };
  await saveActiveTask(rebound);
  await rebindSerialQueueTab(tab.openerTabId, tab.id);
  spawnedClaimTabIds.delete(tab.openerTabId);
  spawnedClaimTabIds.add(tab.id);
  await addLog(`Rebound claim task for ${task.gameId} to child tab #${tab.id}.`);
  await restoreUserTabAfterClaimChild(task, tab);
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const activatedTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!activatedTab) return;
  if (await getActiveTask(tabId)) return;
  if (activatedTab.openerTabId && await getActiveTask(activatedTab.openerTabId)) return;

  const tasks = await getActiveTasks();
  for (const task of tasks) {
    if (task.claimWindowId !== windowId) continue;
    await saveActiveTask({ ...task, returnTabId: tabId, returnWindowId: windowId });
  }
});

// Real-time Auth Cookie Change Listener
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const { cookie } = changeInfo;
  if (!cookie || !cookie.domain || !cookie.domain.includes("epicgames.com")) return;
  if (
    cookie.name === "EPIC_BEARER_TOKEN" ||
    cookie.name === "EPIC_EG1" ||
    cookie.name === "EPIC_SSO" ||
    cookie.name === "EPIC_SESSION_AP" ||
    cookie.name === "remember_me"
  ) {
    scheduleAuthRefresh();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "get-state":
      return getState();
    case "refresh-catalog":
      return { catalog: await refreshCatalog({ force: Boolean(message.force) }) };
    case "update-settings":
      return { settings: await updateSettings(message.settings || {}) };
    case "initiate":
      await openEpicLoginTab();
      const authCheck = await checkEpicLoginStatus({ force: true });
      return { settings: await getSettings(), authCheck };
    case "open-login":
      await openEpicLoginTab();
      return {};
    case "open-game":
      await openEpicStoreGame(message.url);
      return {};
    case "logout":
      await updateSettingsInternal({ initiated: false });
      await clearEpicCookies();
      await addLog("User logged out from Epic Games account.");
      await chrome.tabs.create({ url: "https://www.epicgames.com/id/logout?redirectUrl=https%3A%2F%2Fstore.epicgames.com%2Fen-US%2Flogin", active: true });
      return { settings: await getSettings() };
    case "check-login-status":
      return checkEpicLoginStatus({ force: true });
    case "claim-item":
      if ((await getClaimQueue())?.status === "running") throw new Error("A serial claim queue is already running.");
      await queueClaim(message.platform, message.id, false);
      return {};
    case "claim-ready":
      return { task: sender?.tab?.id ? await getOrAdoptClaimTask(sender.tab.id, message.url || sender.tab.url || "", message.allowAdoption !== false) : null };
    case "claim-observation": {
      if (!sender?.tab?.id) return { task: null, decision: { action: "wait", reason: "No tab context." } };
      const task = await getActiveTask(sender.tab.id);
      if (!task) return { task: null, decision: { action: "wait", reason: "No active claim task for this tab." } };
      const reduced = reduceClaimTask({ ...task, frameId: sender.frameId ?? task.frameId }, message.observation || {}, Date.now());
      await saveActiveTask(reduced.task);
      if (reduced.decision.action === "complete_owned") {
        await recordClaimStatus(task.platform || "epic", task.gameId, "owned", reduced.decision.reason);
        await removeActiveTask(sender.tab.id);
        spawnedClaimTabIds.delete(sender.tab.id);
        try { await chrome.tabs.remove(sender.tab.id); } catch (e) { /* already closed */ }
        await finishSerialQueueItem(sender.tab.id, "owned", reduced.decision.reason);
      } else if (reduced.decision.action === "needs_attention") {
        if (task.phase !== "needs_attention") {
          await recordClaimStatus(task.platform || "epic", task.gameId, "needs_attention", reduced.decision.reason);
          await addLog(`Serial queue paused for ${task.gameId}: ${reduced.decision.reason}`);
        }
      }
      return { task: reduced.task, decision: reduced.decision };
    }
    case "claim-action-result":
      await addLog(`Claim action ${message.action || "unknown"}: ${message.detail || ""}`);
      return {};
    case "run-claim-now":
      return { summary: await runClaimNow() };
    case "kill-instance":
      return killInstance();
    case "clear-logs":
      return clearLogs();
    case "claim-attempt":
      await recordClaimStatus(message.platform, message.id, "attempting", message.detail);
      await addLog(`Claim attempting for ${message.id}: ${message.detail || ""}`);
      return {};
    case "claim-result":
      await recordClaimStatus(message.platform, message.id, message.status, message.detail);
      await addLog(`Claim result for ${message.id}: ${message.status} (${message.detail || ""})`);
      if (sender?.tab?.id) {
        spawnedClaimTabIds.delete(sender.tab.id);
        await removeActiveTask(sender.tab.id);
        try {
          await chrome.tabs.remove(sender.tab.id);
          await addLog(`Closed claim tab #${sender.tab.id}`);
        } catch (e) {
          // Tab already closed
        }
        await finishSerialQueueItem(sender.tab.id, message.status || "failed", message.detail || "Claim content script ended.");
      }
      return {};
    default:
      throw new Error("Unsupported message");
  }
}

async function killInstance() {
  const queue = await getClaimQueue();
  const activeTasks = await getActiveTasks();
  const hasRunningInstance = isClaimRunning || queue?.status === "running" || activeTasks.length > 0;
  if (!hasRunningInstance) {
    return { isClaimRunning: false, noInstance: true, sessionLogs: await getSessionLogs() };
  }

  await addLog("Kill Instance triggered by user. Cancelling running tasks...");
  isClaimRunning = false;
  if (queue?.status === "running") await saveClaimQueue(cancelClaimQueue(queue, Date.now()));
  const claimTabIds = new Set([...spawnedClaimTabIds, ...activeTasks.map((task) => task.tabId).filter(Number.isInteger)]);
  for (const tabId of claimTabIds) {
    await removeActiveTask(tabId);
    try {
      await chrome.tabs.remove(tabId);
      await addLog(`Terminated background claim tab #${tabId}`);
    } catch (e) {
      // ignore
    }
  }
  spawnedClaimTabIds.clear();
  await addLog("Claim process terminated. Manual Start re-enabled.");
  return { isClaimRunning: false, sessionLogs: await getSessionLogs() };
}

async function clearLogs() {
  const initEntry = `[${formatLogTimestamp()}] Session logs cleared.`;
  sessionLogs = [initEntry];
  await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
  return { sessionLogs };
}

async function ensureSettings() {
  await ensureStorageMigration();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...MODEL_DEFAULT_SETTINGS, initiated: false } });
  }
}

async function ensureStorageMigration() {
  const stored = await chrome.storage.local.get([
    STORAGE_VERSION_KEY, SETTINGS_KEY, CLAIMED_KEY, CATALOG_KEY, MIGRATION_BACKUP_KEY
  ]).catch(() => ({}));
  const version = Number(stored[STORAGE_VERSION_KEY] || 0);
  if (version >= FreebiesStateModel.SCHEMA_VERSION) return;
  const migrated = migrateStoredState({
    settings: stored[SETTINGS_KEY],
    claimedGames: stored[CLAIMED_KEY],
    catalog: stored[CATALOG_KEY]
  }, version);
  const update = {
    [STORAGE_VERSION_KEY]: migrated.version,
    [SETTINGS_KEY]: { ...migrated.settings, initiated: stored[SETTINGS_KEY]?.initiated === true },
    [CLAIMED_KEY]: migrated.claimedGames,
    [CATALOG_KEY]: migrated.catalog
  };
  if (!stored[MIGRATION_BACKUP_KEY] && migrated.backup) update[MIGRATION_BACKUP_KEY] = { ...migrated.backup, migratedAt: new Date().toISOString() };
  await chrome.storage.local.set(update);
}

async function getSettings() {
  await ensureSettings();
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(settings);
}

async function updateSettings(next) {
  const settings = { ...(await getSettings()), ...next };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const changedKeys = Object.keys(next).map((k) => `${k}=${next[k]}`).join(", ");
  await addLog(`Settings updated: ${changedKeys}`);
  return settings;
}

async function updateSettingsInternal(next) {
  const settings = { ...(await getSettings()), ...next };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function getEpicCookies() {
  try {
    const [storeCookies, wwwCookies, domainCookies] = await Promise.all([
      chrome.cookies.getAll({ url: "https://store.epicgames.com" }).catch(() => []),
      chrome.cookies.getAll({ url: "https://www.epicgames.com" }).catch(() => []),
      chrome.cookies.getAll({ domain: "epicgames.com" }).catch(() => [])
    ]);
    const map = new Map();
    for (const c of [...storeCookies, ...wwwCookies, ...domainCookies]) {
      map.set(c.name, c);
    }
    return Array.from(map.values());
  } catch (e) {
    return [];
  }
}

async function getCachedAuth() {
  const stored = await chrome.storage.local.get(AUTH_KEY).catch(() => ({}));
  return stored[AUTH_KEY] || { status: "unknown", source: "cached" };
}

async function saveAuth(auth) {
  await chrome.storage.local.set({ [AUTH_KEY]: auth }).catch(() => {});
  return auth;
}

function scheduleAuthRefresh() {
  if (authRefreshTimer) clearTimeout(authRefreshTimer);
  authRefreshTimer = setTimeout(() => {
    authRefreshTimer = null;
    refreshAuthFromCookieChange().catch(() => {});
  }, AUTH_CHANGE_DEBOUNCE_MS);
}

async function refreshAuthFromCookieChange() {
  if (authRefreshInFlight) {
    authRefreshQueued = true;
    return;
  }
  authRefreshInFlight = true;
  try {
    const previous = await getCachedAuth();
    const next = await checkEpicLoginStatus({ force: true });
    if (shouldLogAuthTransition(previous, next)) {
      if (next.status === "logged_in") {
        await addLog(`Real-time auth update: Account logged in (${next.accountLabel || "Connected"}).`);
      } else if (next.status === "logged_out") {
        await addLog("Real-time auth update: Account logged out / session ended.");
      }
    }
  } finally {
    authRefreshInFlight = false;
    if (authRefreshQueued) {
      authRefreshQueued = false;
      scheduleAuthRefresh();
    }
  }
}

async function checkEpicLoginStatus({ force = false } = {}) {
  const cached = await getCachedAuth();
  const checkedAt = Date.parse(cached.checkedAt || "");
  if (!force && cached.status && Number.isFinite(checkedAt) && Date.now() - checkedAt < AUTH_CACHE_TTL_MS) {
    return {
      ...cached,
      isLoggedIn: cached.status === "logged_in",
      accountEmail: cached.accountLabel || null
    };
  }
  if (!force && authProbePromise) return authProbePromise;

  const probe = (async () => {
  try {
    const cookies = await getEpicCookies();
    const hasAuthCookie = cookies.some((c) =>
      c.name === "EPIC_BEARER_TOKEN" ||
      c.name === "EPIC_EG1" ||
      c.name === "EPIC_SSO" ||
      c.name === "EPIC_SESSION_AP" ||
      (c.name === "remember_me" && Boolean(c.value))
    );

    const previous = await getCachedAuth();
    const auth = await saveAuth(resolveAuthObservation({
      api: await fetchEpicLoginState(fetch, 4000),
      hasAuthCookie,
      previous
    }));
    return {
      ...auth,
      isLoggedIn: auth.status === "logged_in",
      accountEmail: auth.accountLabel || null
    };
  } catch (err) {
    const previous = await getCachedAuth();
    return {
      ...previous,
      status: previous.status || "unknown",
      isLoggedIn: previous.status === "logged_in",
      accountEmail: previous.accountLabel || null,
      error: err.message || String(err)
    };
  }
  })();
  authProbePromise = probe;
  try {
    return await probe;
  } finally {
    if (authProbePromise === probe) authProbePromise = null;
  }
}

async function getState() {
  const results = await Promise.allSettled([
    getSettings(),
    chrome.storage.local.get(CATALOG_KEY),
    getEpicClaimedGames(),
    getSessionLogs(),
    checkEpicLoginStatus(),
    getActiveTasks(),
    getClaimQueue()
  ]);
  const value = (index, fallback) => results[index]?.status === "fulfilled" ? results[index].value : fallback;
  const settings = value(0, { ...MODEL_DEFAULT_SETTINGS, initiated: false });
  const stored = value(1, {});
  const claimedGames = value(2, []);
  const logs = value(3, []);
  const authCheck = value(4, { status: "unknown", source: "cached", isLoggedIn: false, accountEmail: null });
  const activeTasks = value(5, []);
  const claimQueue = value(6, null);
  const errors = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") errors[["settings", "catalog", "claimedGames", "logs", "auth", "activeTasks", "claimQueue"][index]] = readableError(result.reason);
  });
  const snapshot = buildStateSnapshot({
    settings: { ...settings, initiated: authCheck.status === "logged_in" || (authCheck.status === "unknown" && settings.initiated === true) },
    catalog: stored[CATALOG_KEY] || emptyCatalog(),
    claimedGames,
    auth: authCheck,
    activeTasks,
    sessionLogs: logs,
    errors
  });
  return {
    ...snapshot,
    claimQueue,
    isClaimRunning: isClaimRunning || claimQueue?.status === "running",
    accountEmail: authCheck.accountEmail || authCheck.accountLabel || null
  };
}

async function clearEpicCookies() {
  try {
    const cookies = await getEpicCookies();
    for (const cookie of cookies) {
      if (cookie.name.includes("EPIC_") || cookie.name.includes("remember")) {
        await Promise.all([
          chrome.cookies.remove({ url: `https://store.epicgames.com${cookie.path || "/"}`, name: cookie.name }).catch(() => {}),
          chrome.cookies.remove({ url: `https://www.epicgames.com${cookie.path || "/"}`, name: cookie.name }).catch(() => {})
        ]);
      }
    }
  } catch (e) {
    // ignore
  }
}

async function getActiveTasks() {
  const stored = await taskStorage().get(TASKS_KEY).catch(() => ({}));
  const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? stored[TASKS_KEY] : {};
  return Object.values(tasks);
}

async function getActiveTask(tabId) {
  const stored = await taskStorage().get(TASKS_KEY).catch(() => ({}));
  return stored[TASKS_KEY]?.[String(tabId)] || null;
}

async function getOrAdoptClaimTask(tabId, pageUrl, allowAdoption = true) {
  const existing = await getActiveTask(tabId);
  if (existing) return existing;
  if (!allowAdoption) return null;

  const queue = await getClaimQueue();
  if (queue?.status === "running" && queue.current?.tabId !== tabId) return null;

  const settings = await getSettings();
  if (settings.autoClaim === false) return null;
  const catalog = (await chrome.storage.local.get(CATALOG_KEY).catch(() => ({})))[CATALOG_KEY] || emptyCatalog();
  const claimed = await getEpicClaimedGames();
  const game = findClaimableGameForUrl(pageUrl, catalog, claimed);
  if (!game) return null;

  const task = { ...createClaimTask({ gameId: game.id, tabId, now: Date.now() }), platform: game.platform || "epic", origin: "opened-page" };
  await saveActiveTask(task);
  spawnedClaimTabIds.add(tabId);
  await addLog(`Auto-adopted opened Epic page for "${game.title}".`);
  return task;
}

async function saveActiveTask(task) {
  const stored = await taskStorage().get(TASKS_KEY).catch(() => ({}));
  const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? stored[TASKS_KEY] : {};
  tasks[String(task.tabId)] = task;
  await taskStorage().set({ [TASKS_KEY]: tasks });
}

async function removeActiveTask(tabId) {
  const stored = await taskStorage().get(TASKS_KEY).catch(() => ({}));
  const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? { ...stored[TASKS_KEY] } : {};
  delete tasks[String(tabId)];
  await taskStorage().set({ [TASKS_KEY]: tasks }).catch(() => {});
}

async function getClaimQueue() {
  const stored = await taskStorage().get(CLAIM_QUEUE_KEY).catch(() => ({}));
  return stored[CLAIM_QUEUE_KEY] || null;
}

async function saveClaimQueue(queue) {
  await taskStorage().set({ [CLAIM_QUEUE_KEY]: queue }).catch(() => {});
  return queue;
}

async function rebindSerialQueueTab(fromTabId, toTabId) {
  const queue = await getClaimQueue();
  const rebound = rebindCurrentClaim(queue, fromTabId, toTabId, Date.now());
  if (rebound && rebound !== queue) await saveClaimQueue(rebound);
}

async function restoreUserTabAfterClaimChild(task, childTab) {
  if (!childTab.active || !Number.isInteger(task.returnTabId) || task.returnTabId === childTab.id) return;
  const returnTab = await chrome.tabs.get(task.returnTabId).catch(() => null);
  if (!returnTab || await getActiveTask(returnTab.id)) return;

  await chrome.tabs.update(returnTab.id, { active: true }).catch(() => null);
  if (returnTab.windowId !== childTab.windowId) {
    await chrome.windows.update(returnTab.windowId, { focused: true }).catch(() => null);
  }
}

async function finishSerialQueueItem(tabId, status, detail) {
  const queue = await getClaimQueue();
  const finished = finishCurrentClaim(queue, { tabId, status, detail, now: Date.now() });
  if (!finished || finished === queue) return false;

  await saveClaimQueue(finished);
  if (finished.status === "completed") {
    await finalizeSerialQueue(finished);
  } else {
    await addLog(`Finished "${queue.current.title}" (${status}). Opening the next queued game...`);
    await pumpClaimQueue();
    const latest = await getClaimQueue();
    if (latest?.status === "running" && !latest.current) await pumpClaimQueue();
  }
  return true;
}

async function finalizeSerialQueue(queue) {
  isClaimRunning = false;
  const failures = queue.results.filter((item) => item.status === "failed").length;
  const successes = queue.results.length - failures;
  const message = `Serial claim queue finished: ${successes} completed, ${failures} failed.`;
  await addLog(message);
  await updateSettingsInternal({
    lastRunAt: new Date().toISOString(),
    lastRunMessage: message,
    lastRunErrors: queue.results.filter((item) => item.status === "failed").slice(0, 3).map((item) => `${item.title}: ${item.detail}`)
  });
}

function emptyCatalog() {
  return { epic: [], refreshedAt: null, errors: {} };
}

async function refreshCatalog({ force = false } = {}) {
  const settings = await getSettings();
  const today = localDayKey();
  const previous = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY] || emptyCatalog();

  if (force) {
    await addLog("Force-refreshing catalog from Epic Games Store...");
  }

  // If not forced and already refreshed today, return cached catalog to prevent redundant network syncs
  if (!force && previous.refreshedAt && previous.refreshedAt.slice(0, 10) === today) {
    await addLog("Catalog is up-to-date for today (cached).");
    return previous;
  }

  const country = settings.country || "VN";
  const [epicResult] = await Promise.allSettled([fetchEpicGames(country)]);

  const epicGames = epicResult.status === "fulfilled" ? epicResult.value : previous.epic || [];
  const catalog = {
    epic: epicGames,
    refreshedAt: new Date().toISOString(),
    errors: {
      ...(epicResult.status === "rejected" ? { epic: readableError(epicResult.reason) } : {})
    }
  };
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  if (epicResult.status === "fulfilled") {
    await addLog(`Catalog updated: ${catalog.epic.length} free game(s) available for region ${country}.`);
  } else {
    await addLog(`Catalog update failed: ${readableError(epicResult.reason)}`);
  }
  return catalog;
}

async function fetchEpicGames(country) {
  const url = new URL("https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions");
  url.searchParams.set("locale", "en-US");
  url.searchParams.set("country", country);
  url.searchParams.set("allowCountries", country);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Epic returned HTTP ${response.status}`);
  const payload = await response.json();
  const elements = payload?.data?.Catalog?.searchStore?.elements || [];
  const now = Date.now();

  return elements
    .filter((offer) => isEpicFreeNow(offer, now))
    .map((offer) => {
      const url = resolveEpicStoreUrl(offer);
      return {
        id: `epic-${offer.id}`,
        platform: "epic",
        title: offer.title,
        image: pickEpicImage(offer.keyImages),
        url,
        expiresAt: currentEpicPromotion(offer, now)?.endDate || null,
        originalPrice: offer.price?.totalPrice?.originalPrice || 0
      };
    });
}

function resolveEpicStoreUrl(offer) {
  const pageSlug = offer.catalogNs?.mappings?.find((mapping) => mapping?.pageSlug)?.pageSlug;
  const slug = pageSlug || offer.productSlug || offer.urlSlug;
  if (!slug) return "https://store.epicgames.com/en-US/free-games";
  if (/^https?:\/\//i.test(slug)) return slug;
  const normalized = slug.replace(/^\/+/, "");
  return `https://store.epicgames.com/en-US/${normalized.startsWith("p/") ? normalized : `p/${normalized}`}`;
}

function isEpicFreeNow(offer, now) {
  const price = offer.price?.totalPrice;
  if (!price || Number(price.discountPrice) !== 0 || Number(price.originalPrice) <= 0) return false;
  return Boolean(currentEpicPromotion(offer, now));
}

function currentEpicPromotion(offer, now) {
  const groups = offer.promotions?.promotionalOffers || [];
  const promotions = groups.flatMap((group) => group.promotionalOffers || []);
  return promotions.find((promotion) => {
    const start = Date.parse(promotion.startDate);
    const end = Date.parse(promotion.endDate);
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
  });
}

function pickEpicImage(images = []) {
  const preferredTypes = ["OfferImageWide", "DieselStoreFrontWide", "Thumbnail"];
  for (const type of preferredTypes) {
    const image = images.find((candidate) => candidate.type === type);
    if (image?.url) return image.url;
  }
  return images[0]?.url || "";
}

async function runDailyCheck() {
  const settings = await getSettings();
  const authCheck = await checkEpicLoginStatus({ force: true });
  const today = localDayKey();

  if (!authCheck.isLoggedIn) {
    await addLog("Daily check skipped: Account not logged in.");
    return;
  }
  if (!settings.autoClaim) {
    await addLog("Daily check skipped: Auto-claim switch is disabled.");
    return;
  }
  if (settings.lastDailyRun === today) {
    await addLog("Daily check skipped: Already executed once today.");
    return;
  }

  await addLog("Daily startup check triggered.");
  await updateSettingsInternal({ lastDailyRun: today });
  await runClaimBatch({ force: false });
}

async function runClaimNow() {
  const authCheck = await checkEpicLoginStatus({ force: true });
  if (authCheck.status === "logged_out") {
    await addLog("Manual Start failed: User not logged in to Epic Games Store.");
    throw new Error("Please log in to Epic Games Store on your browser first.");
  }
  await addLog("Manual Start initiated by user.");
  return runClaimBatch({ force: true });
}

async function runClaimBatch({ force = false }) {
  const existingQueue = await getClaimQueue();
  if (existingQueue?.status === "running") {
    const message = existingQueue.current
      ? `A serial claim is already running for "${existingQueue.current.title}".`
      : "A serial claim queue is already running.";
    await addLog(message);
    await pumpClaimQueue();
    return { total: existingQueue.pending.length + (existingQueue.current ? 1 : 0), queued: existingQueue.pending.length, skipped: 0, failed: 0, message };
  }

  const catalog = await refreshCatalog({ force });
  const games = [...catalog.epic];
  const claimed = await getEpicClaimedGames();
  const completedIds = new Set(claimed.filter(isClaimCompleted).map((game) => game.id));
  const candidates = games.filter((game) => !completedIds.has(game.id));

  if (candidates.length === 0) {
    const message = games.length
      ? "All current free games are already claimed."
      : "No free games available right now.";
    await addLog(message);
    await updateSettingsInternal({ lastRunAt: new Date().toISOString(), lastRunMessage: message });
    return { total: games.length, queued: 0, skipped: games.length, failed: 0, message };
  }

  const queue = createClaimQueue(candidates.map((game) => ({ platform: game.platform, id: game.id, title: game.title })), Date.now());
  await saveClaimQueue(queue);
  isClaimRunning = true;
  const message = `Found ${candidates.length} unclaimed game(s). Starting serial claim queue.`;
  await addLog(message);
  await updateSettingsInternal({
    lastRunAt: new Date().toISOString(),
    lastRunMessage: message,
    lastRunErrors: []
  });
  await pumpClaimQueue();
  return { total: games.length, queued: candidates.length, skipped: games.length - candidates.length, failed: 0, message };
}

async function pumpClaimQueue() {
  if (claimQueuePumpPromise) return claimQueuePumpPromise;
  const pump = (async () => {
    while (true) {
      const queue = await getClaimQueue();
      if (!queue || queue.status !== "running") {
        isClaimRunning = false;
        return queue;
      }
      isClaimRunning = true;
      if (queue.current) return queue;
      const next = queue.pending[0];
      if (!next) {
        const completed = { ...queue, status: "completed", updatedAt: Date.now() };
        await saveClaimQueue(completed);
        await finalizeSerialQueue(completed);
        return completed;
      }

      try {
        await addLog(`Opening claim tab for "${next.title}" (${queue.results.length + 1}/${queue.results.length + queue.pending.length})...`);
        const result = await queueClaim(next.platform, next.id, false, { serialQueue: true });
        if (result.queued) return getClaimQueue();

        const skipped = skipNextClaim(await getClaimQueue(), {
          status: result.reason === "already_claimed" ? "owned" : "failed",
          detail: result.reason || "Claim was skipped.",
          now: Date.now()
        });
        await saveClaimQueue(skipped);
        if (skipped.status === "completed") {
          await finalizeSerialQueue(skipped);
          return skipped;
        }
      } catch (error) {
        const detail = readableError(error);
        const latest = await getClaimQueue();
        const failed = latest?.current
          ? finishCurrentClaim(latest, { tabId: latest.current.tabId, status: "failed", detail, now: Date.now() })
          : skipNextClaim(latest, { status: "failed", detail, now: Date.now() });
        if (latest?.current) {
          spawnedClaimTabIds.delete(latest.current.tabId);
          await removeActiveTask(latest.current.tabId);
          try { await chrome.tabs.remove(latest.current.tabId); } catch (e) { /* already closed */ }
        }
        await recordClaimStatus(next.platform, next.id, "failed", detail);
        await addLog(`Failed to start "${next.title}": ${detail}`);
        await saveClaimQueue(failed);
        if (failed?.status === "completed") {
          await finalizeSerialQueue(failed);
          return failed;
        }
      }
    }
  })();
  claimQueuePumpPromise = pump;
  try {
    return await pump;
  } finally {
    if (claimQueuePumpPromise === pump) claimQueuePumpPromise = null;
  }
}

function localDayKey() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

async function queueClaim(platform, id, active = false, { serialQueue = false } = {}) {
  const catalog = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY] || emptyCatalog();
  const game = (catalog[platform] || []).find((item) => item.id === id);
  if (!game) throw new Error("Game is no longer in the current free-games list");

  const claimed = await getEpicClaimedGames();
  if (claimed.some((item) => item.id === id && isClaimCompleted(item))) {
    await addLog(`Skipped claim for "${game.title}": already claimed.`);
    return { queued: false, reason: "already_claimed" };
  }

  await recordClaimStatus(platform, id, "attempting", "Opening background claim tab...");
  const url = new URL(game.url);
  const [returnTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = await chrome.tabs.create({ url: "about:blank", active: Boolean(active) });
  if (!tab?.id) throw new Error("Epic claim tab could not be created.");
  const task = createClaimTask({ gameId: game.id, tabId: tab.id, now: Date.now() });
  await saveActiveTask({
    ...task,
    platform,
    claimWindowId: tab.windowId,
    returnTabId: returnTab?.id,
    returnWindowId: returnTab?.windowId
  });
  spawnedClaimTabIds.add(tab.id);
  if (serialQueue) {
    const queue = await getClaimQueue();
    const started = beginNextClaim(queue, tab.id, Date.now());
    if (!started?.current || started.current.tabId !== tab.id || started.current.id !== id) {
      spawnedClaimTabIds.delete(tab.id);
      await removeActiveTask(tab.id);
      try { await chrome.tabs.remove(tab.id); } catch (e) { /* already closed */ }
      return { queued: false, reason: "queue_not_running" };
    }
    await saveClaimQueue(started);
  }
  await chrome.tabs.update(tab.id, { url: url.toString() });
  await addLog(`Spawned tab #${tab?.id} for "${game.title}"`);
  return { queued: true, tabId: tab.id };
}

async function recordClaimStatus(platform, id, status, detail = "") {
  const catalog = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY] || emptyCatalog();
  const game = (catalog[platform] || []).find((item) => item.id === id);
  if (!game) return;

  const claimed = await getEpicClaimedGames();
  const record = {
    ...game,
    status,
    detail,
    claimedAt: new Date().toISOString()
  };
  const index = claimed.findIndex((item) => item.id === id);
  const wasCompleted = index >= 0 && isClaimCompleted(claimed[index]);
  if (index >= 0) claimed[index] = { ...claimed[index], ...record };
  else claimed.unshift(record);
  await chrome.storage.local.set({ [CLAIMED_KEY]: claimed.slice(0, 250) });

  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  if (isClaimCompleted(record) && !wasCompleted && !completionNotificationIds.has(id)) {
    completionNotificationIds.add(id);
    void showClaimSuccessNotification(record).catch((error) => {
      void addLog(`Claim notification failed for "${record.title}": ${readableError(error)}`).catch(() => {});
    });
  }
  return record;
}

async function showClaimSuccessNotification(game) {
  const queue = await getClaimQueue();
  let contextMessage = "Added to your Epic Games library";
  if (queue?.current?.id === game.id) {
    const completed = queue.results.length + 1;
    const total = completed + queue.pending.length;
    contextMessage = queue.pending.length > 0
      ? `${completed} of ${total} claimed · Next game starting`
      : `${completed} of ${total} claimed · Queue complete`;
  }

  const notificationId = `claim-${game.id}-${Date.now()}`;
  const fallbackIcon = "icons/icon128.png";
  let iconUrl = fallbackIcon;
  if (game.image) {
    try {
      iconUrl = await fetchNotificationImageDataUrl(game.image);
    } catch (error) {
      await addLog(`Unable to prepare the game cover for "${game.title}" notification: ${readableError(error)}`);
    }
  }
  const options = {
    type: "basic",
    iconUrl,
    title: "Claimed successfully",
    message: `${game.title} added to your library`,
    contextMessage,
    priority: 0,
    requireInteraction: false,
    silent: true
  };

  try {
    await chrome.notifications.create(notificationId, options);
  } catch (error) {
    if (options.iconUrl !== fallbackIcon) {
      try {
        await chrome.notifications.create(notificationId, { ...options, iconUrl: fallbackIcon });
        return;
      } catch (fallbackError) {
        await addLog(`Claim notification failed for "${game.title}": ${readableError(fallbackError)}`);
        return;
      }
    }
    await addLog(`Claim notification failed for "${game.title}": ${readableError(error)}`);
  }
}

async function fetchNotificationImageDataUrl(imageUrl) {
  const url = new URL(imageUrl);
  if (url.protocol === "data:" || url.protocol === "blob:") return url.toString();
  if (url.protocol !== "https:") throw new Error("Game cover must use HTTPS.");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFICATION_COVER_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      credentials: "omit",
      cache: "force-cache",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Game cover returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") || "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) throw new Error("Game cover response was not an image.");

    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getEpicClaimedGames() {
  await ensureStorageMigration();
  const { [CLAIMED_KEY]: claimed = [] } = await chrome.storage.local.get(CLAIMED_KEY);
  return normalizeClaimedGames(claimed);
}

async function openEpicLoginTab() {
  await addLog("Opening Epic Games Store login page...");
  await chrome.tabs.create({ url: "https://store.epicgames.com/en-US/login", active: true });
}

async function openEpicStoreGame(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "store.epicgames.com") {
    throw new Error("Only Epic Games Store URLs can be opened from the library.");
  }
  await chrome.tabs.create({ url: url.toString(), active: true });
}

function readableError(error) {
  return error?.message || String(error);
}

function isClaimCompleted(game) {
  return game.status === "claimed" || game.status === "owned";
}
