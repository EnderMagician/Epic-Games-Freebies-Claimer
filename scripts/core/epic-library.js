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

  // Imported order-history items carry only a title. Epic's public store-content
  // API is keyed by product slug, which for most catalog games is the title in
  // kebab case; editions usually live under the base game's slug.
  const STORE_CONTENT_URL = 'https://store-content-ipv4.ak.epicgames.com/api/en-US/content/products/';

  function titleSlug(title) {
    // Strip trademark marks first: NFKD would expand "™" into the letters "TM".
    return String(title || '').replace(/['\u2019\u2122\u00ae\u00a9]/g, '').normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function thumbnailSlugCandidates(title) {
    const value = String(title || '');
    const candidates = [titleSlug(value)];
    for (const separator of [':', ' - ', ' \u2013 ', ' \u2014 ']) {
      if (value.includes(separator)) candidates.push(titleSlug(value.split(separator)[0]));
    }
    return [...new Set(candidates.filter((slug) => slug.length >= 2))];
  }

  function productMatchesTitle(productName, title) {
    if (!productName) return true;
    const product = normalizeTitle(productName);
    const wanted = normalizeTitle(title);
    return product === wanted || wanted.startsWith(product) || product.startsWith(wanted);
  }

  // Prefer landscape key art; fall back to the first screenshot.
  function extractStoreContentImage(payload, title) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.pages)) return null;
    if (!productMatchesTitle(payload.productName, title)) return null;
    const pages = [...payload.pages].sort((left, right) => (left?._slug === 'home' ? -1 : 0) - (right?._slug === 'home' ? -1 : 0));
    for (const page of pages) {
      const data = page?.data || {};
      const url = data.hero?.backgroundImageUrl
        || data.carousel?.items?.find((item) => item?.image?.src)?.image?.src
        || (Array.isArray(page?._images_) ? page._images_.find((src) => typeof src === 'string') : null)
        || data.gallery?.galleryImages?.find((image) => image?.src)?.src
        || data.about?.image?.src;
      if (typeof url === 'string' && /^https:\/\//.test(url)) return url;
    }
    return null;
  }

  // Library thumbnails render at 56x34 CSS px; 112px wide covers 2x screens.
  // Epic's image CDNs resize on the fly, cutting a cover to roughly 2 KB.
  const THUMBNAIL_WIDTH = 112;

  function thumbnailUrl(url, width = THUMBNAIL_WIDTH) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !/(?:^|\.)(?:epicgames\.com|unrealengine\.com)$/i.test(parsed.hostname)) return url;
      parsed.search = '';
      parsed.searchParams.set('resize', '1');
      parsed.searchParams.set('w', String(width));
      parsed.searchParams.set('quality', 'low');
      return parsed.toString();
    } catch (error) {
      return url;
    }
  }

  // Exact cover lookup: Epic's store GraphQL resolves an offer by namespace and
  // id, which order-history items carry. Aliases batch many offers per request.
  const STORE_GRAPHQL_URL = 'https://store.epicgames.com/graphql';
  const CATALOG_BATCH_SIZE = 25;
  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const KEY_IMAGE_PREFERENCE = ['OfferImageWide', 'DieselStoreFrontWide', 'DieselGameBoxWide', 'featuredMedia',
    'Thumbnail', 'DieselStoreFrontTall', 'OfferImageTall', 'DieselGameBoxTall', 'DieselGameBox'];

  function hasCatalogKey(game) {
    return SAFE_ID.test(String(game?.namespace || '')) && SAFE_ID.test(String(catalogOfferId(game) || ''));
  }

  function catalogOffersQuery(games) {
    const fields = games.filter(hasCatalogKey).map((game, index) =>
      `o${index}: catalogOffer(namespace: "${game.namespace}", id: "${catalogOfferId(game)}", locale: "en-US") { keyImages { type url } }`);
    return `query{Catalog{${fields.join(' ')}}}`;
  }

  function isCatalogOffersQuery(query) {
    return typeof query === 'string' && query.length <= 12000
      && /^query\{Catalog\{(?:o\d+: catalogOffer\(namespace: "[A-Za-z0-9_-]+", id: "[A-Za-z0-9_-]+", locale: "en-US"\) \{ keyImages \{ type url \} \} ?)+\}\}$/.test(query);
  }

  function pickKeyImage(keyImages) {
    const images = (Array.isArray(keyImages) ? keyImages : [])
      .filter((image) => typeof image?.url === 'string' && /^https:\/\//.test(image.url));
    for (const type of KEY_IMAGE_PREFERENCE) {
      const match = images.find((image) => image.type === type);
      if (match) return match.url;
    }
    return images[0]?.url || null;
  }

  // Returns id -> image URL, or null when Epic answered but has no image.
  // Throws when the response is not a usable GraphQL answer, so the caller can
  // tell "no cover" apart from "lookup failed" and retry the latter soon.
  function parseCatalogOffers(payload, games) {
    const catalog = payload?.data?.Catalog;
    if (!catalog || typeof catalog !== 'object') {
      const message = payload?.errors?.[0]?.message;
      throw new Error(message ? `Epic catalog lookup failed: ${message}` : 'Epic catalog lookup returned no data.');
    }
    const results = new Map();
    games.filter(hasCatalogKey).forEach((game, index) => {
      results.set(game.id, pickKeyImage(catalog[`o${index}`]?.keyImages));
    });
    return results;
  }

  return {
    STORE_GRAPHQL_URL, CATALOG_BATCH_SIZE, hasCatalogKey, catalogOffersQuery, isCatalogOffersQuery, pickKeyImage, parseCatalogOffers,
    THUMBNAIL_WIDTH, thumbnailUrl,
    ORDER_HISTORY_URL, STORE_CONTENT_URL, orderHistoryUrl, parseOrderHistory, findOwnedItem, mergeOwnedIntoClaimed,
    normalizeTitle, titleSlug, thumbnailSlugCandidates, extractStoreContentImage
  };
});
