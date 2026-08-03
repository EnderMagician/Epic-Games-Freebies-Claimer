(function attachAuthClient(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesAuthClient = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  async function fetchLoginState(fetchImpl = fetch, timeoutMs = 4000) {
    const controller = new AbortController();
    let timer;
    const request = Promise.resolve().then(() => fetchImpl('https://www.epicgames.com/id/api/login/state', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      signal: controller.signal
    }));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'error', error: 'Epic login API timed out.' });
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([request.then(async (response) => {
        if (!response.ok) return { status: 'error', error: `Epic login API HTTP ${response.status}` };
        const data = await response.json();
        if (typeof data?.isLoggedIn !== 'boolean') return { status: 'error', error: 'Epic login API returned an invalid state.' };
        return data.isLoggedIn
          ? { status: 'logged_in', accountLabel: data.email || data.displayName || data.accountName || null }
          : { status: 'logged_out' };
      }).catch((error) => ({ status: 'error', error: error?.name === 'AbortError' ? 'Epic login API timed out.' : (error.message || String(error)) })), timeout]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchLoginState };
});
