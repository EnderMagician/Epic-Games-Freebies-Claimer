(function attachClaimRouting(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesClaimRouting = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  function normalizedPath(value) {
    try {
      const parsed = new URL(value);
      if (!/^(store\.)?epicgames\.com$/i.test(parsed.hostname)) return '';
      return parsed.pathname.replace(/\/+$/, '').toLowerCase();
    } catch (error) {
      return '';
    }
  }

  function sameStoreGameUrl(left, right) {
    const leftPath = normalizedPath(left);
    const rightPath = normalizedPath(right);
    if (!leftPath || !rightPath) return false;
    if (leftPath === rightPath) return true;
    const leftProduct = leftPath.slice(leftPath.indexOf('/p/'));
    const rightProduct = rightPath.slice(rightPath.indexOf('/p/'));
    return leftProduct.startsWith('/p/') && leftProduct === rightProduct;
  }

  function findClaimableGameForUrl(url, catalog, claimedGames = []) {
    const completed = new Set((Array.isArray(claimedGames) ? claimedGames : [])
      .filter((game) => game?.status === 'claimed' || game?.status === 'owned')
      .map((game) => game.id));
    return (catalog?.epic || []).find((game) => game?.id && !completed.has(game.id) && sameStoreGameUrl(url, game.url)) || null;
  }

  return { sameStoreGameUrl, findClaimableGameForUrl };
});
