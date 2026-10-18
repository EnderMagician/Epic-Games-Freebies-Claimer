(function attachEpicLibrary(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesEpicLibrary = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  const ORDER_HISTORY_URL = 'https://www.epicgames.com/account/v2/payment/ajaxGetOrderHistory';

  function normalizeTitle(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function orderHistoryUrl(pageToken = '') {
    const url = new URL(ORDER_HISTORY_URL);
    url.searchParams.set('sortDir', 'DESC');
    url.searchParams.set('sortBy', 'DATE');
    url.searchParams.set('locale', 'en-US');
    if (pageToken) url.searchParams.set('nextPageToken', pageToken);
    return url.toString();
  }

  // The order-history endpoint is internal to Epic's account site, so parse it
  // defensively and treat any unexpected shape as an error instead of "owns nothing".
  function parseOrderHistory(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.orders)) {
      throw new Error('Epic order history returned an unexpected response.');
    }
    const items = [];
    for (const order of payload.orders) {
      if (!order || typeof order !== 'object') continue;
      const status = String(order.orderStatus || order.status || '').toUpperCase();
      if (/REFUND|CANCEL|REVOKE|CHARGEBACK/.test(status)) continue;
      const ownedAt = Number(order.createdAtMillis) || Date.parse(order.createdAt || '') || null;
      for (const item of Array.isArray(order.items) ? order.items : []) {
        const offerId = item?.offerId || item?.offer_id;
        if (!offerId) continue;
        items.push({
          offerId: String(offerId),
          namespace: item.namespace ? String(item.namespace) : null,
          title: String(item.description || item.title || offerId),
          ownedAt: ownedAt ? new Date(ownedAt).toISOString() : null
        });
      }
    }
    const nextPageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken
      ? payload.nextPageToken
      : null;
    return { items, nextPageToken };
  }

  function catalogOfferId(game) {
    if (game?.offerId) return String(game.offerId);
    return typeof game?.id === 'string' && game.id.startsWith('epic-') ? game.id.slice(5) : null;
  }

  function findOwnedItem(game, ownedItems = []) {
    const offerId = catalogOfferId(game);
    const title = normalizeTitle(game?.title);
    return ownedItems.find((item) => item.offerId === offerId)
      || (title ? ownedItems.find((item) => normalizeTitle(item.title) === title) : null)
      || null;
  }

  // Merge account ownership into the local claim history. Catalog games that the
  // account already owns become "owned"; every other owned item is imported so the
  // library view reflects the account rather than only this browser profile.
  function mergeOwnedIntoClaimed(claimedGames = [], catalogGames = [], ownedItems = [], now = new Date().toISOString()) {
    const claimed = claimedGames.map((game) => ({ ...game }));
    const byId = new Map(claimed.map((game, index) => [game.id, index]));
    const isDone = (game) => game.status === 'claimed' || game.status === 'owned';
    let added = 0;
    let updated = 0;
    const consumed = new Set();

    for (const game of catalogGames) {
      const owned = findOwnedItem(game, ownedItems);
      if (!owned) continue;
      consumed.add(owned.offerId);
      const index = byId.get(game.id);
      if (index !== undefined) {
        if (isDone(claimed[index])) continue;
        claimed[index] = { ...claimed[index], ...game, status: 'owned', detail: 'Owned on the Epic account.', source: 'epic_account', claimedAt: owned.ownedAt || now };
        updated += 1;
      } else {
        claimed.unshift({ ...game, status: 'owned', detail: 'Owned on the Epic account.', source: 'epic_account', claimedAt: owned.ownedAt || now });
        byId.set(game.id, 0);
        added += 1;
      }
    }

    const knownOfferIds = new Set(claimed.map(catalogOfferId).filter(Boolean));
    for (const item of ownedItems) {
      if (consumed.has(item.offerId) || knownOfferIds.has(item.offerId)) continue;
      knownOfferIds.add(item.offerId);
      claimed.push({
        id: `epic-${item.offerId}`,
        platform: 'epic',
        offerId: item.offerId,
        namespace: item.namespace,
        title: item.title,
        image: '',
        url: '',
        status: 'owned',
        detail: 'Imported from Epic order history.',
        source: 'epic_account',
        claimedAt: item.ownedAt || now
      });
      added += 1;
    }
    return { claimedGames: claimed, added, updated };
  }

  return { ORDER_HISTORY_URL, orderHistoryUrl, parseOrderHistory, findOwnedItem, mergeOwnedIntoClaimed, normalizeTitle };
});
