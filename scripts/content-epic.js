const { buildEpicObservation, normalize, priceEvidence } = FreebiesEpicObservation;
const ACTION_LABELS = {
  get: ['get', 'get now', 'nhan', 'nhan ngay'],
  add_to_library: ['add to library', 'them vao thu vien'],
  place_order: ['place order', 'dat hang', 'confirm order', 'xac nhan dat hang']
};

let activeTask = null;
let observationInFlight = false;
let stopped = false;
let observer = null;
let intervalId = null;
let observationTimer = null;
let lastMessageError = '';

initializeClaimObserver().catch((error) => {
  void send({ type: 'claim-result', frameContext: detectContext(), platform: 'epic', id: activeTask?.gameId, status: 'failed', detail: error.message || String(error) });
});

async function initializeClaimObserver() {
  const allowAdoption = window.top === window;
  // Checkout frames may initialize before their tab task is rebound.
  for (let attempt = 0; attempt < 30 && !activeTask; attempt += 1) {
    const response = await send({
      type: 'claim-ready',
      url: location.href,
      frameContext: detectContext(),
      allowAdoption
    });
    if (response?.ok && response.task) activeTask = response.task;
    if (!activeTask) await delay(500);
  }
  if (!activeTask) {
    stopped = true;
    await send({
      type: 'claim-observer-failed',
      frameContext: detectContext(),
      detail: 'Claim observer could not attach to a task after 30 attempts (15 seconds).'
    });
    return;
  }

  observer = new MutationObserver(scheduleObservation);
  observer.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true });
  intervalId = setInterval(scheduleObservation, 1500);
  window.addEventListener('load', scheduleObservation, { once: false });
  scheduleObservation();
}

function scheduleObservation() {
  if (stopped || observationInFlight || observationTimer) return;
  observationTimer = setTimeout(() => {
    observationTimer = null;
    runObservation();
  }, 250);
}

function runObservation() {
  if (stopped || observationInFlight) return;
  observationInFlight = true;
  observePage()
    .catch((error) => send({ type: 'claim-action-result', frameContext: detectContext(), action: 'observation_error', success: false, detail: error.message || String(error) }))
    .finally(() => { observationInFlight = false; });
}

function collectObservation() {
  const context = detectContext();
  const buttons = actionElements()
    .map((element) => ({
      label: element.innerText || element.textContent,
      visible: isVisible(element),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      regionText: readRegion(element)
    }));
  const ctaRegions = buttons
    .filter((button) => button.visible && !button.disabled && ACTION_LABELS.get.includes(normalize(button.label)))
    .map((button) => button.regionText)
    .filter(Boolean);
  const confirmation = findActionButton('place_order') || findActionButton('add_to_library');
  const totalText = context === 'checkout' ? readCheckoutRegion(confirmation) : '';
  return buildEpicObservation({
    bodyText: document.body?.innerText || '',
    buttons,
    ctaRegions,
    checkoutRegions: totalText ? [totalText] : [],
    ownershipText: readOwnershipText(),
    context,
    catalogEligible: activeTask.catalogEligible === true,
    identityMatch: identifyPage()
  });
}

async function observePage() {
  const observation = collectObservation();
  const response = await send({
    type: 'claim-observation',
    url: location.href,
    frameContext: observation.context,
    observation
  });
  if (!response?.ok || !response.decision) return;
  activeTask = response.task || activeTask;
  if (response.decision.action === 'click_get') {
    await clickAction('get', observation);
  } else if (response.decision.action === 'click_confirm') {
    const action = observation.visibleActions.includes('place_order') ? 'place_order' : 'add_to_library';
    await clickAction(action, observation);
  } else if (response.decision.action === 'complete_owned') {
    stopObserver();
  }
}

async function clickAction(action, observation) {
  // Recheck the DOM after the asynchronous worker decision, before dispatching a click.
  observation = collectObservation();
  const element = findActionButton(action);
  if (!element) {
    await send({ type: 'claim-action-result', frameContext: observation.context, action, success: false, detail: `Could not find visible ${action} control.` });
    return false;
  }
  const evidence = action === 'get' ? observation.offerEvidence : observation.checkoutTotalEvidence;
  if (observation.blockers.length || observation.identityMatch === false ||
      (evidence !== 'confirmed' && !(action === 'get' && observation.catalogEligible === true && evidence === 'unknown'))) {
    await send({ type: 'claim-action-result', frameContext: observation.context, action, success: false, detail: `Refused ${action}: price evidence is ${evidence}.` });
    return false;
  }
  try {
    element.click();
    await send({ type: 'claim-action-result', frameContext: observation.context, action, success: true, detail: `Clicked ${action}.` });
    return true;
  } catch (error) {
    await send({ type: 'claim-action-result', frameContext: observation.context, action, success: false, detail: `Click ${action} failed.` });
    return false;
  }
}

function findActionButton(action) {
  const labels = ACTION_LABELS[action] || [];
  return actionElements().find((element) => {
    if (!isVisible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    const label = normalize(element.innerText || element.textContent);
    return labels.includes(label);
  }) || null;
}

function actionElements() {
  const elements = [...document.querySelectorAll('button, a[role="button"], [role="button"]')];
  const purchase = elements.find((element) => element.getAttribute('data-testid') === 'purchase-cta-button');
  return purchase ? [purchase, ...elements.filter((element) => element !== purchase)] : elements;
}

function readRegion(element) {
  let current = element;
  let fallback = '';
  for (let level = 0; current && level < 6; level += 1, current = current.parentElement) {
    if (current === document.body || current === document.documentElement) break;
    const text = normalize(current.innerText || current.textContent);
    if (level === 0) fallback = text;
    if (level > 0 && text.length >= 1 && text.length <= 1600) {
      if (priceEvidence(text, { allowFreeLabel: true }) !== 'unknown') return text;
    }
  }
  return fallback.slice(0, 1600);
}

function readCheckoutRegion(element) {
  if (!element) return '';
  let current = element;
  for (let level = 0; current && level < 8; level += 1, current = current.parentElement) {
    const text = current.innerText || '';
    const total = extractTotalText(text);
    if (total) return total;
    if (current === document.body || current === document.documentElement) break;
    if (/this is free\.? add it to your library to get started/.test(normalize(text))) return text;
  }
  return '';
}

function extractTotalText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/).map(normalize).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:order total|total|amount due|due today|tong cong|tong tien)(?:\s|:|$)/.test(lines[index])) continue;
    if (priceEvidence(lines[index], { zeroWins: false }) !== 'unknown') return lines[index].slice(0, 500);
    const next = lines[index + 1] || '';
    if (/^(?:[$€£₫฿]|usd|eur|gbp|vnd|thb|\d)/.test(next) && priceEvidence(next) !== 'unknown') {
      return `${lines[index]} ${next}`.slice(0, 500);
    }
  }
  return '';
}

function readOwnershipText() {
  const purchase = document.querySelector('[data-testid="purchase-cta-button"]');
  if (purchase && isVisible(purchase)) {
    const label = normalize(purchase.innerText || purchase.textContent);
    if (['owned', 'in library', 'already purchased', 'da so huu', 'trong thu vien'].includes(label)) return label;
  }
  if (detectContext() === 'checkout') {
    const success = [...document.querySelectorAll('h1, h2, h3, [role="heading"], [data-testid="order-success"]')]
      .find((element) => isVisible(element) && ['thanks for your order!', 'thanks for your order', 'thank you for your order!']
        .includes(normalize(element.innerText || element.textContent)));
    if (success) return normalize(success.innerText || success.textContent);
  }
  return '';
}

function identifyPage() {
  if (!activeTask?.url || !location.pathname.includes('/p/')) return null;
  try {
    const expected = new URL(activeTask.url);
    return expected.pathname.toLowerCase() === location.pathname.toLowerCase() ||
      expected.pathname.split('/p/')[1] === location.pathname.split('/p/')[1];
  } catch (error) {
    return null;
  }
}

function detectContext() {
  const path = location.pathname.toLowerCase();
  if (location.hostname === 'payment-website-pci.ol.epicgames.com' || /^\/(?:purchase|checkout|payment)(?:\/|$)/.test(path)) return 'checkout';
  if (findActionButton('place_order') || findActionButton('add_to_library')) return 'checkout';
  if (path.includes('/p/')) return 'product';
  return 'unknown';
}

function isVisible(element) {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function stopObserver() {
  stopped = true;
  observer?.disconnect();
  if (intervalId) clearInterval(intervalId);
  if (observationTimer) clearTimeout(observationTimer);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(message) {
  return new Promise((resolve) => {
    const finish = (response) => {
      if (!response.ok && response.error !== lastMessageError) {
        lastMessageError = response.error;
        console.warn(`[Freebies Claimer] ${message.type}: ${response.error}`);
      } else if (response.ok) lastMessageError = '';
      resolve(response);
    };
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
        else finish(response || { ok: false, error: 'No response from extension background.' });
      });
    } catch (error) {
      finish({ ok: false, error: error.message || String(error) });
    }
  });
}
