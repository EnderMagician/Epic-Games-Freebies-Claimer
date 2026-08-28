const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeClaimedGames,
  buildStateSnapshot,
  migrateStoredState
} = require('../scripts/core/state-model.js');
const { resolveAuthObservation, shouldLogAuthTransition } = require('../scripts/core/auth-model.js');
const { fetchLoginState } = require('../scripts/core/auth-client.js');
const { buildEpicObservation } = require('../scripts/core/epic-observation.js');
const { findClaimableGameForUrl } = require('../scripts/core/claim-routing.js');
let claimQueue = {};
try {
  claimQueue = require('../scripts/core/claim-queue.js');
} catch (error) {
  // The RED step intentionally runs before the queue module exists.
}
const {
  createClaimQueue,
  beginNextClaim,
  rebindCurrentClaim,
  finishCurrentClaim,
  skipNextClaim,
  cancelClaimQueue
} = claimQueue;
const {
  createClaimTask,
  reduceClaimTask
} = require('../scripts/core/claim-machine.js');

test('normalizes legacy claimed records without deleting them or mutating input', () => {
  const legacy = [
    { id: 'epic-legacy', title: 'Legacy Game', status: 'claimed' },
    { id: 'epic-owned', title: 'Owned Game', platform: 'epic', status: 'owned' }
  ];

  const normalized = normalizeClaimedGames(legacy);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].platform, 'epic');
  assert.equal(normalized[0].status, 'claimed');
  assert.deepEqual(legacy[0], { id: 'epic-legacy', title: 'Legacy Game', status: 'claimed' });
});

test('merges settings without resetting user values', () => {
  const settings = normalizeSettings({ autoClaim: false, country: 'US', lastRunAt: 'saved' });

  assert.equal(settings.autoClaim, false);
  assert.equal(settings.country, 'US');
  assert.equal(settings.lastRunAt, 'saved');
  assert.equal(settings.runOnStartup, DEFAULT_SETTINGS.runOnStartup);
});

test('migrates stored state with a recoverable backup', () => {
  const migrated = migrateStoredState({
    settings: { autoClaim: false },
    claimedGames: [{ id: 'epic-old', title: 'Old Game', status: 'claimed' }],
    catalog: { epic: [{ id: 'epic-old' }] }
  }, 0);

  assert.equal(migrated.version, 2);
  assert.equal(migrated.settings.autoClaim, false);
  assert.equal(migrated.claimedGames[0].platform, 'epic');
  assert.deepEqual(migrated.backup.claimedGames, [{ id: 'epic-old', title: 'Old Game', status: 'claimed' }]);
});

test('returns a partial snapshot instead of defaulting every slice', () => {
  const snapshot = buildStateSnapshot({
    settings: { autoClaim: false },
    catalog: { epic: [{ id: 'epic-1' }], refreshedAt: 'now', errors: {} },
    claimedGames: [{ id: 'epic-1', platform: 'epic', status: 'claimed' }],
    auth: { status: 'unknown', source: 'cached' },
    errors: { auth: 'timeout' }
  });

  assert.equal(snapshot.settings.autoClaim, false);
  assert.equal(snapshot.catalog.epic.length, 1);
  assert.equal(snapshot.claimedGames.length, 1);
  assert.equal(snapshot.errors.auth, 'timeout');
});

test('keeps a confirmed login during a transient auth failure', () => {
  const auth = resolveAuthObservation({
    api: { status: 'error', error: 'timeout' },
    hasAuthCookie: true,
    previous: { status: 'logged_in', source: 'api' }
  });

  assert.equal(auth.status, 'logged_in');
  assert.equal(auth.source, 'cookie_fallback');
});

test('does not convert an inconclusive auth probe into a logout', () => {
  const auth = resolveAuthObservation({
    api: { status: 'error', error: 'network' },
    hasAuthCookie: false,
    previous: { status: 'logged_in', source: 'api' }
  });

  assert.equal(auth.status, 'unknown');
});

test('does not log repeated identical auth observations', () => {
  assert.equal(shouldLogAuthTransition(
    { status: 'logged_in', accountLabel: 'Connected' },
    { status: 'logged_in', accountLabel: 'Connected' }
  ), false);
  assert.equal(shouldLogAuthTransition(
    { status: 'unknown' },
    { status: 'logged_in', accountLabel: 'Connected' }
  ), true);
});

test('bounds a login-state request that never resolves', async () => {
  const result = await fetchLoginState(() => new Promise(() => {}), 15);

  assert.equal(result.status, 'error');
  assert.match(result.error, /timed out/i);
});

test('completes when Get directly transitions to owned', () => {
  const task = createClaimTask({ gameId: 'epic-direct', tabId: 1 });
  const afterGet = reduceClaimTask(task, {
    ownershipVisible: false,
    visibleActions: ['get'],
    freeEvidence: 'confirmed',
    blockers: []
  }, 1);
  const completed = reduceClaimTask(afterGet.task, {
    ownershipVisible: true,
    visibleActions: [],
    freeEvidence: 'unknown',
    blockers: []
  }, 2);

  assert.equal(afterGet.decision.action, 'click_get');
  assert.equal(completed.decision.action, 'complete_owned');
  assert.equal(completed.task.phase, 'completed');
});

test('does not click Get until the page verifies a zero-cost offer', () => {
  const task = createClaimTask({ gameId: 'epic-safe-get', tabId: 4 });
  const result = reduceClaimTask(task, {
    ownershipVisible: false,
    visibleActions: ['get'],
    freeEvidence: 'unknown',
    blockers: []
  }, 5);

  assert.equal(result.decision.action, 'wait');
  assert.equal(result.task.phase, 'waiting_for_get');
});

test('records progress timestamps for recovery timeouts', () => {
  const task = createClaimTask({ gameId: 'epic-progress', tabId: 5, now: 10 });
  const result = reduceClaimTask(task, {
    ownershipVisible: false,
    visibleActions: ['get'],
    freeEvidence: 'confirmed',
    blockers: []
  }, 20);

  assert.equal(result.task.lastProgressAt, 20);
});

test('clicks only a verified-free confirmation action', () => {
  const task = { ...createClaimTask({ gameId: 'epic-confirm', tabId: 2 }), phase: 'awaiting_outcome' };
  const result = reduceClaimTask(task, {
    ownershipVisible: false,
    visibleActions: ['add_to_library'],
    freeEvidence: 'confirmed',
    blockers: []
  }, 3);

  assert.equal(result.decision.action, 'click_confirm');
  assert.equal(result.task.phase, 'confirmation_clicked');
});

test('pauses instead of clicking through a blocker or unknown price', () => {
  const task = { ...createClaimTask({ gameId: 'epic-blocked', tabId: 3 }), phase: 'awaiting_outcome' };
  const result = reduceClaimTask(task, {
    ownershipVisible: false,
    visibleActions: ['place_order'],
    freeEvidence: 'unknown',
    blockers: ['captcha']
  }, 4);

  assert.equal(result.decision.action, 'needs_attention');
  assert.equal(result.task.phase, 'needs_attention');
});

test('normalizes Epic labels, ownership, price, and blockers into one observation', () => {
  const observation = buildEpicObservation({
    bodyText: 'Your total $0.00 CAPTCHA required',
    buttons: [
      { label: 'Add to Library', visible: true, disabled: false },
      { label: 'Get', visible: false, disabled: false }
    ]
  });

  assert.equal(observation.freeEvidence, 'confirmed');
  assert.deepEqual(observation.visibleActions, ['add_to_library']);
  assert.deepEqual(observation.blockers, ['captcha']);
});

test('does not treat a generic Free label as checkout price evidence', () => {
  const observation = buildEpicObservation({
    bodyText: 'Free game Place Order',
    buttons: [{ label: 'Place Order', visible: true, disabled: false }]
  });

  assert.equal(observation.freeEvidence, 'unknown');
});

test('adopts a manually opened current freebie URL when it is not claimed', () => {
  const game = findClaimableGameForUrl('https://store.epicgames.com/en-US/p/otxo?source=manual', {
    epic: [{ id: 'epic-otxo', title: 'OTXO', url: 'https://store.epicgames.com/en-US/p/otxo' }]
  }, []);

  assert.equal(game.id, 'epic-otxo');
});

test('does not adopt a manually opened URL already in claim history', () => {
  const game = findClaimableGameForUrl('https://store.epicgames.com/en-US/p/otxo', {
    epic: [{ id: 'epic-otxo', title: 'OTXO', url: 'https://store.epicgames.com/en-US/p/otxo' }]
  }, [{ id: 'epic-otxo', status: 'claimed' }]);

  assert.equal(game, null);
});

test('serial queue permits only one active claim tab', () => {
  assert.equal(typeof createClaimQueue, 'function');
  const queue = createClaimQueue([
    { platform: 'epic', id: 'game-a', title: 'Game A' },
    { platform: 'epic', id: 'game-b', title: 'Game B' }
  ], 10);

  const first = beginNextClaim(queue, 101, 11);
  const blocked = beginNextClaim(first, 102, 12);

  assert.equal(blocked.current.id, 'game-a');
  assert.equal(blocked.current.tabId, 101);
  assert.deepEqual(blocked.pending.map((item) => item.id), ['game-b']);
});

test('terminal completion releases exactly the next queued game', () => {
  const queue = beginNextClaim(createClaimQueue([
    { platform: 'epic', id: 'game-a', title: 'Game A' },
    { platform: 'epic', id: 'game-b', title: 'Game B' }
  ], 20), 201, 21);

  const finished = finishCurrentClaim(queue, {
    tabId: 201,
    status: 'owned',
    detail: 'Added to library.',
    now: 22
  });
  const second = beginNextClaim(finished, 202, 23);

  assert.equal(second.current.id, 'game-b');
  assert.equal(second.current.tabId, 202);
  assert.equal(second.pending.length, 0);
  assert.deepEqual(second.results.map((item) => ({ id: item.id, status: item.status })), [
    { id: 'game-a', status: 'owned' }
  ]);
});

test('an unrelated tab event cannot advance the serial queue', () => {
  const queue = beginNextClaim(createClaimQueue([
    { platform: 'epic', id: 'game-a', title: 'Game A' },
    { platform: 'epic', id: 'game-b', title: 'Game B' }
  ], 30), 301, 31);

  const unchanged = finishCurrentClaim(queue, {
    tabId: 999,
    status: 'failed',
    detail: 'Unrelated tab closed.',
    now: 32
  });

  assert.deepEqual(unchanged, queue);
});

test('a child checkout tab inherits the current queue item', () => {
  const queue = beginNextClaim(createClaimQueue([
    { platform: 'epic', id: 'game-a', title: 'Game A' },
    { platform: 'epic', id: 'game-b', title: 'Game B' }
  ], 35), 351, 36);

  const rebound = rebindCurrentClaim(queue, 351, 352, 37);
  const finished = finishCurrentClaim(rebound, {
    tabId: 352,
    status: 'owned',
    detail: 'Checkout child completed.',
    now: 38
  });

  assert.equal(rebound.current.tabId, 352);
  assert.equal(finished.current, null);
  assert.deepEqual(finished.pending.map((item) => item.id), ['game-b']);
});

test('skipping and cancellation terminate pending work without opening tabs', () => {
  const queue = createClaimQueue([
    { platform: 'epic', id: 'game-a', title: 'Game A' },
    { platform: 'epic', id: 'game-b', title: 'Game B' }
  ], 40);
  const skipped = skipNextClaim(queue, { status: 'owned', detail: 'Already owned.', now: 41 });
  const cancelled = cancelClaimQueue(skipped, 42);

  assert.deepEqual(cancelled.results.map((item) => ({ id: item.id, status: item.status })), [
    { id: 'game-a', status: 'owned' }
  ]);
  assert.equal(cancelled.current, null);
  assert.equal(cancelled.pending.length, 0);
  assert.equal(cancelled.status, 'cancelled');
});
