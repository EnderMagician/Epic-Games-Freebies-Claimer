# Storage and state

All persistent state is in `chrome.storage`. The service worker is the only writer except for small popup conveniences. Key names are constants at the top of `scripts/background.js`.

## `chrome.storage.local`

| Key | Shape | Notes |
| --- | --- | --- |
| `settings` | `normalizeSettings` output | `autoClaim`, `runOnStartup` (shown as **Scheduled scans**), `notifyOnClaim`, `country` (default `VN`), `lastDailyRun`, `lastRunAt`, `lastRunMessage`, `lastRunErrors` (≤ 10). |
| `catalog` | `{ epic: Game[], refreshedAt, errors }` | Current giveaways for the selected country; refreshed when older than 6 h or forced. |
| `claimedGames` | `ClaimedGame[]` (≤ 2000) | Claim history plus games imported from order history. `status`: `attempting` / `claimed` / `owned` / `failed`; `source: "epic_account"` marks imports. |
| `epicLibrary` | `{ syncedAt, itemCount, error, lastAttemptAt? }` | Order-history sync metadata. Re-synced after 30 min, or sooner after an error. |
| `libraryThumbs` | `{ [gameId]: dataUrl \| miss stamp }` | Cover cache, kept separate so `get-state` never carries image bytes. Misses are retried after 30 days. |
| `libraryThumbsFormat` | number | Bumped (`THUMBNAIL_FORMAT_VERSION`) to trigger a one-time re-encode of cached covers. |
| `sessionLogs` | `string[]` (≤ 80) | `[YYYY-MM-DD HH:MM:SS] message`, newest first. |
| `authState` | auth observation | Last resolved login state and account label. |
| `scheduleState` | object | `startupRetries`, `pendingCheck`, `lastCheckAt`, `lastCheckReason`. |
| `storageSchemaVersion` | number | Current schema is `2` (`SCHEMA_VERSION` in `state-model.js`). |
| `migrationBackupV2` | object | Pre-migration copy of settings, claimed games, and catalog. |

## `chrome.storage.session` (falls back to `local`)

| Key | Shape | Notes |
| --- | --- | --- |
| `activeClaimTasks` | `ClaimTask[]` | One per claim tab; see `createClaimTask` in `claim-machine.js`. |
| `claimQueue` | queue | `{ status: running \| completed \| cancelled, pending, current, results, startedAt, updatedAt }`. |

## Migrations

`ensureStorageMigration` calls `migrateStoredState` when `storageSchemaVersion` is behind, normalising settings, claimed games, and catalog and saving a backup. Add a new normaliser in `state-model.js` and bump `SCHEMA_VERSION` for breaking shape changes.

When cover lookups improve, bump `THUMBNAIL_LOOKUP_VERSION` so earlier "no cover" stamps are retried.

## Popup state

`get-state` returns `buildStateSnapshot(...)` plus `claimQueue`, `library`, `isClaimRunning`, `claimPhase` (`checking` while a scan fetches, `claiming` while a queue runs), and `accountEmail`.
