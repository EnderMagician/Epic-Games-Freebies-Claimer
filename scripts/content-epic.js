const { buildEpicObservation, normalize } = FreebiesEpicObservation;

let activeTask = null;
let observationInFlight = false;
let stopped = false;
let observer = null;
let intervalId = null;

initializeClaimObserver().catch((error) => {
  send({ type: 'claim-result', platform: 'epic', id: activeTask?.gameId, status: 'failed', detail: error.message || String(error) });
});

async function initializeClaimObserver() {
  const allowAdoption = window.top === window.self;
  for (let attempt = 0; attempt < (allowAdoption ? 1 : 2) && !activeTask; attempt += 1) {
    const response = await send({ type: 'claim-ready', url: location.href, allowAdoption });
    if (response?.ok && response.task) activeTask = response.task;
    if (!activeTask) await delay(500);
  }
  if (!activeTask) return;

  observer = new MutationObserver(scheduleObservation);
  observer.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true, attributes: true });
  intervalId = setInterval(scheduleObservation, 900);
  window.addEventListener('load', scheduleObservation, { once: false });
  scheduleObservation();
}

function scheduleObservation() {
  if (stopped || observationInFlight) return;
  observationInFlight = true;
  observePage().finally(() => { observationInFlight = false; });
}

async function observePage() {
  const observation = buildEpicObservation({
    bodyText: document.body?.innerText || '',
    buttons: [...document.querySelectorAll('button, a[role="button"], [role="button"]')].map((element) => ({
      label: element.innerText || element.textContent,
      visible: isVisible(element),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
    }))
  });
  const response = await send({ type: 'claim-observation', observation });
  if (!response?.ok || !response.decision) return;
  activeTask = response.task || activeTask;
  if (response.decision.action === 'click_get') {
    await clickAction('get', observation);
  } else if (response.decision.action === 'click_confirm') {
    await clickAction('add_to_library', observation) || await clickAction('place_order', observation);
  } else if (response.decision.action === 'complete_owned') {
    stopObserver();
  }
}

async function clickAction(action, observation) {
  const element = findActionButton(action);
  if (!element || observation.freeEvidence === 'nonzero' || (action !== 'get' && observation.freeEvidence !== 'confirmed')) return false;
  element.click();
  await send({ type: 'claim-action-result', action, detail: `Clicked ${action}.` });
  return true;
}

function findActionButton(action) {
  const labels = {
    get: ['get', 'get now', 'nhận', 'nhận ngay'],
    add_to_library: ['add to library', 'thêm vào thư viện'],
    place_order: ['place order', 'đặt hàng', 'confirm order', 'xác nhận đặt hàng']
  }[action] || [];
  return [...document.querySelectorAll('button, a[role="button"], [role="button"]')].find((element) => {
    if (!isVisible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    const label = normalize(element.innerText || element.textContent);
    return labels.some((wanted) => label === wanted || label.includes(wanted));
  }) || null;
}

function isVisible(element) {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function stopObserver() {
  stopped = true;
  observer?.disconnect();
  if (intervalId) clearInterval(intervalId);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'No response from extension background.' });
    });
  });
}
