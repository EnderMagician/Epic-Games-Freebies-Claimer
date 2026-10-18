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

test('a checkout child reset to waiting_for_get can click its second Get action', () => {
  const childTask = {
    ...createClaimTask({ gameId: 'epic-checkout-child', tabId: 12 }),
    phase: 'waiting_for_get'
  };
  const result = reduceClaimTask(childTask, {
    ownershipVisible: false,
    visibleActions: ['get'],
    freeEvidence: 'confirmed',
    blockers: []
  }, 13);

  assert.equal(result.decision.action, 'click_get');
  assert.equal(result.task.phase, 'awaiting_outcome');
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
    context: 'checkout',
    checkoutRegions: ['Your total $0.00'],
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

test('scopes product eligibility to a free CTA and tolerates the original price', () => {
  const observation = buildEpicObservation({
    context: 'product',
    catalogEligible: true,
    bodyText: 'Game page $999.99 unrelated banner',
    ctaRegions: ['$19.99 Free Get'],
    buttons: [{ label: 'Get', visible: true, disabled: false }]
  });
  assert.equal(observation.offerEvidence, 'confirmed');
  assert.equal(observation.freeEvidence, 'confirmed');
});

test('refuses a paid checkout even when the product was catalog eligible', () => {
  const task = { ...createClaimTask({ gameId: 'epic-paid-checkout', tabId: 8 }), phase: 'awaiting_outcome', offerVerified: true };
  const result = reduceClaimTask(task, {
    context: 'checkout',
    visibleActions: ['place_order'],
    offerEvidence: 'confirmed',
    checkoutTotalEvidence: 'nonzero',
    catalogEligible: true,
    blockers: []
  }, 9);
  assert.equal(result.decision.action, 'wait');
  assert.match(result.decision.reason, /nonzero/i);
});

test('recognizes grouped nonzero VND checkout totals as paid', () => {
  assert.equal(buildEpicObservation({ context: 'checkout', checkoutRegions: ['Total 100.000 ₫'], buttons: [{ label: 'Place Order' }] }).checkoutTotalEvidence, 'nonzero');
  assert.equal(buildEpicObservation({ context: 'checkout', checkoutRegions: ['Total 10,000 ₫'], buttons: [{ label: 'Place Order' }] }).checkoutTotalEvidence, 'nonzero');
});

test('clearing a post-order blocker resumes waiting without placing a second order', () => {
  const task = { ...createClaimTask({ gameId: 'epic-confirmed', tabId: 8 }), phase: 'confirmation_clicked' };
  const paused = reduceClaimTask(task, { blockers: ['captcha'] }, 10);
  const resumed = reduceClaimTask(paused.task, {
    context: 'checkout', checkoutTotalEvidence: 'confirmed', visibleActions: ['place_order'], blockers: []
  }, 11);
  assert.equal(resumed.task.phase, 'confirmation_clicked');
  assert.equal(resumed.decision.action, 'wait');
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

test('retries a Get click that had no effect, but not behind an open checkout', () => {
  const { ACTION_RETRY_MS, MAX_ACTION_CLICKS } = require('../scripts/core/claim-machine.js');
  const observation = { context: 'product', visibleActions: ['get'], offerEvidence: 'confirmed', checkoutTotalEvidence: 'unknown', blockers: [] };
  const first = reduceClaimTask(createClaimTask({ gameId: 'epic-retry', tabId: 1, now: 0 }), observation, 1000);
  assert.equal(first.decision.action, 'click_get');

  const tooSoon = reduceClaimTask(first.task, observation, 1000 + ACTION_RETRY_MS - 1);
  assert.equal(tooSoon.decision.action, 'wait');

  const behindModal = reduceClaimTask(first.task, { ...observation, checkoutOverlay: true }, 1000 + ACTION_RETRY_MS);
  assert.equal(behindModal.decision.action, 'wait');

  let task = first.task;
  let now = 1000;
  for (let click = 2; click <= MAX_ACTION_CLICKS; click += 1) {
    now += ACTION_RETRY_MS;
    const retried = reduceClaimTask(task, observation, now);
    assert.equal(retried.decision.action, 'click_get');
    assert.match(retried.decision.reason, /retrying/);
    task = retried.task;
  }
  const exhausted = reduceClaimTask(task, observation, now + ACTION_RETRY_MS);
  assert.equal(exhausted.decision.action, 'wait');
});

test('retries a free confirmation click that left the button in place', () => {
  const { ACTION_RETRY_MS } = require('../scripts/core/claim-machine.js');
  const checkout = { context: 'checkout', visibleActions: ['add_to_library'], offerEvidence: 'unknown', checkoutTotalEvidence: 'confirmed', blockers: [] };
  const start = { ...createClaimTask({ gameId: 'epic-confirm-retry', tabId: 1, now: 0 }), phase: 'awaiting_outcome' };
  const first = reduceClaimTask(start, checkout, 100);
  assert.equal(first.decision.action, 'click_confirm');
  assert.equal(reduceClaimTask(first.task, checkout, 200).decision.action, 'wait');
  assert.equal(reduceClaimTask(first.task, checkout, 100 + ACTION_RETRY_MS).decision.action, 'click_confirm');
});

test('recognizes current Epic ownership and order-success wording', () => {
  const { isOwnershipText } = require('../scripts/core/epic-observation.js');
  for (const text of ['In Library', 'Owned', 'Thanks for your order!', 'Order complete', 'Đã sở hữu', 'Added to your library']) {
    assert.equal(isOwnershipText(text), true, text);
  }
  for (const text of ['Get', 'Add it to your library to get started', 'Library', '']) {
    assert.equal(isOwnershipText(text), false, text);
  }
});

test('parses Epic order history and merges ownership into claim history', () => {
  const { parseOrderHistory, mergeOwnedIntoClaimed } = require('../scripts/core/epic-library.js');
  const parsed = parseOrderHistory({
    orders: [
      { createdAtMillis: 1_700_000_000_000, items: [{ offerId: 'a1', namespace: 'n1', description: 'Alpha' }] },
      { orderStatus: 'REFUNDED', items: [{ offerId: 'r1', description: 'Refunded' }] },
      { items: [{ offerId: 'b2', description: 'Beta: Deluxe' }] }
    ],
    nextPageToken: 'next'
  });
  assert.deepEqual(parsed.items.map((item) => item.offerId), ['a1', 'b2']);
  assert.equal(parsed.nextPageToken, 'next');
  assert.throws(() => parseOrderHistory({}), /unexpected/);

  const catalog = [
    { id: 'epic-a1', title: 'Alpha', image: 'a.jpg', url: 'https://store.epicgames.com/p/alpha' },
    { id: 'epic-zz', title: 'Beta - Deluxe' },
    { id: 'epic-cc', title: 'Gamma' }
  ];
  const claimed = [{ id: 'epic-cc', title: 'Gamma', status: 'failed' }];
  const merged = mergeOwnedIntoClaimed(claimed, catalog, parsed.items, '2026-01-01T00:00:00.000Z');
  const byId = new Map(merged.claimedGames.map((game) => [game.id, game]));
  assert.equal(byId.get('epic-a1').status, 'owned');
  assert.equal(byId.get('epic-a1').image, 'a.jpg');
  assert.equal(byId.get('epic-zz').status, 'owned', 'matches by normalized title when offer ids differ');
  assert.equal(byId.get('epic-cc').status, 'failed', 'unowned history is untouched');
  assert.equal(merged.claimedGames.filter((game) => game.title.startsWith('Beta')).length, 1, 'no duplicate import');
  assert.equal(claimed[0].status, 'failed', 'input is not mutated');
});

test('classifies Epic\'s "Welcome back" account picker conservatively', () => {
  const { classifyAccountPicker } = require('../scripts/core/epic-observation.js');
  const url = 'https://www.epicgames.com/id/login/switch-account?lang=en-US&redirect_uri=https%3A%2F%2Fstore.epicgames.com%2Fp%2Fx';
  const common = ['Privacy Policy', 'Terms of Service', 'Sign in with another account', 'Help', ''];

  const single = classifyAccountPicker({ url, bodyText: 'Welcome back', candidates: [...common, 'GamerOne g***@example.com'] });
  assert.equal(single.state, 'single');
  assert.equal(single.index, common.length);

  assert.equal(classifyAccountPicker({ url, bodyText: 'Welcome back', candidates: [...common, 'GamerOne', 'GamerTwo'] }).state, 'ambiguous');
  assert.equal(classifyAccountPicker({ url, bodyText: 'Welcome back', candidates: common }).state, 'no_account');
  assert.equal(classifyAccountPicker({ url, bodyText: 'Welcome back', hasPasswordField: true, candidates: [...common, 'GamerOne'] }).state, 'password');
  assert.equal(classifyAccountPicker({ url: 'https://www.epicgames.com/id/login?lang=en-US', bodyText: 'Sign in', hasPasswordField: true }).state, 'password');
  assert.equal(classifyAccountPicker({ url: 'https://store.epicgames.com/en-US/p/x', bodyText: 'Welcome back', candidates: ['GamerOne'] }).state, 'none');
});

test('derives store-content slugs and picks landscape cover art', () => {
  const { thumbnailSlugCandidates, extractStoreContentImage, thumbnailUrl } = require('../scripts/core/epic-library.js');
  assert.deepEqual(thumbnailSlugCandidates("Them's Fightin' Herds"), ['thems-fightin-herds']);
  assert.deepEqual(thumbnailSlugCandidates('Shadow Tactics: Blades of the Shogun'), ['shadow-tactics-blades-of-the-shogun', 'shadow-tactics']);
  assert.deepEqual(thumbnailSlugCandidates('LEGO® Batman™ & Robin'), ['lego-batman-and-robin']);

  const payload = {
    productName: 'Shadow Tactics',
    pages: [
      { _slug: 'deluxe', data: { hero: { backgroundImageUrl: 'https://cdn2.unrealengine.com/deluxe.jpg' } } },
      { _slug: 'home', data: { hero: { backgroundImageUrl: '' }, carousel: { items: [{ image: { src: 'https://cdn2.unrealengine.com/home.jpg' } }] } } }
    ]
  };
  assert.equal(extractStoreContentImage(payload, 'Shadow Tactics: Blades of the Shogun'), 'https://cdn2.unrealengine.com/home.jpg');
  assert.equal(extractStoreContentImage({ ...payload, productName: 'Shadow Warrior' }, 'Shadow Tactics'), null, 'a different product is rejected');
  assert.equal(extractStoreContentImage({}, 'x'), null);

  assert.equal(thumbnailUrl('https://cdn1.epicgames.com/offer/a/b.jpg?h=480'), 'https://cdn1.epicgames.com/offer/a/b.jpg?resize=1&w=112&quality=low');
  assert.equal(thumbnailUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
});
