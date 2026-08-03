(function attachClaimQueue(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesClaimQueue = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  function cloneItem(item) {
    return {
      platform: item.platform || 'epic',
      id: item.id,
      title: item.title || item.id
    };
  }

  function createClaimQueue(items = [], now = Date.now()) {
    const pending = items.filter((item) => item?.id).map(cloneItem);
    return {
      status: pending.length > 0 ? 'running' : 'completed',
      pending,
      current: null,
      results: [],
      startedAt: now,
      updatedAt: now
    };
  }

  function beginNextClaim(queue, tabId, now = Date.now()) {
    if (!queue || queue.status !== 'running' || queue.current || queue.pending.length === 0) {
      return queue;
    }
    const [next, ...pending] = queue.pending;
    return {
      ...queue,
      pending,
      current: { ...next, tabId, startedAt: now },
      updatedAt: now
    };
  }

  function finishCurrentClaim(queue, { tabId, status, detail = '', now = Date.now() } = {}) {
    if (!queue?.current || queue.current.tabId !== tabId) return queue;
    const result = {
      ...queue.current,
      status,
      detail,
      finishedAt: now
    };
    return {
      ...queue,
      status: queue.pending.length > 0 ? 'running' : 'completed',
      current: null,
      results: [...queue.results, result],
      updatedAt: now
    };
  }

  function rebindCurrentClaim(queue, fromTabId, toTabId, now = Date.now()) {
    if (!queue?.current || queue.current.tabId !== fromTabId) return queue;
    return {
      ...queue,
      current: { ...queue.current, tabId: toTabId },
      updatedAt: now
    };
  }

  function skipNextClaim(queue, { status, detail = '', now = Date.now() } = {}) {
    if (!queue || queue.status !== 'running' || queue.current || queue.pending.length === 0) return queue;
    const [next, ...pending] = queue.pending;
    return {
      ...queue,
      status: pending.length > 0 ? 'running' : 'completed',
      pending,
      results: [...queue.results, { ...next, status, detail, finishedAt: now }],
      updatedAt: now
    };
  }

  function cancelClaimQueue(queue, now = Date.now()) {
    if (!queue) return null;
    return {
      ...queue,
      status: 'cancelled',
      pending: [],
      current: null,
      updatedAt: now
    };
  }

  return {
    createClaimQueue,
    beginNextClaim,
    rebindCurrentClaim,
    finishCurrentClaim,
    skipNextClaim,
    cancelClaimQueue
  };
});
