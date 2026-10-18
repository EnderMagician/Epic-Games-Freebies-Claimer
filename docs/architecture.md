# Architecture

The extension has three runtime contexts that communicate only through `chrome.runtime` messages and `chrome.storage`.

```text
 ┌──────────────┐  messages   ┌──────────────────────────┐  messages   ┌────────────────────┐
 │  popup/      │ ──────────▶ │ scripts/background.js    │ ◀────────── │ scripts/           │
 │  popup.js    │ ◀────────── │ (MV3 service worker)     │ ──────────▶ │ content-epic.js    │
 └──────────────┘  get-state  │                          │  decisions  │ (Epic store pages) │
                              │  importScripts(core/*)   │             │  + core/ modules   │
                              └─────────┬────────────────┘             └────────────────────┘
                                        │ fetch
                                        ▼
                        Epic catalog, login, order history, store GraphQL
```

## Service worker (`scripts/background.js`)

Owns all state and all decisions. Responsibilities, roughly in file order:

- **Logging** – `addLog` / `addClaimLog` (de-duplicated within 10 s) write to `sessionLogs` (last 80 entries).
- **Lifecycle** – `onInstalled` and `onStartup` ensure settings and alarms, reconcile claim state, and run a scheduled check.
- **Alarms** – `freebies-daily-check` (hourly scan), `freebies-claim-watchdog` (every minute, `reconcileClaimState`), `freebies-startup-retry` (login not ready yet, up to 5 tries), `freebies-next-drop` (a few minutes after the next promotion boundary from the catalog).
- **Tab events** – `onRemoved` fails or confirms (via order history) a claim whose tab was closed; `onCreated` rebinds a claim to a checkout child tab; `onActivated` remembers which tab to return the user to.
- **Cookie events** – changes to Epic auth cookies trigger a debounced auth refresh.
- **Message router** – `handleMessage` switches on `message.type`. Popup messages include `get-state`, `refresh-catalog`, `update-settings`, `run-claim-now`, `claim-item`, `sync-library`, `resolve-thumbnails`, `kill-instance`, `clear-logs`, `open-game`, `open-login`, `logout`. Content-script messages include `claim-ready`, `claim-observation`, `claim-action-result`, `claim-observation-log`, `claim-observer-failed`.
- **Auth** – `checkEpicLoginStatus` combines the login-state API with a cookie fallback (`resolveAuthObservation`) and caches for 15 s. `remembered` reflects `EPIC_SSO_RM`.
- **Catalog** – `refreshCatalog` / `fetchEpicGames` read Epic's free-games promotions for the selected country (cached 6 h, 15 s fetch timeout).
- **Claim pipeline** – `runClaimBatch` → `runClaimBatchLocked` → `createClaimQueue` → `pumpClaimQueue` → `queueClaim`. Details in [claim-flow.md](claim-flow.md).
- **Library sync** – `syncEpicLibrary` pages through order history (≤ 40 pages, 30 min TTL) and merges ownership into `claimedGames` via `mergeOwnedIntoClaimed`.
- **Covers** – `resolveLibraryThumbnails` looks up covers by namespace/offer id through store GraphQL (batches of 25, relayed through an open store tab if Cloudflare blocks the worker), downloads them resized, re-encodes to 112×68 WebP, and stores them under `libraryThumbs`.
- **Notifications** – `showClaimSuccessNotification` shows a native notification with the cover (cover fetch capped at 2 s).

### Concurrency primitives

| Primitive | Purpose |
| --- | --- |
| `withQueueLock(fn)` | Serialises every claim-queue / active-task read-modify-write. |
| `serializeClaimTask(tabId, fn)` | Serialises observation handling per tab. |
| `mutateClaimState(fn)` | Serialises active-task storage writes. |
| `sessionLogMutation` | Serialises log writes. |
| `*Promise` single-flight vars | `runScheduledCheck`, `runClaimNow`, `syncEpicLibrary`, `resolveLibraryThumbnails`, `pumpClaimQueue` join a job already running. |
| `claimChecksInFlight` / `claimCheckGeneration` | Mark a scan as running before a queue exists, and let **Kill** cancel a scan that is still fetching. |

## Content script (`scripts/content-epic.js`)

Injected on `store.epicgames.com`, `www.epicgames.com`, and the PCI payment host (all frames). Loaded after `core/epic-observation.js` and `core/epic-library.js`.

- On load it sends `claim-ready`; the worker replies with the active task for this tab (or adopts a manually opened giveaway page when Auto-claim is on).
- A debounced `MutationObserver` plus an interval call `observePage`, which builds an observation with `buildEpicObservation` (visible actions, price evidence, ownership text, blockers, account picker state) and sends `claim-observation`.
- The worker's decision is executed by `clickAction` / `clickRememberedAccount`, which re-read the DOM and re-check evidence first, then report `claim-action-result`.
- Separately, in top-level `store.epicgames.com` frames, it answers `freebies-catalog-images` messages from this extension only, after validating the query with `isCatalogOffersQuery`, by POSTing it same-origin to `/graphql`.

## Core modules (`scripts/core/`)

| Module | Global | Contents |
| --- | --- | --- |
| `state-model.js` | `FreebiesStateModel` | Schema version, default settings, normalisers, migration, popup state snapshot. |
| `auth-model.js` | `FreebiesAuthModel` | Resolves API + cookie signals into `logged_in` / `logged_out` / `unknown`. |
| `auth-client.js` | `FreebiesAuthClient` | `fetchLoginState` against `/id/api/login/state` with timeout. |
| `claim-machine.js` | `FreebiesClaimMachine` | `createClaimTask`, `reduceClaimTask` state machine. |
| `claim-queue.js` | `FreebiesClaimQueue` | Immutable serial-queue operations. |
| `claim-routing.js` | `FreebiesClaimRouting` | Matches a page URL to an unclaimed catalog giveaway. |
| `epic-observation.js` | `FreebiesEpicObservation` | Text normalisation, price evidence, ownership/blocker detection, account picker classification. |
| `epic-library.js` | `FreebiesEpicLibrary` | Order-history parsing and merge, cover lookup (GraphQL query builder/validator/parser, store-content fallback), thumbnail URLs. |

## Popup (`popup/`)

`popup.js` polls `get-state` (every 5 s idle, 1.5 s while a scan runs) and renders the current freebies, the three newest claimed games, the full library modal (search, sort, filter chips, paged rendering), automation settings, and the activity log drawer. Covers are read once from `libraryThumbs` rather than through the poll. Native `<select>` elements marked `data-dropdown` are enhanced into a themed listbox that keeps the hidden select as the source of truth.
