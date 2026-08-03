(function attachStateModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesStateModel = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  const SCHEMA_VERSION = 2;
  const DEFAULT_SETTINGS = Object.freeze({
    autoClaim: true,
    runOnStartup: true,
    notifyOnClaim: true,
    country: 'VN',
    lastDailyRun: '',
    lastRunAt: '',
    lastRunMessage: 'Chưa chạy auto-claim.',
    lastRunErrors: []
  });

  function normalizeSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      ...DEFAULT_SETTINGS,
      ...input,
      autoClaim: input.autoClaim !== false,
      runOnStartup: input.runOnStartup !== false,
      notifyOnClaim: input.notifyOnClaim !== false,
      country: typeof input.country === 'string' && input.country ? input.country : DEFAULT_SETTINGS.country,
      lastRunErrors: Array.isArray(input.lastRunErrors) ? input.lastRunErrors.slice(0, 10) : []
    };
  }

  function inferPlatform(record) {
    if (record.platform) return record.platform;
    if (typeof record.id === 'string' && record.id.startsWith('epic-')) return 'epic';
    return undefined;
  }

  function normalizeClaimedGames(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((record) => record && typeof record === 'object' && typeof record.id === 'string' && record.id)
      .map((record) => {
        const platform = inferPlatform(record);
        return platform ? { ...record, platform } : { ...record };
      });
  }

  function normalizeCatalog(value) {
    const catalog = value && typeof value === 'object' ? value : {};
    return {
      epic: Array.isArray(catalog.epic) ? catalog.epic.slice() : [],
      refreshedAt: typeof catalog.refreshedAt === 'string' ? catalog.refreshedAt : null,
      errors: catalog.errors && typeof catalog.errors === 'object' ? { ...catalog.errors } : {}
    };
  }

  function migrateStoredState(stored = {}, previousVersion = 0) {
    const source = stored && typeof stored === 'object' ? stored : {};
    const settings = normalizeSettings(source.settings);
    const claimedGames = normalizeClaimedGames(source.claimedGames);
    const catalog = normalizeCatalog(source.catalog);
    return {
      version: SCHEMA_VERSION,
      settings,
      claimedGames,
      catalog,
      backup: previousVersion < SCHEMA_VERSION
        ? { settings: source.settings || null, claimedGames: source.claimedGames || [], catalog: source.catalog || null }
        : null
    };
  }

  function buildStateSnapshot({ settings, catalog, claimedGames, auth, activeTasks, sessionLogs, errors } = {}) {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: normalizeSettings(settings),
      catalog: normalizeCatalog(catalog),
      claimedGames: normalizeClaimedGames(claimedGames),
      auth: auth && typeof auth === 'object' ? { ...auth } : { status: 'unknown', source: 'cached' },
      activeTasks: Array.isArray(activeTasks) ? activeTasks.slice() : [],
      sessionLogs: Array.isArray(sessionLogs) ? sessionLogs.slice() : [],
      errors: errors && typeof errors === 'object' ? { ...errors } : {}
    };
  }

  return {
    SCHEMA_VERSION,
    DEFAULT_SETTINGS,
    normalizeSettings,
    normalizeClaimedGames,
    normalizeCatalog,
    migrateStoredState,
    buildStateSnapshot
  };
});
