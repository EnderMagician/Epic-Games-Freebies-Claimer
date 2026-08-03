(function attachAuthModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesAuthModel = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  function resolveAuthObservation({ api, hasAuthCookie, previous } = {}) {
    if (api?.status === 'logged_in') {
      return {
        status: 'logged_in',
        source: 'api',
        accountLabel: api.accountLabel || null,
        checkedAt: new Date().toISOString()
      };
    }
    if (api?.status === 'logged_out') {
      return { status: 'logged_out', source: 'api', accountLabel: null, checkedAt: new Date().toISOString() };
    }
    if (hasAuthCookie) {
      return {
        status: 'logged_in',
        source: 'cookie_fallback',
        accountLabel: previous?.accountLabel || null,
        error: api?.error || 'Epic login API was inconclusive.',
        checkedAt: new Date().toISOString()
      };
    }
    return {
      status: 'unknown',
      source: previous?.status === 'logged_in' ? 'cached' : 'api',
      accountLabel: previous?.accountLabel || null,
      error: api?.error || 'Epic login state could not be verified.',
      checkedAt: new Date().toISOString()
    };
  }

  function shouldLogAuthTransition(previous, next) {
    return (previous?.status || 'unknown') !== (next?.status || 'unknown')
      || (previous?.accountLabel || null) !== (next?.accountLabel || null);
  }

  return { resolveAuthObservation, shouldLogAuthTransition };
});
