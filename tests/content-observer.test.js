const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const observationApi = require('../scripts/core/epic-observation.js');

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

function page({ buttons = [], headings = [], text = '', checkout = false, decision = null } = {}) {
  const messages = [];
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
    FreebiesEpicObservation: observationApi, document, window, location: new URL(url), URL, console,
    setTimeout: () => 1, setInterval: () => 1, clearTimeout() {}, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    chrome: { runtime: { sendMessage(message, callback) {
      messages.push(message);
      callback({ ok: true, task, decision: message.type === 'claim-observation' ? decision : null });
    } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/content-epic.js'), 'utf8'), context);
  vm.runInContext(`activeTask = ${JSON.stringify(task)}`, context);
  return { context, messages, observe: () => context.collectObservation() };
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
