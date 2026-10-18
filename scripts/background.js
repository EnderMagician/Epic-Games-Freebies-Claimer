importScripts("core/state-model.js", "core/auth-model.js", "core/auth-client.js", "core/claim-machine.js", "core/claim-routing.js", "core/claim-queue.js", "core/epic-library.js");

const { DEFAULT_SETTINGS: MODEL_DEFAULT_SETTINGS, normalizeSettings, normalizeClaimedGames, migrateStoredState, buildStateSnapshot } = FreebiesStateModel;
const { resolveAuthObservation, shouldLogAuthTransition } = FreebiesAuthModel;
const { fetchLoginState: fetchEpicLoginState } = FreebiesAuthClient;
const { createClaimTask, reduceClaimTask } = FreebiesClaimMachine;
const { findClaimableGameForUrl } = FreebiesClaimRouting;
const { createClaimQueue, beginNextClaim, rebindCurrentClaim, finishCurrentClaim, skipNextClaim, cancelClaimQueue } = FreebiesClaimQueue;
const { orderHistoryUrl, parseOrderHistory, findOwnedItem, mergeOwnedIntoClaimed, STORE_CONTENT_URL, thumbnailSlugCandidates, extractStoreContentImage, thumbnailUrl } = FreebiesEpicLibrary;

const CATALOG_KEY = "catalog";
const CLAIMED_KEY = "claimedGames";
const SETTINGS_KEY = "settings";
const LOGS_KEY = "sessionLogs";
const AUTH_KEY = "authState";
const TASKS_KEY = "activeClaimTasks";
const CLAIM_QUEUE_KEY = "claimQueue";
const STORAGE_VERSION_KEY = "storageSchemaVersion";
const MIGRATION_BACKUP_KEY = "migrationBackupV2";
const LIBRARY_KEY = "epicLibrary";
// Kept apart from claimedGames so the 5-second popup poll never carries image bytes.
const THUMBS_KEY = "libraryThumbs";
const THUMBNAIL_MAX_BYTES = 12_000;
const SCHEDULE_STATE_KEY = "scheduleState";
const ALARM_NAME = "freebies-daily-check";
const CLAIM_WATCHDOG_ALARM = "freebies-claim-watchdog";
const STARTUP_RETRY_ALARM = "freebies-startup-retry";
const NEXT_DROP_ALARM = "freebies-next-drop";
const SCHEDULED_CHECK_MINUTES = 60;
const STARTUP_RETRY_LIMIT = 5;
const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const LIBRARY_SYNC_TTL_MS = 30 * 60 * 1000;
const LIBRARY_MAX_PAGES = 40;
const OWNERSHIP_CHECK_INTERVAL_MS = 10_000;
const OWNERSHIP_CHECK_GRACE_MS = 20_000;
const CONFIRM_RELOAD_MS = 25_000;
const NEEDS_ATTENTION_TIMEOUT_MS = 15 * 60 * 1000;
const AUTO_RETRY_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const CLAIMED_LIMIT = 2000;
const MAX_ACCOUNT_PICKS = 2;
const THUMBNAIL_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const THUMBNAIL_CONCURRENCY = 4;
const ACCOUNT_PICK_INTERVAL_MS = 8000;
const AUTH_CACHE_TTL_MS = 15000;
const AUTH_CHANGE_DEBOUNCE_MS = 750;
const NOTIFICATION_COVER_TIMEOUT_MS = 2000;
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CLICK_FAILURES = 3;

let isClaimRunning = false;
let sessionLogs = [];
let spawnedClaimTabIds = new Set();
let authProbePromise = null;
let authRefreshTimer = null;
let authRefreshInFlight = false;
let authRefreshQueued = false;
let claimQueuePumpPromise = null;
let claimStateMutation = Promise.resolve();
let claimQueueLock = Promise.resolve();
let scheduledCheckPromise = null;
let librarySyncPromise = null;
let thumbnailPromise = null;
let sessionLogMutation = Promise.resolve();
const claimTaskMutations = new Map();
const claimLogKeys = new Map();
const claimUniqueLogKeys = new Set();
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
  const write = sessionLogMutation.then(async () => {
    await getSessionLogs();
    const entry = `[${formatLogTimestamp()}] ${msg}`;
    sessionLogs.unshift(entry);
    if (sessionLogs.length > 80) sessionLogs.pop();
    await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
  }, async () => {
    await getSessionLogs();
    const entry = `[${formatLogTimestamp()}] ${msg}`;
    sessionLogs.unshift(entry);
    if (sessionLogs.length > 80) sessionLogs.pop();
    await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
  });
  sessionLogMutation = write.catch(() => {});
  return write;
}

async function addClaimLog(key, msg) {
  const now = Date.now();
  const previous = claimLogKeys.get(key) || 0;
  if (now - previous < 10_000) return;
  if (claimLogKeys.size >= 500) claimLogKeys.delete(claimLogKeys.keys().next().value);
  claimLogKeys.set(key, now);
  for (const [savedKey, savedAt] of claimLogKeys) {
    if (now - savedAt > 60_000) claimLogKeys.delete(savedKey);
  }
  await addLog(msg);
}

async function addUniqueClaimLog(key, msg) {
  if (claimUniqueLogKeys.has(key)) return;
  if (claimUniqueLogKeys.size >= 500) claimUniqueLogKeys.delete(claimUniqueLogKeys.values().next().value);
  claimUniqueLogKeys.add(key);
  await addLog(msg);
}

function safeLogDetail(value, maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function formatLogTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await addLog("Extension installed / reloaded.");
  await ensureAlarms();
  await refreshCatalog({ force: true });
  await runScheduledCheck("install");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  await addLog("Browser startup detected.");
  await ensureAlarms();
  await reconcileClaimState();
  await saveScheduleState({ startupRetries: 0 });
  if ((await getSettings()).runOnStartup) await runScheduledCheck("startup");
  else await addLog("Startup check skipped: Run on browser startup is disabled.");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await runScheduledCheck("periodic");
  if (alarm.name === STARTUP_RETRY_ALARM) await runScheduledCheck("startup-retry");
  if (alarm.name === NEXT_DROP_ALARM) await runScheduledCheck("new-drop");
  if (alarm.name === CLAIM_WATCHDOG_ALARM) await reconcileClaimState();
});

// Re-creating a periodic alarm restarts its countdown, so recreate it only when
// it is missing or still uses an older period.
async function ensureAlarms() {
  const getAlarm = (name) => Promise.resolve(chrome.alarms.get?.(name)).catch(() => null);
  const periodic = await getAlarm(ALARM_NAME);
  if (!periodic || periodic.periodInMinutes !== SCHEDULED_CHECK_MINUTES) {
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: SCHEDULED_CHECK_MINUTES });
  }
  const watchdog = await getAlarm(CLAIM_WATCHDOG_ALARM);
  if (!watchdog) chrome.alarms.create(CLAIM_WATCHDOG_ALARM, { periodInMinutes: 1 });
}

// Every queue read-modify-write runs through this lock so tab events, the
// watchdog and popup polling cannot overwrite each other's queue state.
function withQueueLock(operation) {
  const run = claimQueueLock.then(operation, operation);
  claimQueueLock = run.catch(() => {});
  return run;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  spawnedClaimTabIds.delete(tabId);
  // Every extension-initiated close removes the task first, so only a tab the
  // user (or Epic) closed reaches the locked path below.
  if (!await getActiveTask(tabId)) return;
  await withQueueLock(async () => {
    const task = await getActiveTask(tabId);
    if (!task) return;
    await removeActiveTask(tabId);
    // The order may have gone through even though the page never showed it.
    if (task.attempts > 0 && await isOwnedOnAccount(task)) {
      await completeOwnedTask(task, tabId, "Epic order history confirms ownership.", { closeTab: false });
      return;
    }
    const detail = "Claim tab was closed before Epic confirmed ownership.";
    await recordClaimStatus(task.platform || "epic", task.gameId, "failed", detail);
    await addLog(`Claim failed for "${safeLogDetail(task.title || task.gameId, 100)}": ${detail}`);
    await finishSerialQueueItem(tabId, "failed", detail);
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab?.id || !tab.openerTabId) return;
  if (!await getActiveTask(tab.openerTabId)) return;
  await withQueueLock(() => rebindClaimToChildTab(tab));
});

async function rebindClaimToChildTab(tab) {
  const task = await getActiveTask(tab.openerTabId);
  if (!task) return;
  await removeActiveTask(tab.openerTabId);
  // Epic can put a second Get action in its checkout child tab. Treat the child
  // as a fresh page while retaining the claim identity and queue ownership.
  const rebound = {
    ...task,
    tabId: tab.id,
    frameId: 0,
    phase: "waiting_for_get",
    terminalReason: null,
    updatedAt: Date.now(),
    lastProgressAt: Date.now()
  };
  await saveActiveTask(rebound);
  await rebindSerialQueueTab(tab.openerTabId, tab.id);
  spawnedClaimTabIds.delete(tab.openerTabId);
  spawnedClaimTabIds.add(tab.id);
  await addLog(`Rebound claim task for ${task.gameId} to child tab #${tab.id}.`);
  await restoreUserTabAfterClaimChild(task, tab);
}

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
    cookie.name === "EPIC_SSO_RM" ||
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

function serializeClaimTask(tabId, operation) {
  const key = String(tabId);
  const previous = claimTaskMutations.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  const tracked = next.catch(() => {});
  claimTaskMutations.set(key, tracked);
  return next.finally(() => {
    if (claimTaskMutations.get(key) === tracked) claimTaskMutations.delete(key);
  });
}

function isTrustedEpicHost(hostname, { checkout = false } = {}) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'store.epicgames.com' || host === 'www.epicgames.com') return true;
  return checkout && host === 'payment-website-pci.ol.epicgames.com';
}

function isTrustedClaimFrame(sender, message = {}) {
  const frameId = sender?.frameId || 0;
  let parsed;
  if (!sender?.url) return frameId === 0;
  try { parsed = new URL(sender.url); } catch (error) { return false; }
  if (parsed.protocol !== "https:") return false;
  const context = message.frameContext || message.observation?.context || '';
  if (!isTrustedEpicHost(parsed.hostname, { checkout: frameId !== 0 || context === 'checkout' })) return false;
  if (frameId === 0) return true;
  const checkoutPath = /(?:\/purchase|\/checkout|\/payment)/i.test(parsed.pathname + parsed.search);
  return context === 'checkout' && (checkoutPath || parsed.hostname === 'payment-website-pci.ol.epicgames.com');
}

async function logClaimAttachment(task, sender, context = 'unknown') {
  const frameId = sender?.frameId || 0;
  const key = `attachment:${task.gameId}:${task.tabId}:${frameId}`;
  await addUniqueClaimLog(key, `Attached claim observer for "${safeLogDetail(task.title || task.gameId, 100)}" (tab #${task.tabId}, frame #${frameId}, ${context}).`);
}

function claimObservationDiagnosticKey(task, sender, observation, decision) {
  return [
    'diagnostic', task.gameId, task.tabId, sender?.frameId || 0,
    observation.context || 'unknown', observation.offerEvidence || 'unknown',
    observation.checkoutTotalEvidence || 'unknown',
    (observation.visibleActions || []).join(','), (observation.blockers || []).join(','),
    decision.action, decision.reason
  ].join(':');
}

async function logClaimObservation(task, sender, observation, decision) {
  const actions = (observation.visibleActions || []).join(',') || 'none';
  const blockers = (observation.blockers || []).join(',') || 'none';
  const context = observation.context || 'unknown';
  const offer = observation.offerEvidence || 'unknown';
  const checkout = observation.checkoutTotalEvidence || 'unknown';
  const detail = `Claim "${safeLogDetail(task.title || task.gameId, 100)}" (tab #${task.tabId}, frame #${sender?.frameId || 0}, ${context}): actions=${actions}; offer=${offer}; checkout_total=${checkout}; blockers=${blockers}; ${decision.action} - ${safeLogDetail(decision.reason)}.`;
  await addUniqueClaimLog(claimObservationDiagnosticKey(task, sender, observation, decision), detail);
}

// Epic's web session expires after ~8 hours; the next purchase then detours
// through the "Welcome back" account picker. Pick a lone remembered account so
// the purchase intent resumes; anything else (password, MFA, several accounts)
// pauses the claim for the user.
async function handleAccountPicker(task, sender, observation) {
  const picker = observation.accountPicker;
  const now = Date.now();
  const title = safeLogDetail(task.title || task.gameId, 100);
  const picks = task.accountPicks || 0;
  if (picker.state === "single" && picks < MAX_ACCOUNT_PICKS) {
    if (now - (task.lastAccountPickAt || 0) < ACCOUNT_PICK_INTERVAL_MS) {
      return { task, decision: { action: "wait", reason: "Waiting for Epic to finish signing in." } };
    }
    const next = {
      ...task,
      phase: task.phase === "needs_attention" ? (task.resumePhase || "awaiting_outcome") : task.phase,
      terminalReason: null,
      accountPicks: picks + 1,
      lastAccountPickAt: now,
      lastProgressAt: now,
      pendingAction: { kind: "click_account", frameId: 0, requestedAt: now }
    };
    await saveActiveTask(next);
    await addLog(`Claim "${title}": Epic session expired and asked to pick the remembered account; selecting it (${picks + 1}/${MAX_ACCOUNT_PICKS}).`);
    return { task: next, decision: { action: "click_account", reason: "Selecting the remembered Epic account." } };
  }

  const reason = picker.state === "password"
    ? "Epic asks for your password or a security code; sign in manually in the claim tab."
    : picker.state === "single"
      ? "Epic kept asking to pick the account after two attempts; sign in manually in the claim tab."
      : `Epic's sign-in page shows ${picker.count || 0} selectable account(s); pick yours manually in the claim tab.`;
  const paused = {
    ...task,
    resumePhase: task.phase === "needs_attention" ? task.resumePhase : task.phase,
    phase: "needs_attention",
    terminalReason: "login",
    lastProgressAt: task.phase === "needs_attention" ? task.lastProgressAt : now
  };
  await saveActiveTask(paused);
  if (task.phase !== "needs_attention" || task.terminalReason !== "login") {
    await recordClaimStatus(task.platform || "epic", task.gameId, "needs_attention", reason);
    const labels = (picker.labels || []).length ? ` Controls seen: ${picker.labels.join(" | ")}.` : "";
    await addLog(`Serial queue paused for "${title}": ${reason}${safeLogDetail(labels, 300)}`);
  }
  return { task: paused, decision: { action: "needs_attention", reason } };
}

async function completeOwnedTask(task, tabId, reason, { closeTab = true } = {}) {
  await recordClaimStatus(task.platform || "epic", task.gameId, "owned", reason);
  await removeActiveTask(tabId);
  spawnedClaimTabIds.delete(tabId);
  if (closeTab) {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
  }
  await finishSerialQueueItem(tabId, "owned", reason);
}

// When the page cannot prove ownership (Epic's markup changes often), fall back
// to the account's order history, then to one reload of the product page.
async function checkStalledClaim(task, sender) {
  if (!task || task.phase === "needs_attention" || task.clickRetriesExhausted) return null;
  const now = Date.now();
  const clicked = (task.attempts || 0) > 0;
  if (!clicked && now - (task.startedAt || now) < OWNERSHIP_CHECK_GRACE_MS) return null;
  if (now - (task.lastOwnershipCheckAt || 0) < OWNERSHIP_CHECK_INTERVAL_MS) return null;

  // Mutate the reduced task in place so the caller's save keeps the throttle stamp.
  task.lastOwnershipCheckAt = now;
  const checked = task;
  if (await isOwnedOnAccount(task)) {
    const reason = "Epic order history confirms ownership.";
    await withQueueLock(() => completeOwnedTask(task, sender.tab.id, reason));
    return { task: { ...checked, phase: "completed" }, decision: { action: "complete_owned", reason } };
  }

  const sinceAction = now - (task.lastActionAt || now);
  if (task.phase === "confirmation_clicked" && sinceAction >= CONFIRM_RELOAD_MS && !task.reloadedAfterConfirm) {
    // A reload re-renders the CTA as "In Library", or shows Get again if the
    // order did not go through; either way the observer can decide again.
    const reloaded = { ...checked, reloadedAfterConfirm: true, phase: "waiting_for_get", pendingAction: null, lastProgressAt: now };
    await saveActiveTask(reloaded);
    await chrome.tabs.reload(sender.tab.id).catch(() => {});
    const reason = "No ownership signal after the order click; reloading the product page.";
    await addLog(`Claim "${safeLogDetail(task.title || task.gameId, 100)}": ${reason}`);
    return { task: reloaded, decision: { action: "wait", reason } };
  }
  return null;
}

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
      return withQueueLock(async () => {
        if ((await getClaimQueue())?.status === "running" || (await getActiveTasks()).length > 0) throw new Error("A claim is already running.");
        await queueClaim(message.platform, message.id, false);
        return {};
      });
    case "claim-ready":
      if (!sender?.tab?.id) return { task: null };
      if (sender.frameId !== 0) {
        const task = await getActiveTask(sender.tab.id);
        if (!task || !isTrustedClaimFrame(sender, message)) return { task: null };
        await logClaimAttachment(task, sender, message.frameContext || 'unknown');
        return { task };
      }
      if (!isTrustedClaimFrame(sender, message)) return { task: null };
      const task = await getOrAdoptClaimTask(sender.tab.id, sender.url || message.url || sender.tab.url || "", message.allowAdoption !== false);
      if (task) await logClaimAttachment(task, sender, message.frameContext || 'unknown');
      return { task };
    case "claim-observation": {
      if (!sender?.tab?.id) return { task: null, decision: { action: "wait", reason: "No tab context." } };
      return serializeClaimTask(sender.tab.id, async () => {
        const task = await getActiveTask(sender.tab.id);
        if (!task) return { task: null, decision: { action: "wait", reason: "No active claim task for this tab." } };
        if (!isTrustedClaimFrame(sender, message)) {
          const decision = { action: "wait", reason: "Ignoring an untrusted Epic frame." };
          await addClaimLog(`route:${sender.tab.id}:${sender.frameId || 0}`, `Ignored untrusted claim frame for ${task.gameId}.`);
          return { task, decision };
        }
        const observation = { ...(message.observation || {}) };
        if (sender.frameId !== 0 && observation.context !== "checkout") {
          const decision = { action: "wait", reason: "Waiting for a trusted checkout frame." };
          await logClaimObservation(task, sender, observation, decision);
          return { task, decision };
        }
        if (sender.frameId === 0 && observation.accountPicker) {
          return handleAccountPicker(task, sender, observation);
        }
        if (sender.frameId === 0 && observation.identityMatch === false) {
          const decision = { action: "wait", reason: "Waiting for the queued product page." };
          await logClaimObservation(task, sender, observation, decision);
          return { task, decision };
        }
        if (task.clickRetriesExhausted && !observation.ownershipVisible) {
          const decision = {
            action: "needs_attention",
            reason: task.terminalReason || "Manual attention required after repeated failed clicks."
          };
          await logClaimObservation(task, sender, observation, decision);
          return { task, decision };
        }
        const reduced = reduceClaimTask({ ...task, frameId: sender.frameId ?? task.frameId }, observation, Date.now());
        if (reduced.decision.action === "wait") {
          const fallback = await checkStalledClaim(reduced.task, sender);
          if (fallback) {
            await logClaimObservation(task, sender, observation, fallback.decision);
            return fallback;
          }
        }
        await logClaimObservation(task, sender, observation, reduced.decision);
        const taskWithAction = ['click_get', 'click_confirm'].includes(reduced.decision.action)
          ? {
            ...reduced.task,
            pendingAction: {
              kind: reduced.decision.action,
              frameId: sender.frameId || 0,
              requestedAt: Date.now()
            }
          }
          : reduced.task;
        await saveActiveTask(taskWithAction);
        if (reduced.decision.action === "complete_owned") {
          await withQueueLock(() => completeOwnedTask(task, sender.tab.id, reduced.decision.reason));
        } else if (reduced.decision.action === "needs_attention") {
          if (task.phase !== "needs_attention" || task.terminalReason !== reduced.task.terminalReason) {
            await recordClaimStatus(task.platform || "epic", task.gameId, "needs_attention", reduced.decision.reason);
            await addLog(`Serial queue paused for ${task.gameId}: ${reduced.decision.reason}`);
          }
        }
        return { task: taskWithAction, decision: reduced.decision };
      });
    }
    case "claim-action-result":
      if (sender?.tab?.id) {
        if (!isTrustedClaimFrame(sender, message)) return {};
        await serializeClaimTask(sender.tab.id, async () => {
          const task = await getActiveTask(sender.tab.id);
          if (!task) return;
          const action = message.action || "unknown";
          const success = message.success !== false;
          const detail = safeLogDetail(message.detail || "");
          const pending = task.pendingAction;
          const matchesPending = pending && pending.frameId === (sender.frameId || 0)
            && ((pending.kind === "click_get" && action === "get")
              || (pending.kind === "click_account" && action === "pick_account")
              || (pending.kind === "click_confirm" && ['add_to_library', 'place_order'].includes(action)));
          await addClaimLog(`action:${sender.tab.id}:${sender.frameId || 0}:${action}:${success}:${detail}`, `Claim action ${action} ${success ? "succeeded" : "failed"} for ${task.gameId}${detail ? `: ${detail}` : "."}`);
          if (!matchesPending) return;
          if (success) {
            await saveActiveTask({ ...task, pendingAction: null, updatedAt: Date.now() });
            return;
          }
          if (!success && (action === "get" || action === "add_to_library" || action === "place_order")) {
            const failures = (task.clickFailures || 0) + 1;
            const recovered = {
              ...task,
              phase: failures >= MAX_CLICK_FAILURES ? "needs_attention" : action === "get" ? "waiting_for_get" : "awaiting_outcome",
              terminalReason: detail || `Click ${action} failed.`,
              clickFailures: failures,
              clickRetriesExhausted: failures >= MAX_CLICK_FAILURES,
              pendingAction: null,
              updatedAt: Date.now(),
              // Preserve the progress clock on failures so retries cannot keep a
              // stalled task alive forever.
              lastProgressAt: task.lastProgressAt
            };
            await saveActiveTask(recovered);
            await addClaimLog(`recovery:${sender.tab.id}:${action}:${failures}`, failures >= MAX_CLICK_FAILURES
              ? `Stopped retrying ${action} for ${task.gameId} after ${MAX_CLICK_FAILURES} failed clicks; manual attention required.`
              : `Will retry ${action} for ${task.gameId} after failed click ${failures}/${MAX_CLICK_FAILURES}.`);
            if (failures >= MAX_CLICK_FAILURES) {
              await recordClaimStatus(task.platform || "epic", task.gameId, "needs_attention", recovered.terminalReason);
            }
          }
        });
      } else {
        await addLog(`Claim action ${message.action || "unknown"} failed: missing tab context.`);
      }
      return {};
    case "claim-observation-log": {
      const task = sender?.tab?.id ? await getActiveTask(sender.tab.id) : null;
      if (!task || !isTrustedClaimFrame(sender, { frameContext: message.observation?.context, observation: message.observation })) return {};
      const observation = message.observation || {};
      await logClaimObservation(task, sender, observation, {
        action: message.decision || "wait",
        reason: message.reason || "state changed"
      });
      return {};
    }
    case "claim-observer-failed": {
      if (!sender?.tab?.id) return {};
      if (sender.frameId !== 0) return {};
      if (!await getActiveTask(sender.tab.id)) return {};
      // With all_frames, an unattached child must never terminate its tab task.
      if (!isTrustedClaimFrame(sender, message)) return {};
      return withQueueLock(async () => {
        const task = await getActiveTask(sender.tab.id);
        if (!task) return {};
        const detail = message.detail || "Claim observer could not attach to the active task.";
        await recordClaimStatus(task.platform || "epic", task.gameId, "failed", detail);
        await addLog(`Claim observer failed for ${task.gameId}: ${detail}`);
        spawnedClaimTabIds.delete(sender.tab.id);
        await removeActiveTask(sender.tab.id);
        await chrome.tabs.remove(sender.tab.id).catch(() => {});
        await finishSerialQueueItem(sender.tab.id, "failed", detail);
        return {};
      });
    }
    case "run-claim-now":
      return { summary: await runClaimNow() };
    case "sync-library":
      return { library: await syncEpicLibrary({ force: true }) };
    case "resolve-thumbnails":
      // Fire and forget: covers stream into storage and the popup poll picks them up.
      void resolveLibraryThumbnails().catch(() => {});
      return {};
    case "kill-instance":
      return withQueueLock(killInstance);
    case "clear-logs":
      return clearLogs();
    case "claim-attempt":
      await recordClaimStatus(message.platform, message.id, "attempting", message.detail);
      await addLog(`Claim attempting for ${message.id}: ${message.detail || ""}`);
      return {};
    case "claim-result":
      if (!isTrustedClaimFrame(sender, message)) return {};
      return withQueueLock(async () => {
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
      });
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
  const clear = sessionLogMutation.then(async () => {
    const initEntry = `[${formatLogTimestamp()}] Session logs cleared.`;
    sessionLogs = [initEntry];
    claimLogKeys.clear();
    claimUniqueLogKeys.clear();
    await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
    return { sessionLogs };
  }, async () => {
    const initEntry = `[${formatLogTimestamp()}] Session logs cleared.`;
    sessionLogs = [initEntry];
    claimLogKeys.clear();
    claimUniqueLogKeys.clear();
    await chrome.storage.local.set({ [LOGS_KEY]: sessionLogs });
    return { sessionLogs };
  });
  sessionLogMutation = clear.catch(() => {});
  return clear;
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
        if ((await getScheduleState()).pendingCheck) void runScheduledCheck("login").catch(() => {});
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

    // EPIC_SSO_RM outlives the ~8 hour session; with it Epic offers the
    // "Welcome back" picker, which the claim observer can complete.
    const remembered = cookies.some((c) => c.name === "EPIC_SSO_RM" && Boolean(c.value));
    const previous = await getCachedAuth();
    const auth = await saveAuth({
      ...resolveAuthObservation({
        api: await fetchEpicLoginState(fetch, 4000),
        hasAuthCookie,
        previous
      }),
      remembered
    });
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
  await reconcileClaimState();
  const results = await Promise.allSettled([
    getSettings(),
    chrome.storage.local.get(CATALOG_KEY),
    getEpicClaimedGames(),
    getSessionLogs(),
    checkEpicLoginStatus(),
    getActiveTasks(),
    getClaimQueue(),
    getLibraryState()
  ]);
  const value = (index, fallback) => results[index]?.status === "fulfilled" ? results[index].value : fallback;
  const settings = value(0, { ...MODEL_DEFAULT_SETTINGS, initiated: false });
  const stored = value(1, {});
  const claimedGames = value(2, []);
  const logs = value(3, []);
  const authCheck = value(4, { status: "unknown", source: "cached", isLoggedIn: false, accountEmail: null });
  const activeTasks = value(5, []);
  const claimQueue = value(6, null);
  const library = value(7, null);
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
    library,
    isClaimRunning: isClaimRunning || claimQueue?.status === "running" || activeTasks.length > 0,
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

function mutateClaimState(operation) {
  const mutation = claimStateMutation.then(operation, operation);
  claimStateMutation = mutation.catch(() => {});
  return mutation;
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

  const task = {
    ...createClaimTask({ gameId: game.id, tabId, now: Date.now(), title: game.title, url: game.url, catalogEligible: true }),
    platform: game.platform || "epic",
    origin: "opened-page"
  };
  await saveActiveTask(task);
  spawnedClaimTabIds.add(tabId);
  await addLog(`Auto-adopted opened Epic page for "${game.title}".`);
  return task;
}

async function saveActiveTask(task) {
  return mutateClaimState(async () => {
    const stored = await taskStorage().get(TASKS_KEY).catch(() => ({}));
    const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? stored[TASKS_KEY] : {};
    tasks[String(task.tabId)] = task;
    await taskStorage().set({ [TASKS_KEY]: tasks });
    return task;
  });
}

async function removeActiveTask(tabId) {
  return mutateClaimState(async () => {
    const stored = await taskStorage().get(TASKS_KEY).catch(() => ({}));
    const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? { ...stored[TASKS_KEY] } : {};
    delete tasks[String(tabId)];
    await taskStorage().set({ [TASKS_KEY]: tasks }).catch(() => {});
  });
}

async function getClaimQueue() {
  const stored = await taskStorage().get(CLAIM_QUEUE_KEY).catch(() => ({}));
  return stored[CLAIM_QUEUE_KEY] || null;
}

async function saveClaimQueue(queue) {
  return mutateClaimState(async () => {
    await taskStorage().set({ [CLAIM_QUEUE_KEY]: queue }).catch(() => {});
    return queue;
  });
}

function reconcileClaimState() {
  return withQueueLock(reconcileClaimStateLocked);
}

async function reconcileClaimStateLocked() {
  const queue = await getClaimQueue();
  if (!queue || queue.status !== "running") return queue;
  if (!queue.current) {
    await pumpClaimQueue();
    return getClaimQueue();
  }

  const current = queue.current;
  const task = await getActiveTask(current.tabId);
  const tab = await chrome.tabs.get(current.tabId).catch(() => null);
  const taskAge = Date.now() - (task?.lastProgressAt || current.startedAt || Date.now());
  // Manual blockers get a longer window so an unattended scan still moves on.
  const timeout = task?.phase === "needs_attention" ? NEEDS_ATTENTION_TIMEOUT_MS : CLAIM_TIMEOUT_MS;
  if (tab && task && taskAge < timeout) return queue;

  if (tab && task) {
    if (await isOwnedOnAccount(task)) {
      await completeOwnedTask(task, current.tabId, "Epic order history confirms ownership.");
      return getClaimQueue();
    }
    const detail = task.phase === "needs_attention"
      ? `Claim stayed blocked (${task.terminalReason || "manual attention"}) for 15 minutes.`
      : `Claim timed out in phase ${task.phase} (${safeLogDetail(task.lastObservation ? `actions=${(task.lastObservation.visibleActions || []).join(",") || "none"}, context=${task.lastObservation.context || "unknown"}` : "no page observation received", 120)}).`;
    const failed = finishCurrentClaim(queue, { tabId: current.tabId, status: "failed", detail, now: Date.now() });
    await removeActiveTask(current.tabId);
    spawnedClaimTabIds.delete(current.tabId);
    await chrome.tabs.remove(current.tabId).catch(() => {});
    await recordClaimStatus(current.platform || "epic", current.id, "failed", detail);
    await saveClaimQueue(failed);
    await addLog(`Timed out claim for "${current.title}": ${detail}`);
    if (failed.status === "completed") await finalizeSerialQueue(failed);
    else await pumpClaimQueue();
    return failed;
  }

  if (tab && !task) {
    const restored = {
      ...createClaimTask({ gameId: current.id, tabId: current.tabId, now: Date.now(), title: current.title, catalogEligible: true }),
      platform: current.platform,
      origin: "queue-recovery"
    };
    await saveActiveTask(restored);
    await chrome.tabs.reload(current.tabId).catch(() => {});
    await addLog(`Recovered claim observer for "${current.title}" after a worker restart.`);
    return queue;
  }

  const detail = "Claim tab was no longer available during queue recovery.";
  const failed = finishCurrentClaim(queue, { tabId: current.tabId, status: "failed", detail, now: Date.now() });
  await removeActiveTask(current.tabId);
  await recordClaimStatus(current.platform || "epic", current.id, "failed", detail);
  await saveClaimQueue(failed);
  await addLog(`Recovered stale claim for "${current.title}": ${detail}`);
  if (failed.status === "completed") await finalizeSerialQueue(failed);
  else await pumpClaimQueue();
  return failed;
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
  const previous = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY] || emptyCatalog();

  if (force) {
    await addLog("Force-refreshing catalog from Epic Games Store...");
  }

  // A successful refresh stays valid until the next promotion boundary (a game
  // expiring or the next one starting), capped so a missed boundary self-heals.
  const country = settings.country || "VN";
  const validUntil = Date.parse(previous.validUntil || "");
  if (!force && !previous.errors?.epic && previous.refreshedAt && previous.country === country
      && Number.isFinite(validUntil) && Date.now() < validUntil) {
    return previous;
  }

  const [epicResult] = await Promise.allSettled([fetchEpicGames(country)]);

  const refreshedAt = epicResult.status === "fulfilled" ? new Date().toISOString() : previous.refreshedAt || null;
  const epicGames = epicResult.status === "fulfilled" ? epicResult.value.games : previous.epic || [];
  const nextBoundary = epicResult.status === "fulfilled" ? epicResult.value.nextBoundary : null;
  const catalog = {
    epic: epicGames,
    refreshedAt,
    country,
    validUntil: epicResult.status === "fulfilled"
      ? new Date(Math.min(Date.now() + CATALOG_MAX_AGE_MS, nextBoundary || Infinity)).toISOString()
      : null,
    nextBoundary: nextBoundary ? new Date(nextBoundary).toISOString() : null,
    lastAttemptAt: new Date().toISOString(),
    errors: {
      ...(epicResult.status === "rejected" ? { epic: readableError(epicResult.reason) } : {})
    }
  };
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  if (epicResult.status === "fulfilled") {
    const previousIds = (previous.epic || []).map((game) => game.id).sort().join(",");
    const nextIds = catalog.epic.map((game) => game.id).sort().join(",");
    if (force || previousIds !== nextIds) {
      await addLog(`Catalog updated: ${catalog.epic.length} free game(s) available for region ${country}.`);
    }
    scheduleNextDropAlarm(nextBoundary);
  } else {
    await addLog(`Catalog update failed: ${readableError(epicResult.reason)}`);
  }
  return catalog;
}

function scheduleNextDropAlarm(boundary) {
  if (!Number.isFinite(boundary)) return;
  // Epic's catalog can lag the promotion start by a minute or two.
  chrome.alarms.create(NEXT_DROP_ALARM, { when: Math.max(Date.now() + 60_000, boundary + 3 * 60_000) });
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

  let nextBoundary = null;
  for (const offer of elements) {
    for (const promotion of promotionWindows(offer)) {
      for (const edge of [Date.parse(promotion.startDate), Date.parse(promotion.endDate)]) {
        if (Number.isFinite(edge) && edge > now && (nextBoundary === null || edge < nextBoundary)) nextBoundary = edge;
      }
    }
  }

  const games = elements
    .filter((offer) => isEpicFreeNow(offer, now))
    .map((offer) => {
      const url = resolveEpicStoreUrl(offer);
      return {
        id: `epic-${offer.id}`,
        platform: "epic",
        offerId: offer.id,
        namespace: offer.namespace || null,
        title: offer.title,
        image: pickEpicImage(offer.keyImages),
        url,
        expiresAt: currentEpicPromotion(offer, now)?.endDate || null,
        originalPrice: offer.price?.totalPrice?.originalPrice || 0
      };
    });
  return { games, nextBoundary };
}

function promotionWindows(offer) {
  const promotions = offer.promotions || {};
  return [...(promotions.promotionalOffers || []), ...(promotions.upcomingPromotionalOffers || [])]
    .flatMap((group) => group?.promotionalOffers || []);
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

async function getScheduleState() {
  const stored = await chrome.storage.local.get(SCHEDULE_STATE_KEY).catch(() => ({}));
  return stored[SCHEDULE_STATE_KEY] || {};
}

async function saveScheduleState(next) {
  const state = { ...(await getScheduleState()), ...next };
  await chrome.storage.local.set({ [SCHEDULE_STATE_KEY]: state }).catch(() => {});
  return state;
}

// Scheduled scans run hourly, at each promotion boundary and on startup. There
// is no once-per-day gate: a scan with nothing new to claim is cheap and quiet.
function runScheduledCheck(reason = "periodic") {
  if (scheduledCheckPromise) return scheduledCheckPromise;
  scheduledCheckPromise = runScheduledCheckOnce(reason).finally(() => { scheduledCheckPromise = null; });
  return scheduledCheckPromise;
}

async function runScheduledCheckOnce(reason) {
  const settings = await getSettings();
  const verbose = reason !== "periodic";
  if (!settings.runOnStartup) {
    if (verbose) await addLog("Scheduled check skipped: Scheduled checks are disabled.");
    return;
  }
  if (!settings.autoClaim) {
    if (verbose) await addLog("Scheduled check skipped: Auto-claim switch is disabled.");
    return;
  }

  const authCheck = await checkEpicLoginStatus({ force: true });
  if (!authCheck.isLoggedIn && authCheck.remembered) {
    await addLog("Scheduled check: Epic session expired but the account is remembered; claims will reselect it on Epic's sign-in page.");
  } else if (!authCheck.isLoggedIn) {
    // Right after browser startup the cookie store and network are often not
    // ready yet, so a logged-out answer is retried instead of trusted.
    const schedule = await getScheduleState();
    const retries = schedule.startupRetries || 0;
    if (reason !== "periodic" && retries < STARTUP_RETRY_LIMIT) {
      await saveScheduleState({ startupRetries: retries + 1, pendingCheck: true });
      chrome.alarms.create(STARTUP_RETRY_ALARM, { delayInMinutes: 1 });
      if (retries === 0) await addLog(`Scheduled check deferred: Epic login not confirmed yet (${authCheck.status}). Retrying in 1 minute.`);
    } else {
      await saveScheduleState({ pendingCheck: true });
      if (verbose) await addLog("Scheduled check skipped: Account not logged in. It will run once Epic reports a login.");
    }
    return;
  }

  await saveScheduleState({ startupRetries: 0, pendingCheck: false, lastCheckAt: new Date().toISOString(), lastCheckReason: reason });
  try {
    const summary = await runClaimBatch({ force: reason === "new-drop", automatic: true, quiet: reason === "periodic" });
    await updateSettingsInternal({ lastDailyRun: localDayKey() });
    return summary;
  } catch (error) {
    await saveScheduleState({ pendingCheck: true });
    chrome.alarms.create(STARTUP_RETRY_ALARM, { delayInMinutes: 5 });
    await addLog(`Scheduled check failed and will retry in 5 minutes: ${readableError(error)}`);
  }
}

async function runClaimNow() {
  const authCheck = await checkEpicLoginStatus({ force: true });
  if (authCheck.status === "logged_out" && !authCheck.remembered) {
    await addLog("Manual Start failed: User not logged in to Epic Games Store.");
    throw new Error("Please log in to Epic Games Store on your browser first.");
  }
  await addLog("Manual Start initiated by user.");
  return runClaimBatch({ force: true });
}

function runClaimBatch(options) {
  return withQueueLock(() => runClaimBatchLocked(options));
}

async function runClaimBatchLocked({ force = false, automatic = false, quiet = false }) {
  const existingQueue = await getClaimQueue();
  if (existingQueue?.status === "running") {
    const message = existingQueue.current
      ? `A serial claim is already running for "${existingQueue.current.title}".`
      : "A serial claim queue is already running.";
    await addLog(message);
    await pumpClaimQueue();
    return { total: existingQueue.pending.length + (existingQueue.current ? 1 : 0), queued: existingQueue.pending.length, skipped: 0, failed: 0, message };
  }
  const activeTasks = await getActiveTasks();
  if (activeTasks.length > 0) {
    const message = "A claim task is already active.";
    await addLog(message);
    return { total: activeTasks.length, queued: 0, skipped: 0, failed: 0, message };
  }
  const catalog = await refreshCatalog({ force });
  if (catalog.errors?.epic) throw new Error(`Catalog refresh failed: ${catalog.errors.epic}`);
  const games = [...catalog.epic];
  // Skip games the account already owns without opening a tab for them.
  await syncEpicLibrary({ force, quiet: true }).catch(() => null);
  const claimed = await getEpicClaimedGames();
  const completedIds = new Set(claimed.filter(isClaimCompleted).map((game) => game.id));
  const unclaimed = games.filter((game) => !completedIds.has(game.id));
  // Unattended scans back off from a game that just failed instead of
  // reopening it every hour; Manual Start always retries.
  const records = new Map(claimed.map((game) => [game.id, game]));
  const candidates = automatic
    ? unclaimed.filter((game) => {
      const record = records.get(game.id);
      if (!record || !["failed", "needs_attention"].includes(record.status)) return true;
      return Date.now() - (Date.parse(record.claimedAt || "") || 0) >= AUTO_RETRY_COOLDOWN_MS;
    })
    : unclaimed;

  if (candidates.length === 0) {
    const message = games.length === 0
      ? "No free games available right now."
      : unclaimed.length === 0
        ? "All current free games are already claimed."
        : `${unclaimed.length} unclaimed game(s) failed recently; automatic retry is paused for up to 3 hours. Use Manual Start to retry now.`;
    if (!quiet) await addLog(message);
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
  const task = createClaimTask({
    gameId: game.id,
    tabId: tab.id,
    now: Date.now(),
    title: game.title,
    url: game.url,
    catalogEligible: true
  });
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
  await chrome.storage.local.set({ [CLAIMED_KEY]: claimed.slice(0, CLAIMED_LIMIT) });

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
  const settings = await getSettings();
  if (!settings.notifyOnClaim) return;
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

function fetchNotificationImageDataUrl(imageUrl) {
  return fetchImageDataUrl(imageUrl, NOTIFICATION_COVER_TIMEOUT_MS);
}

async function fetchImageDataUrl(imageUrl, timeoutMs) {
  const url = new URL(imageUrl);
  if (url.protocol === "data:" || url.protocol === "blob:") return url.toString();
  if (url.protocol !== "https:") throw new Error("Game cover must use HTTPS.");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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

async function fetchOrderHistoryPage(pageToken = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(orderHistoryUrl(pageToken), {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) throw new Error(`Epic order history requires login (HTTP ${response.status}).`);
    if (!response.ok) throw new Error(`Epic order history returned HTTP ${response.status}.`);
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      // Epic answers a signed-out request with its HTML login page.
      throw new Error("Epic order history did not return JSON (signed out or blocked).");
    }
    return parseOrderHistory(payload);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Epic order history timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Newest orders come first, so the first page is enough to confirm a claim
// that just happened.
async function isOwnedOnAccount(task) {
  try {
    const { items } = await fetchOrderHistoryPage();
    const owned = findOwnedItem({ id: task.gameId, title: task.title, offerId: task.offerId }, items);
    if (owned) await addLog(`Epic order history shows "${safeLogDetail(task.title || task.gameId, 100)}" is owned.`);
    return Boolean(owned);
  } catch (error) {
    await addUniqueClaimLog(`ownership-check:${task.gameId}:${readableError(error)}`, `Could not verify ownership of "${safeLogDetail(task.title || task.gameId, 100)}" via Epic order history: ${readableError(error)}`);
    return false;
  }
}

async function getLibraryState() {
  const stored = await chrome.storage.local.get(LIBRARY_KEY).catch(() => ({}));
  return stored[LIBRARY_KEY] || { syncedAt: null, itemCount: 0, error: null };
}

function syncEpicLibrary(options = {}) {
  if (librarySyncPromise) return librarySyncPromise;
  librarySyncPromise = syncEpicLibraryOnce(options).finally(() => { librarySyncPromise = null; });
  return librarySyncPromise;
}

// Import the account's order history so "claimed" reflects the Epic account,
// not just what this browser profile happened to observe.
async function syncEpicLibraryOnce({ force = false, quiet = false } = {}) {
  const previous = await getLibraryState();
  const syncedAt = Date.parse(previous.syncedAt || "");
  if (!force && !previous.error && Number.isFinite(syncedAt) && Date.now() - syncedAt < LIBRARY_SYNC_TTL_MS) return previous;

  const items = [];
  try {
    let token = "";
    for (let page = 0; page < LIBRARY_MAX_PAGES; page += 1) {
      const result = await fetchOrderHistoryPage(token);
      items.push(...result.items);
      if (!result.nextPageToken || result.nextPageToken === token) break;
      token = result.nextPageToken;
    }
  } catch (error) {
    const state = { ...previous, error: readableError(error), lastAttemptAt: new Date().toISOString() };
    await chrome.storage.local.set({ [LIBRARY_KEY]: state });
    if (!quiet || previous.error !== state.error) await addLog(`Epic library sync failed: ${state.error}`);
    return state;
  }

  const catalog = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY] || emptyCatalog();
  const merged = mergeOwnedIntoClaimed(await getEpicClaimedGames(), catalog.epic || [], items);
  await chrome.storage.local.set({ [CLAIMED_KEY]: merged.claimedGames.slice(0, CLAIMED_LIMIT) });
  const state = { syncedAt: new Date().toISOString(), itemCount: items.length, error: null };
  await chrome.storage.local.set({ [LIBRARY_KEY]: state });
  if (!quiet || merged.added || merged.updated || previous.error) {
    await addLog(`Epic library synced: ${items.length} owned item(s) on the account, ${merged.added} imported, ${merged.updated} marked owned.`);
  }
  if (merged.added) void resolveLibraryThumbnails().catch(() => {});
  return state;
}

function resolveLibraryThumbnails() {
  if (thumbnailPromise) return thumbnailPromise;
  thumbnailPromise = resolveLibraryThumbnailsOnce().finally(() => { thumbnailPromise = null; });
  return thumbnailPromise;
}

// Each cover is looked up and downloaded once, as a ~2 KB data URL kept under
// its own storage key; the library then renders without touching the network.
// A game with no cover is stamped and retried only after 30 days.
async function resolveLibraryThumbnailsOnce() {
  const now = Date.now();
  const thumbs = (await chrome.storage.local.get(THUMBS_KEY).catch(() => ({})))[THUMBS_KEY] || {};
  const pending = (await getEpicClaimedGames()).filter((game) => isClaimCompleted(game) && !thumbs[game.id]
    && (game.image || now - (Date.parse(game.imageCheckedAt || "") || 0) >= THUMBNAIL_RETRY_MS));
  if (!pending.length) return { found: 0, checked: 0 };

  const recordUpdates = new Map();
  const thumbUpdates = new Map();
  const flush = async () => {
    if (!recordUpdates.size && !thumbUpdates.size) return;
    const records = new Map(recordUpdates);
    const images = Object.fromEntries(thumbUpdates);
    recordUpdates.clear();
    thumbUpdates.clear();
    // Re-read both keys so writes made meanwhile are not overwritten.
    const stored = await chrome.storage.local.get(THUMBS_KEY).catch(() => ({}));
    const claimed = (await getEpicClaimedGames()).map((game) => records.has(game.id) ? { ...game, ...records.get(game.id) } : game);
    await chrome.storage.local.set({ [CLAIMED_KEY]: claimed, [THUMBS_KEY]: { ...(stored[THUMBS_KEY] || {}), ...images } });
  };

  let found = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const game = pending[cursor++];
      const checkedAt = new Date().toISOString();
      const image = game.image || await fetchStoreContentThumbnail(game.title).catch(() => null);
      const dataUrl = image ? await fetchThumbnailDataUrl(image).catch(() => null) : null;
      if (dataUrl) {
        found += 1;
        thumbUpdates.set(game.id, dataUrl);
      }
      recordUpdates.set(game.id, image && !game.image
        ? { image, imageSource: "store-content", imageCheckedAt: checkedAt }
        : { imageCheckedAt: checkedAt });
      if (recordUpdates.size >= 20) await flush();
    }
  };
  await Promise.all(Array.from({ length: THUMBNAIL_CONCURRENCY }, worker));
  await flush();
  await addLog(`Library covers: saved ${found} of ${pending.length} missing cover(s).`);
  return { found, checked: pending.length };
}

async function fetchThumbnailDataUrl(imageUrl) {
  const dataUrl = await fetchImageDataUrl(thumbnailUrl(imageUrl), 8000);
  // Skip CDNs that ignored the resize request; the popup can still load the URL lazily.
  return dataUrl.length <= THUMBNAIL_MAX_BYTES * 4 / 3 + 64 ? dataUrl : null;
}

async function fetchStoreContentThumbnail(title) {
  for (const slug of thumbnailSlugCandidates(title)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(STORE_CONTENT_URL + encodeURIComponent(slug), { credentials: "omit", signal: controller.signal });
      if (!response.ok) continue;
      const image = extractStoreContentImage(await response.json().catch(() => null), title);
      if (image) return image;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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
