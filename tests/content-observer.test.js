const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const observationApi = require('../scripts/core/epic-observation.js');
const libraryApi = require('../scripts/core/epic-library.js');

function element(text, attributes = {}, children = []) {
  const node = {
    innerText: text, textContent: text, parentElement: null, disabled: false,
    getAttribute: (key) => attributes[key] || null,
    getClientRects: () => [1],
    click() { this.clicks = (this.clicks || 0) + 1; }
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function page({ buttons = [], headings = [], text = '', checkout = false, decision = null, fetch = null } = {}) {
  const messages = [];
  const runtimeListeners = [];
  const body = element(text);
  const document = {
    body, documentElement: element(text),
    querySelectorAll(selector) {
      return selector.startsWith('button') ? buttons : selector.startsWith('h1') ? headings : [];
    },
    querySelector() { return buttons.find((button) => button.getAttribute('data-testid') === 'purchase-cta-button') || null; }
  };
  const window = { addEventListener() {} };
  window.top = window;
  const url = checkout ? 'https://payment-website-pci.ol.epicgames.com/purchase' : 'https://store.epicgames.com/en-US/p/example';
  const task = { gameId: 'example', url: 'https://store.epicgames.com/en-US/p/example', catalogEligible: true };
  const context = vm.createContext({
    FreebiesEpicObservation: observationApi, FreebiesEpicLibrary: libraryApi, fetch, document, window, location: new URL(url), URL, console,
    setTimeout: () => 1, setInterval: () => 1, clearTimeout() {}, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    chrome: { runtime: {
      id: 'ext-id',
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      sendMessage(message, callback) {
        messages.push(message);
        callback({ ok: true, task, decision: message.type === 'claim-observation' ? decision : null });
      }
    } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/content-epic.js'), 'utf8'), context);
  vm.runInContext(`activeTask = ${JSON.stringify(task)}`, context);
  const deliver = (message, sender = { id: 'ext-id' }) => new Promise((resolve) => {
    let async = false;
    for (const listener of runtimeListeners) async = listener(message, sender, resolve) === true || async;
    if (!async) setTimeout(() => resolve(undefined), 0);
  });
  return { context, messages, deliver, observe: () => context.collectObservation() };
}

test('content reads Free beside the original price and ignores unrelated page prices', () => {
  const get = element('Get', { 'data-testid': 'purchase-cta-button' });
  element('$19.99\nFree\nGet', {}, [get]);
  const env = page({ buttons: [get], text: '$99.99 unrelated recommendation' });
  assert.equal(env.observe().offerEvidence, 'confirmed');
  assert.equal(env.observe().identityMatch, true);
});

test('content scopes checkout to Total, excluding subtotal and original prices', () => {
  const order = element('Place Order');
  element('Original $19.99\nSubtotal $0.00\nTotal\n$0.00\nPlace Order', {}, [order]);
  const env = page({ buttons: [order], checkout: true });
  assert.equal(env.observe().checkoutTotalEvidence, 'confirmed');
  assert.equal(env.context.extractTotalText('Subtotal $0.00\nTotal: $0.99'), 'total: $0.99');
  assert.equal(env.context.extractTotalText('Subtotal $0.00\nPlace Order'), '');
});

test('content refuses paid totals including multi-group VND, and unknown checkout totals', () => {
  for (const total of ['$0.99', '100.000.000 ₫', '1 000 000 VND', 'THB 0.01']) {
    const order = element('Place Order');
    element(`Subtotal $0.00\nTotal\n${total}\nPlace Order`, {}, [order]);
    assert.equal(page({ buttons: [order], checkout: true }).observe().checkoutTotalEvidence, 'nonzero', total);
  }
  const order = element('Place Order');
  element('Free game\nSubtotal $0.00\nPlace Order', {}, [order]);
  assert.equal(page({ buttons: [order], checkout: true }).observe().checkoutTotalEvidence, 'unknown');
});

test('content recognizes purchase CTA ownership without matching marketing copy', () => {
  const owned = element('In Library', { 'data-testid': 'purchase-cta-button' });
  assert.equal(page({ buttons: [owned] }).observe().ownershipVisible, true);
  assert.equal(page({ text: 'Expand your collection of owned games in library' }).observe().ownershipVisible, false);
  const heading = element('Thanks for your order!');
  assert.equal(page({ headings: [heading], checkout: true }).observe().ownershipVisible, true);
});

test('content recognizes Vietnamese actions exactly and does not select Get Notifications', () => {
  const unrelated = element('Get Notifications');
  const get = element('NHẬN');
  const env = page({ buttons: [unrelated, get] });
  assert.equal(env.context.findActionButton('get'), get);
  assert.deepEqual([...env.observe().visibleActions], ['get']);
});

test('content rechecks checkout price before clicking and reports one failed action', async () => {
  const order = element('Place Order');
  element('Total $0.99\nPlace Order', {}, [order]);
  const env = page({ buttons: [order], checkout: true });
  await env.context.clickAction('place_order', { checkoutTotalEvidence: 'confirmed' });
  assert.equal(order.clicks || 0, 0);
  const results = env.messages.filter((message) => message.type === 'claim-action-result');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
});

test('explicit free Add to Library confirmation is scoped to its control', () => {
  const add = element('Add to Library');
  element('This is free. Add it to your library to get started\nAdd to Library', {}, [add]);
  assert.equal(page({ buttons: [add], checkout: true }).observe().checkoutTotalEvidence, 'confirmed');
});

test('Place Order dispatch does not report a spurious missing Add to Library action', async () => {
  const order = element('Place Order');
  element('Total\n$0.00\nPlace Order', {}, [order]);
  const env = page({ buttons: [order], checkout: true, decision: { action: 'click_confirm' } });
  await env.context.observePage();
  assert.equal(order.clicks, 1);
  const results = env.messages.filter((message) => message.type === 'claim-action-result');
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'place_order');
  assert.equal(results[0].success, true);
});

test('store pages relay only the read-only cover query, and only for this extension', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ data: { Catalog: { o0: { keyImages: [] } } } }) };
  };
  const { deliver } = page({ fetch });
  const query = libraryApi.catalogOffersQuery([{ id: 'epic-a', offerId: 'abc123', namespace: 'ns456' }]);

  const answered = await deliver({ type: 'freebies-catalog-images', query });
  assert.equal(answered.ok, true);
  assert.deepEqual(answered.payload, { data: { Catalog: { o0: { keyImages: [] } } } });
  assert.equal(requests[0].url, '/graphql');

  const injected = await deliver({ type: 'freebies-catalog-images', query: 'query{Catalog{x: catalogOffer(namespace: "a", id: "b") { price }}}' });
  assert.equal(injected.ok, false);
  const mutation = await deliver({ type: 'freebies-catalog-images', query: 'mutation{ addToCart }' });
  assert.equal(mutation.ok, false);
  await deliver({ type: 'freebies-catalog-images', query }, { id: 'other-extension' });
  assert.equal(requests.length, 1, 'rejected and foreign requests never reach Epic');
});
