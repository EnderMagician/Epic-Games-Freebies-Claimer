const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bgScriptPath = path.join(__dirname, '../scripts/background.js');
const bgScriptCode = fs.readFileSync(bgScriptPath, 'utf8');

function createSampleOffer({ id, title, slug, discountPrice = 0, originalPrice = 2999, active = true }) {
  const now = Date.now();
  return {
    id,
    title,
    productSlug: slug,
    keyImages: [{ type: 'OfferImageWide', url: `https://cdn1.epicgames.com/${slug}/wide.jpg` }],
    price: {
      totalPrice: {
        discountPrice,
        originalPrice
      }
    },
    promotions: active ? {
      promotionalOffers: [{
        promotionalOffers: [{
          startDate: new Date(now - 3600_000).toISOString(),
          endDate: new Date(now + 3600_000 * 24).toISOString()
        }]
      }]
    } : null
  };
}

function createExtensionEnvironment(options = {}) {
  const {
    initialStorage = {},
    customFetch,
    cookies = [
      { name: 'EPIC_BEARER_TOKEN', value: 'fake-token', domain: '.epicgames.com', path: '/' },
      { name: 'EPIC_SSO', value: 'fake-sso', domain: '.epicgames.com', path: '/' }
    ]
  } = options;

  const storageLocalStore = {
    settings: {
      autoClaim: true,
      country: 'VN',
      runOnStartup: true,
      notifyOnClaim: true,
      initiated: true
    },
    claimedGames: [],
    sessionLogs: [],
    catalog: { epic: [], refreshedAt: null, errors: {} },
    ...initialStorage
  };

  const storageSessionStore = {};
  let nextTabId = 100;
  const tabs = new Map();
  const activeWindows = new Map();
  activeWindows.set(1, { id: 1, focused: true });

  const tabListeners = {
    onCreated: [],
    onRemoved: [],
    onActivated: []
  };

  const alarms = new Map();
  const alarmListeners = [];

  const cookiesList = [...cookies];
  const cookieListeners = [];

  const notifications = new Map();
  const messageListeners = [];
  const installedListeners = [];
  const startupListeners = [];

  const mockChrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ...storageLocalStore };
          if (typeof keys === 'string') return { [keys]: storageLocalStore[keys] };
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) if (k in storageLocalStore) res[k] = storageLocalStore[k];
            return res;
          }
          const res = {};
          for (const [k, def] of Object.entries(keys)) {
            res[k] = k in storageLocalStore ? storageLocalStore[k] : def;
          }
          return res;
        },
        set: async (items) => {
          Object.assign(storageLocalStore, items);
        }
      },
      session: {
        get: async (keys) => {
          if (!keys) return { ...storageSessionStore };
          if (typeof keys === 'string') return { [keys]: storageSessionStore[keys] };
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) if (k in storageSessionStore) res[k] = storageSessionStore[k];
            return res;
          }
          return { ...storageSessionStore };
        },
        set: async (items) => {
          Object.assign(storageSessionStore, items);
        }
      }
    },
    tabs: {
      onCreated: { addListener: (fn) => tabListeners.onCreated.push(fn) },
      onRemoved: { addListener: (fn) => tabListeners.onRemoved.push(fn) },
      onActivated: { addListener: (fn) => tabListeners.onActivated.push(fn) },
      create: async ({ url, active, openerTabId }) => {
        const id = ++nextTabId;
        const tab = { id, url: url || 'about:blank', active: Boolean(active), openerTabId, windowId: 1 };
        tabs.set(id, tab);
        for (const fn of tabListeners.onCreated) {
          await fn(tab);
        }
        return tab;
      },
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
        return { ...tab };
      },
      update: async (tabId, props) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
        Object.assign(tab, props);
        return { ...tab };
      },
      remove: async (tabId) => {
        const tab = tabs.get(tabId);
        if (tab) {
          tabs.delete(tabId);
          for (const fn of tabListeners.onRemoved) {
            await fn(tabId);
          }
        }
      },
      query: async () => {
        return Array.from(tabs.values()).filter((t) => t.active);
      },
      reload: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
      }
    },
    windows: {
      update: async (windowId, props) => {
        const w = activeWindows.get(windowId) || { id: windowId };
        Object.assign(w, props);
        activeWindows.set(windowId, w);
        return w;
      }
    },
    alarms: {
      create: (name, info) => alarms.set(name, info),
      clear: (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) }
    },
    cookies: {
      getAll: async () => [...cookiesList],
      remove: async ({ name }) => {
        const idx = cookiesList.findIndex((c) => c.name === name);
        if (idx >= 0) cookiesList.splice(idx, 1);
      },
      onChanged: { addListener: (fn) => cookieListeners.push(fn) }
    },
    notifications: {
      create: async (id, options) => {
        notifications.set(id, options);
        return id;
      }
    },
    runtime: {
      onInstalled: { addListener: (fn) => installedListeners.push(fn) },
      onStartup: { addListener: (fn) => startupListeners.push(fn) },
      onMessage: { addListener: (fn) => messageListeners.push(fn) }
    }
  };

  const defaultFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('freeGamesPromotions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            Catalog: {
              searchStore: {
                elements: [
                  createSampleOffer({ id: 'promo-1', title: 'Game Alpha', slug: 'game-alpha' }),
                  createSampleOffer({ id: 'promo-2', title: 'Game Beta', slug: 'game-beta' })
                ]
              }
            }
          }
        })
      };
    }
    if (urlStr.includes('graphql') || urlStr.includes('account/api')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            Account: {
              account: {
                displayName: 'GamerOne',
                email: 'gamer@example.com'
              }
            }
          }
        })
      };
    }
    if (urlStr.startsWith('https://cdn1.epicgames.com/')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null)
        },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({})
    };
  };

  const activeFetch = customFetch || defaultFetch;

  const sandbox = {
    chrome: mockChrome,
    fetch: activeFetch,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Set,
    Map,
    Date,
    Promise,
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    Uint8Array,
    AbortController,
    importScripts: (...files) => {
      for (const f of files) {
        const full = path.join(__dirname, '../scripts', f);
        const code = fs.readFileSync(full, 'utf8');
        vm.runInContext(code, context);
      }
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(bgScriptCode, context);

  async function sendMessage(message, sender = {}) {
    for (const listener of messageListeners) {
      let resolved = false;
      const res = await new Promise((resolve) => {
        const returned = listener(message, sender, (response) => {
          resolved = true;
          resolve(response);
        });
        if (returned !== true && !resolved) {
          resolve(undefined);
        }
      });
      if (res !== undefined) return res;
    }
    return { ok: false, error: 'Unhandled message' };
  }

  async function triggerAlarm(name) {
    for (const fn of alarmListeners) {
      await fn({ name });
    }
  }

  async function triggerInstalled() {
    for (const fn of installedListeners) {
      await fn();
    }
  }

  async function triggerStartup() {
    for (const fn of startupListeners) {
      await fn();
    }
  }

  async function closeTab(tabId) {
    await mockChrome.tabs.remove(tabId);
  }

  return {
    chrome: mockChrome,
    context,
    storageLocalStore,
    storageSessionStore,
    tabs,
    alarms,
    notifications,
    sendMessage,
    triggerAlarm,
    triggerInstalled,
    triggerStartup,
    closeTab
  };
}

test('Pipeline Simulation: Catalog fetch parses free offers and records catalog snapshot', async () => {
  const env = createExtensionEnvironment();
  const res = await env.sendMessage({ type: 'refresh-catalog', force: true });
  assert.equal(res.ok, true);
  assert.equal(res.catalog.epic.length, 2);
  assert.equal(res.catalog.epic[0].title, 'Game Alpha');
  assert.equal(res.catalog.epic[1].title, 'Game Beta');
  assert.equal(res.catalog.errors.epic, undefined);

  const state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.catalog.epic.length, 2);
  assert.equal(state.isClaimRunning, false);
});

test('Pipeline Simulation: Catalog network failure is reported in errors and does not crash or stick', async () => {
  const env = createExtensionEnvironment({
    customFetch: async (url) => {
      if (String(url).includes('freeGamesPromotions')) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable'
        };
      }
      return { ok: true, json: async () => ({}) };
    }
  });

  const res = await env.sendMessage({ type: 'refresh-catalog', force: true });
  assert.equal(res.ok, true);
  assert.match(res.catalog.errors.epic, /HTTP 503/i);

  const state = await env.sendMessage({ type: 'get-state' });
  assert.match(state.catalog.errors.epic, /HTTP 503/i);
  assert.equal(state.isClaimRunning, false);
  assert.ok(state.sessionLogs.some((log) => log.includes('Catalog update failed')));
});

test('Pipeline Simulation: Full Happy Path serial claim processes all games, sends notifications, and completes cleanly', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });

  const runRes = await env.sendMessage({ type: 'run-claim-now' });
  assert.equal(runRes.ok, true);
  assert.equal(runRes.summary.queued, 2);

  let state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, true);
  assert.equal(state.claimQueue.pending.length, 1);
  assert.equal(state.claimQueue.current.title, 'Game Alpha');
  const firstTabId = state.claimQueue.current.tabId;
  assert.ok(env.tabs.has(firstTabId));

  const readyRes1 = await env.sendMessage(
    { type: 'claim-ready', url: env.tabs.get(firstTabId).url, allowAdoption: true },
    { tab: { id: firstTabId }, frameId: 0 }
  );
  assert.equal(readyRes1.ok, true);
  assert.ok(readyRes1.task);

  const obsRes1 = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: false,
        visibleActions: ['get'],
        freeEvidence: 'confirmed',
        blockers: []
      }
    },
    { tab: { id: firstTabId }, frameId: 0 }
  );
  assert.equal(obsRes1.ok, true);
  assert.equal(obsRes1.decision.action, 'click_get');

  const ownedRes1 = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: true,
        visibleActions: [],
        freeEvidence: 'unknown',
        blockers: []
      }
    },
    { tab: { id: firstTabId }, frameId: 0 }
  );
  assert.equal(ownedRes1.ok, true);
  assert.equal(ownedRes1.decision.action, 'complete_owned');

  assert.equal(env.tabs.has(firstTabId), false);

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, true);
  assert.equal(state.claimQueue.results.length, 1);
  assert.equal(state.claimQueue.results[0].title, 'Game Alpha');
  assert.equal(state.claimQueue.current.title, 'Game Beta');
  const secondTabId = state.claimQueue.current.tabId;
  assert.ok(env.tabs.has(secondTabId));

  await env.sendMessage(
    { type: 'claim-ready', url: env.tabs.get(secondTabId).url, allowAdoption: true },
    { tab: { id: secondTabId }, frameId: 0 }
  );
  await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: false,
        visibleActions: ['get'],
        freeEvidence: 'confirmed',
        blockers: []
      }
    },
    { tab: { id: secondTabId }, frameId: 0 }
  );
  await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: true,
        visibleActions: [],
        freeEvidence: 'unknown',
        blockers: []
      }
    },
    { tab: { id: secondTabId }, frameId: 0 }
  );

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, false);
  assert.equal(state.claimQueue.status, 'completed');
  assert.equal(state.claimQueue.results.length, 2);
  assert.equal(state.claimedGames.length, 2);
  assert.ok(env.notifications.size >= 2);
});

test('Pipeline Simulation: Abrupt tab closure does NOT hang the queue; advances to next game with error reported', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const firstTabId = state.claimQueue.current.tabId;
  assert.equal(state.claimQueue.current.title, 'Game Alpha');

  await env.closeTab(firstTabId);

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, true);
  assert.equal(state.claimQueue.results.length, 1);
  assert.equal(state.claimQueue.results[0].status, 'failed');
  assert.match(state.claimQueue.results[0].detail, /Claim tab was closed/i);

  assert.equal(state.claimQueue.current.title, 'Game Beta');
  const secondTabId = state.claimQueue.current.tabId;

  await env.sendMessage(
    { type: 'claim-ready', url: env.tabs.get(secondTabId).url, allowAdoption: true },
    { tab: { id: secondTabId }, frameId: 0 }
  );
  await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: true, visibleActions: [], freeEvidence: 'unknown', blockers: [] }
    },
    { tab: { id: secondTabId }, frameId: 0 }
  );

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, false);
  assert.equal(state.claimQueue.status, 'completed');
  assert.equal(state.settings.lastRunErrors.length, 1);
  assert.match(state.settings.lastRunErrors[0], /Claim tab was closed/i);
});

test('Pipeline Simulation: Watchdog recovers stuck tab after CLAIM_TIMEOUT_MS and advances queue', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const firstTabId = state.claimQueue.current.tabId;
  assert.equal(state.claimQueue.current.title, 'Game Alpha');

  const task = env.storageSessionStore.activeClaimTasks[String(firstTabId)];
  task.lastProgressAt = Date.now() - (6 * 60 * 1000);
  env.storageSessionStore.activeClaimTasks[String(firstTabId)] = task;

  await env.triggerAlarm('freebies-claim-watchdog');

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(env.tabs.has(firstTabId), false);
  assert.equal(state.claimQueue.results.length, 1);
  assert.equal(state.claimQueue.results[0].status, 'failed');
  assert.match(state.claimQueue.results[0].detail, /timed out/i);
  assert.equal(state.claimQueue.current.title, 'Game Beta');
});

test('Pipeline Simulation: Checkout child tab binds, clicks Get, confirms the library action, and finishes', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const parentTabId = state.claimQueue.current.tabId;

  const childTab = await env.chrome.tabs.create({
    url: 'https://store.epicgames.com/en-US/purchase',
    openerTabId: parentTabId,
    active: true
  });

  const readyChild = await env.sendMessage(
    { type: 'claim-ready', url: childTab.url, allowAdoption: true },
    { tab: { id: childTab.id }, frameId: 0 }
  );
  assert.equal(readyChild.ok, true);
  assert.equal(readyChild.task.tabId, childTab.id);
  assert.equal(readyChild.task.phase, 'waiting_for_get');

  const getRes = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: false,
        visibleActions: ['get'],
        freeEvidence: 'confirmed',
        blockers: []
      }
    },
    { tab: { id: childTab.id }, frameId: 0 }
  );
  assert.equal(getRes.ok, true);
  assert.equal(getRes.decision.action, 'click_get');

  const confirmRes = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: false,
        visibleActions: ['add_to_library'],
        freeEvidence: 'confirmed',
        blockers: []
      }
    },
    { tab: { id: childTab.id }, frameId: 0 }
  );
  assert.equal(confirmRes.ok, true);
  assert.equal(confirmRes.decision.action, 'click_confirm');

  const ownedRes = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: true, visibleActions: [], freeEvidence: 'unknown', blockers: [] }
    },
    { tab: { id: childTab.id }, frameId: 0 }
  );
  assert.equal(ownedRes.decision.action, 'complete_owned');

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.claimQueue.results[0].title, 'Game Alpha');
  assert.equal(state.claimQueue.results[0].status, 'owned');
});

test('Pipeline Simulation: only a trusted checkout frame can route claim observations', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });
  const state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;

  const unrelated = await env.sendMessage(
    { type: 'claim-ready', url: 'https://store.epicgames.com/en-US/p/other', frameContext: 'product' },
    { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/p/other' }
  );
  assert.equal(unrelated.task, null);

  const checkout = await env.sendMessage(
    { type: 'claim-ready', url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y', frameContext: 'checkout' },
    { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y' }
  );
  assert.equal(checkout.task.gameId, state.claimQueue.current.id);

  const paid = await env.sendMessage(
    {
      type: 'claim-observation',
      url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y',
      frameContext: 'checkout',
      observation: {
        context: 'checkout',
        visibleActions: ['place_order'],
        checkoutTotalEvidence: 'nonzero',
        offerEvidence: 'confirmed',
        blockers: []
      }
    },
    { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y' }
  );
  assert.equal(paid.decision.action, 'wait');
  assert.match(paid.decision.reason, /nonzero/i);
  assert.equal((await env.sendMessage({ type: 'get-state' })).claimQueue.current.tabId, tabId);
});

test('Pipeline Simulation: attachment and observation logs are bounded and deduplicated', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });
  const state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;
  const sender = { tab: { id: tabId }, frameId: 0 };
  const ready = { type: 'claim-ready', url: 'https://store.epicgames.com/en-US/p/game-alpha', frameContext: 'product', allowAdoption: true };

  await env.sendMessage(ready, sender);
  await env.sendMessage(ready, sender);
  const wait = { type: 'claim-observation', observation: { visibleActions: [], freeEvidence: 'unknown', blockers: [] } };
  await env.sendMessage(wait, sender);
  await env.sendMessage(wait, sender);

  const logs = (await env.sendMessage({ type: 'get-state' })).sessionLogs;
  assert.equal(logs.filter((entry) => entry.includes('Attached claim observer')).length, 1);
  assert.equal(logs.filter((entry) => entry.includes('actions=none')).length, 1);
  assert.ok(logs.some((entry) => entry.includes('Waiting for Epic page state to settle')));
});

test('Pipeline Simulation: child observer failures cannot terminate the parent task, but attached child results can', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });
  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;

  await env.sendMessage(
    { type: 'claim-observer-failed', frameContext: 'checkout', detail: 'child failed' },
    { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y' }
  );
  await env.sendMessage(
    {
      type: 'claim-observation',
      frameContext: 'product',
      observation: { context: 'product', ownershipVisible: true, visibleActions: [], blockers: [] }
    },
    { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/p/other' }
  );
  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.claimQueue.current.tabId, tabId);
  assert.ok(env.tabs.has(tabId));

  const result = await env.sendMessage(
    { type: 'claim-result', frameContext: 'checkout', platform: 'epic', id: state.claimQueue.current.id, status: 'owned', detail: 'Attached checkout completed.' },
    { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y' }
  );
  assert.equal(result.ok, true);
  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.claimQueue.results[0].status, 'owned');
});

test('Pipeline Simulation: failed clicks recover with bounded retries and preserve the progress clock', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });
  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;
  const sender = { tab: { id: tabId }, frameId: 0 };
  const observation = { type: 'claim-observation', observation: { visibleActions: ['get'], freeEvidence: 'confirmed', blockers: [] } };

  let beforeFailure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const decision = await env.sendMessage(observation, sender);
    assert.equal(decision.decision.action, 'click_get');
    state = await env.sendMessage({ type: 'get-state' });
    beforeFailure = state.activeTasks[0].lastProgressAt;
    await env.sendMessage({ type: 'claim-action-result', action: 'get', success: false, detail: 'Could not find visible get control.' }, sender);
    state = await env.sendMessage({ type: 'get-state' });
    assert.equal(state.activeTasks[0].lastProgressAt, beforeFailure);
  }
  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.activeTasks[0].phase, 'needs_attention');
  assert.equal(state.activeTasks[0].clickFailures, 3);
  assert.ok(state.sessionLogs.some((entry) => entry.includes('Could not find visible get control')));
});

test('Pipeline Simulation: a stale failure from another frame cannot roll back a newer action', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });
  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;
  const top = { tab: { id: tabId }, frameId: 0 };
  const checkout = { tab: { id: tabId }, frameId: 1, url: 'https://store.epicgames.com/en-US/purchase?offers=1-x-y' };

  await env.sendMessage({
    type: 'claim-observation',
    observation: { visibleActions: ['get'], freeEvidence: 'confirmed', blockers: [] }
  }, top);
  const newer = await env.sendMessage({
    type: 'claim-observation',
    frameContext: 'checkout',
    observation: { context: 'checkout', visibleActions: ['place_order'], checkoutTotalEvidence: 'confirmed', blockers: [] }
  }, checkout);
  assert.equal(newer.decision.action, 'click_confirm');

  await env.sendMessage({ type: 'claim-action-result', action: 'get', success: false, detail: 'stale top frame click' }, top);
  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.activeTasks[0].phase, 'confirmation_clicked');
  assert.equal(state.activeTasks[0].clickFailures || 0, 0);
});

test('Pipeline Simulation: A tracked tab whose observer cannot attach fails immediately and advances the queue', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const firstTabId = state.claimQueue.current.tabId;
  const result = await env.sendMessage(
    { type: 'claim-observer-failed', detail: 'Claim observer could not attach after 30 attempts.' },
    { tab: { id: firstTabId }, frameId: 0 }
  );
  assert.equal(result.ok, true);
  assert.equal(env.tabs.has(firstTabId), false);

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.claimQueue.results[0].status, 'failed');
  assert.match(state.claimQueue.results[0].detail, /could not attach/i);
  assert.equal(state.claimQueue.current.title, 'Game Beta');
});

test('Pipeline Simulation: Blocker/CAPTCHA pauses queue with needs_attention without getting stuck in loop', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;

  const obsRes = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: {
        ownershipVisible: false,
        visibleActions: ['place_order'],
        freeEvidence: 'unknown',
        blockers: ['captcha']
      }
    },
    { tab: { id: tabId }, frameId: 0 }
  );

  assert.equal(obsRes.ok, true);
  assert.equal(obsRes.decision.action, 'needs_attention');

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, true);
  const claimedRecord = state.claimedGames.find((g) => g.id === 'epic-promo-1');
  assert.ok(claimedRecord, 'Claimed record should exist');
  assert.equal(claimedRecord.status, 'needs_attention');
  assert.ok(state.sessionLogs.some((l) => l.includes('Serial queue paused')));
});

test('Pipeline Simulation: Kill Instance terminates active background tabs and cancels queue immediately', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;
  assert.ok(env.tabs.has(tabId));

  const killRes = await env.sendMessage({ type: 'kill-instance' });
  assert.equal(killRes.ok, true);
  assert.equal(killRes.isClaimRunning, false);

  assert.equal(env.tabs.has(tabId), false);

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, false);
  assert.equal(state.claimQueue.status, 'cancelled');
  assert.ok(state.sessionLogs.some((l) => l.includes('Kill Instance triggered by user')));
});

test('Pipeline Simulation: Concurrency protection blocks double-run and returns active message', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  const secondRun = await env.sendMessage({ type: 'run-claim-now' });
  assert.equal(secondRun.ok, true);
  assert.match(secondRun.summary.message, /already running/i);

  const claimItemRes = await env.sendMessage({ type: 'claim-item', platform: 'epic', id: 'epic-promo-2' });
  assert.equal(claimItemRes.ok, false);
  assert.match(claimItemRes.error, /already running/i);
});

test('Pipeline Simulation: Unlogged user trying manual claim reports login requirement gracefully', async () => {
  const env = createExtensionEnvironment({
    cookies: [],
    customFetch: async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('login/state')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ isLoggedIn: false })
        };
      }
      if (urlStr.includes('freeGamesPromotions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              Catalog: {
                searchStore: {
                  elements: [createSampleOffer({ id: 'promo-1', title: 'Game Alpha', slug: 'game-alpha' })]
                }
              }
            }
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    }
  });

  const runRes = await env.sendMessage({ type: 'run-claim-now' });
  assert.equal(runRes.ok, false);
  assert.match(runRes.error, /log in to Epic Games Store/i);

  const state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, false);
});

test('Pipeline Simulation: Auto-adoption skips already claimed games in library', async () => {
  const env = createExtensionEnvironment({
    initialStorage: {
      claimedGames: [{ id: 'epic-promo-1', platform: 'epic', status: 'owned', title: 'Game Alpha' }]
    }
  });
  await env.sendMessage({ type: 'refresh-catalog', force: true });

  const dummyTab = await env.chrome.tabs.create({ url: 'https://store.epicgames.com/en-US/p/game-alpha' });
  const adoptRes = await env.sendMessage(
    { type: 'claim-ready', url: dummyTab.url, allowAdoption: true },
    { tab: { id: dummyTab.id }, frameId: 0 }
  );

  assert.equal(adoptRes.ok, true);
  assert.equal(adoptRes.task, null);
});

test('Pipeline Simulation: Notification image timeout falls back gracefully to default icon without blocking', async () => {
  const env = createExtensionEnvironment({
    customFetch: async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('freeGamesPromotions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              Catalog: {
                searchStore: {
                  elements: [createSampleOffer({ id: 'img-hang', title: 'Slow Cover Game', slug: 'slow-cover' })]
                }
              }
            }
          })
        };
      }
      if (urlStr.startsWith('https://cdn1.epicgames.com/')) {
        // Fast error to trigger fallback immediately
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      return { ok: true, json: async () => ({}) };
    }
  });

  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  const state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;

  await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: true, visibleActions: [], freeEvidence: 'unknown', blockers: [] }
    },
    { tab: { id: tabId }, frameId: 0 }
  );

  const finalState = await env.sendMessage({ type: 'get-state' });
  assert.equal(finalState.claimQueue.status, 'completed');
  assert.equal(finalState.claimedGames[0].status, 'owned');

  // Wait briefly for fire-and-forget notification to complete
  for (let i = 0; i < 20 && env.notifications.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(env.notifications.size >= 1);
  const notif = Array.from(env.notifications.values())[0];
  assert.equal(notif.iconUrl, 'icons/icon128.png');
});

test('Pipeline Simulation: Storage migration migrates v0 state to v2 with backup', async () => {
  const legacyStorage = {
    storageSchemaVersion: 0,
    settings: { autoClaim: false, country: 'US' },
    claimedGames: [{ id: 'epic-legacy-game', title: 'Legacy Game', status: 'claimed' }],
    catalog: { epic: [] }
  };
  const env = createExtensionEnvironment({ initialStorage: legacyStorage });
  await env.triggerStartup();

  const state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.settings.autoClaim, false);
  assert.equal(state.settings.country, 'US');
  assert.equal(state.claimedGames[0].platform, 'epic');
  assert.ok(env.storageLocalStore.migrationBackupV2);
  assert.equal(env.storageLocalStore.storageSchemaVersion, 2);
});

test('Pipeline Simulation: Auth probe retains logged_in via cookie fallback during API timeout', async () => {
  const env = createExtensionEnvironment({
    cookies: [{ name: 'EPIC_BEARER_TOKEN', value: 'token123', domain: '.epicgames.com', path: '/' }],
    customFetch: async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('login/state')) {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 504 }), 5000));
      }
      return { ok: true, json: async () => ({}) };
    }
  });

  const authState = await env.sendMessage({ type: 'check-login-status', force: true });
  assert.equal(authState.ok, true);
  assert.equal(authState.status, 'logged_in');
  assert.equal(authState.source, 'cookie_fallback');
});

test('Pipeline Simulation: Daily check alarm skips claim batch if already run today', async () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  const today = new Date(now.getTime() - offset).toISOString().slice(0, 10);

  const env = createExtensionEnvironment({
    initialStorage: {
      settings: {
        autoClaim: true,
        runOnStartup: true,
        lastDailyRun: today
      }
    }
  });

  await env.triggerAlarm('freebies-daily-check');

  const state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.isClaimRunning, false);
  assert.ok(state.sessionLogs.some((l) => l.includes('Already executed once today')));
});

test('Pipeline Simulation: Slow tab loading with delayed DOM hydration handles multiple wait steps without miss timing', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;

  // 1. Tab loads slowly: Content script initial observation sees only skeleton/loading
  const slowStep1 = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: false, visibleActions: [], freeEvidence: 'unknown', blockers: [] }
    },
    { tab: { id: tabId }, frameId: 0 }
  );
  assert.equal(slowStep1.ok, true);
  assert.equal(slowStep1.decision.action, 'wait');
  assert.match(slowStep1.decision.reason, /Waiting for Epic page state to settle/i);

  // 2. Tab is still hydrating: Button appears but price API has not settled yet
  const slowStep2 = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: false, visibleActions: ['get'], freeEvidence: 'unknown', blockers: [] }
    },
    { tab: { id: tabId }, frameId: 0 }
  );
  assert.equal(slowStep2.ok, true);
  assert.equal(slowStep2.decision.action, 'wait');
  assert.match(slowStep2.decision.reason, /Waiting for Epic page state to settle/i);

  // 3. Page fully settles after delay: Verified free + Get button ready
  const slowStep3 = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: false, visibleActions: ['get'], freeEvidence: 'confirmed', blockers: [] }
    },
    { tab: { id: tabId }, frameId: 0 }
  );
  assert.equal(slowStep3.ok, true);
  assert.equal(slowStep3.decision.action, 'click_get');

  // 4. Epic confirms ownership
  const slowStep4 = await env.sendMessage(
    {
      type: 'claim-observation',
      observation: { ownershipVisible: true, visibleActions: [], freeEvidence: 'unknown', blockers: [] }
    },
    { tab: { id: tabId }, frameId: 0 }
  );
  assert.equal(slowStep4.ok, true);
  assert.equal(slowStep4.decision.action, 'complete_owned');

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(state.claimQueue.results[0].status, 'owned');
  assert.equal(state.claimQueue.current.title, 'Game Beta');
});

test('Pipeline Simulation: Extreme slow tab (miss timing > 15s where content script gives up) is caught by Watchdog without sticking', async () => {
  const env = createExtensionEnvironment();
  await env.sendMessage({ type: 'refresh-catalog', force: true });
  await env.sendMessage({ type: 'run-claim-now' });

  let state = await env.sendMessage({ type: 'get-state' });
  const tabId = state.claimQueue.current.tabId;

  // Content script attempted 30 retries (15s) and gave up; tab sent 0 observations
  // Tab sits idle in background. Now time advances past CLAIM_TIMEOUT_MS.
  const task = env.storageSessionStore.activeClaimTasks[String(tabId)];
  task.lastProgressAt = Date.now() - (6 * 60 * 1000); // 6 mins ago
  env.storageSessionStore.activeClaimTasks[String(tabId)] = task;

  await env.triggerAlarm('freebies-claim-watchdog');

  state = await env.sendMessage({ type: 'get-state' });
  assert.equal(env.tabs.has(tabId), false, 'Stuck tab should be closed');
  assert.equal(state.claimQueue.results[0].status, 'failed');
  assert.match(state.claimQueue.results[0].detail, /timed out/i);
  assert.equal(state.claimQueue.current.title, 'Game Beta');
  assert.equal(state.isClaimRunning, true);
});
