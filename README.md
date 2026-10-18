# Epic Freebies Claimer

Epic Freebies Claimer is a Manifest V3 extension for Brave and Chrome that detects current Epic Games Store giveaways and helps claim them through the normal Epic checkout flow.

It uses the Epic account session already present in the browser. It does not store your password, access token, or payment details.

## Features

- Detects current Epic giveaways for the selected store region.
- Checks the signed-in state using Epic’s login endpoint with a cookie fallback and short-lived caching.
- Automates the supported free-game flow:
  `Get` → `Add to Library` / zero-cost checkout → owned confirmation.
- Claims games serially in inactive tabs: one game page is completed before the next game starts without switching away from the user's current tab.
- Recovers a persisted serial queue after a service-worker restart, and times out an unresponsive checkout after five minutes instead of leaving the queue stuck.
- Handles Epic checkout pages that open a child tab and rebinds the active claim automatically.
- Shows a quiet native notification with the game's cover when ownership is newly confirmed; cover loading is capped at two seconds and never pauses the claim queue.
- Recognizes a manually opened current giveaway page when Auto-claim is enabled.
- Detects games that go directly from `Get` to owned/library state.
- Syncs the claimed library with the Epic account's order history, so games already owned (including ones claimed on another computer) are recognised and skipped.
- Keeps claimed-game history in extension storage.
- Shows the three newest claimed games in the popup and opens the complete history as card-based library view.
- Opens Epic Store pages when a current-freebie or claimed-game card is clicked.
- Groups activity logs by date and provides a Kill control while a claim instance is running.

## Requirements

- Brave or Chrome with Manifest V3 support.
- An Epic Games Store account signed in within the same browser profile.
- Permission to load an unpacked extension during development.

## Installation

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this project directory.
5. Pin **Epic Freebies Claimer** to the browser toolbar.

After changing source files, use the extension page’s **Reload** button. Refresh any already-open Epic Store page so the updated content script is injected.

## First-time setup

1. Open the extension popup.
2. Click **Start** or **Manual Start**.
3. Sign in to Epic Games Store in the browser tab that opens.
4. Complete any Cloudflare challenge, CAPTCHA, age confirmation, or terms prompt manually.
5. Return to the extension popup and refresh the catalog if necessary.
6. Enable **Auto-claim new freebies** if you want automatic claiming.

The extension never bypasses CAPTCHA, payment prompts, non-zero prices, or an unknown checkout price. When one of these appears, the serial queue pauses at that game so you can finish it manually.

## Using the popup

### Current Freebies

The current giveaway cards show the game, expiration time, and claim state.

- Click the card to open its Epic Store page.
- Click **Claim** to start an individual claim.
- Click **Refresh** to force a catalog refresh.

### Claimed Library

The main popup shows the three newest games. Click the card to open the full Library view, built for accounts with hundreds of games:

- Search by title (press `/` to focus, `Esc` to clear, `Esc` again to close).
- Sort newest, oldest, or A–Z; the list is grouped by month (or by letter) with sticky headers.
- Filter chips: **All**, **Claimed here** (claimed by this extension), **From account** (imported from Epic order history).
- Rows render in pages of 60 as you scroll; games without a cover get a coloured monogram. Clicking a row opens its store page, or a store search for imported games.
- The sync button refreshes ownership from Epic order history.

### Automation

- **Auto-claim new freebies** enables automatic claiming during scheduled and manual scans.
- **Scheduled scans** run on browser startup, every hour, and a few minutes after the next promotion starts or ends (taken from Epic's catalog). Disabling it leaves only Manual Start.
- On startup the Epic login is often not ready yet; the scan retries every minute (up to five times) and also runs as soon as Epic reports a login.
- An unattended scan waits three hours before retrying a game that just failed; Manual Start always retries immediately.
- **Store Region** controls the Epic catalog country used for giveaway detection.

### Activity Log

The activity drawer records catalog, authentication, claim, and error events. New entries include a stored local date/time and are displayed under date separators. Older entries created before date-aware logging are grouped under **Earlier logs**.

### Kill

**Kill** is enabled only while a claim queue or active claim instance is running. It cancels pending queue items, closes extension-created claim tabs, and re-enables Manual Start.

## Claim flow

For a batch claim, the background worker creates a persistent serial queue:

1. Refresh the giveaway catalog.
2. Skip games already recorded as claimed or owned.
3. Open the next Epic Store page in an inactive tab.
4. Observe the page and click only verified actions.
5. Detect ownership, direct library transitions, or terminal failures.
6. Close the completed claim tab.
7. Continue with the next queued game.

If you manually open a URL matching a current unclaimed giveaway, the content script can adopt that tab when Auto-claim is enabled. A manually opened page is not adopted while a different serial queue item is active.

### Reliability safeguards in v3.2.0

- Ownership is confirmed through Epic's order history when the page does not show it, after each order click, before a claim times out, and when a claim tab is closed.
- If the order click leaves no ownership signal for 25 seconds, the product page is reloaded once so the observer can see "In Library" (or retry Get).
- A Get or confirmation click that has no visible effect is retried after 15 seconds, at most three times; Get is never re-clicked while Epic's checkout modal is open.
- All queue updates (tab events, the watchdog, popup polling) run under one lock.
- Epic's web session (`EPIC_SSO`) lasts about 8 hours, while the remembered account (`EPIC_SSO_RM`) lasts months. After the session lapses, Get detours through `www.epicgames.com/id/login/switch-account` ("Welcome back"). The observer selects the account when it is the only one listed and no password or code field is shown (at most twice per claim). Several accounts, a password, or MFA pause the claim with the reason in the activity log.
- A claim blocked by CAPTCHA/terms is abandoned after 15 minutes so the rest of the queue continues.

### Reliability safeguards in v3.1.0

- Queue and active-task writes are serialized so simultaneous browser events cannot overwrite each other's state.
- A one-minute watchdog verifies that the active tab and task still exist. If the worker restarted without a task, it restores the observer; if the tab disappeared, it records the failed item and continues the queue.
- Normal checkout progress has a five-minute timeout. CAPTCHA, terms, and other `needs attention` states remain paused for manual completion instead of timing out.
- The page observer runs in the top frame only, debounces DOM changes, and requires confirmed zero-cost evidence before clicking **Get** or checkout confirmation.

## Troubleshooting

### Popup says “Unable to verify”

Open Epic Store in the same browser profile and refresh the popup. The extension keeps a confirmed login through transient API failures, but an account must be signed in to the profile that owns the extension.

### A claim is paused

Open the active Epic tab and look for CAPTCHA, Cloudflare, age/terms confirmation, or a price other than zero. Complete the required manual step, then refresh the page. The observer can resume a paused task when a valid Get or confirmation action becomes available.

### Popup says "Session expired"

Epic's 8-hour web session ended but the account is still remembered. Claims continue: the extension picks your account on Epic's "Welcome back" page. If the log says it paused for a password or several accounts, sign in once in the claim tab.

### A stale task remains running

Open the activity drawer and click **Kill**, then reload the extension from the extensions page. Refresh any existing Epic Store tab after reloading.

### Catalog is empty

Check the selected Store Region and click **Refresh**. Epic promotions are country-dependent and can change while the catalog is being fetched.

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `storage` | Save settings, catalog cache, claim history, logs, and queue state. |
| `session` storage | Keep active claim tasks and the serial queue available to the service worker. |
| `alarms` | Run the once-per-day startup/daily check. |
| `notifications` | Show a native game-cover notification after a newly confirmed claim. |
| `tabs` | Open Epic Store pages, follow child checkout tabs, and close extension-created claim tabs. |
| `cookies` | Check the Epic session and observe login cookie changes. |
| Epic host permissions | Fetch giveaway data and run the content observer on Epic Store pages. |

The extension communicates only with Epic Games Store endpoints and the Epic static catalog endpoint configured in `manifest.json`. It does not send account data to a third-party service.

## Project structure

```text
manifest.json             Extension manifest and permissions
scripts/background.js     Service worker, storage, catalog, queue, and messages
scripts/content-epic.js   Epic page observer and safe action clicking
scripts/core/             Pure state, auth, observation, routing, queue, and library-sync modules
popup/popup.html           Popup structure and templates
popup/popup.js             Popup state, cards, modal, and activity log rendering
popup/popup.css            Popup styling
tests/core.test.js         Node regression tests for pure modules
tests/live-brave.mjs       Optional Brave/Playwright smoke harness
```

## Development checks

The project has no runtime dependencies beyond the browser extension APIs and Node’s built-in test runner.

```bash
npm test
npm run check
```

The automated tests cover migration, authentication fallback, safe page observation, zero-cost action gating, claim state transitions, serial queue behavior, child-tab rebinding, and manually opened giveaway URLs.

## Intentional limitations

- Library sync reads Epic's internal order-history endpoint (`www.epicgames.com/account/v2/payment/ajaxGetOrderHistory`). It is undocumented and may change; when it fails, the popup status shows "Library sync: …" and claiming continues using page detection only. Paid purchases appear in the library view too.
- Epic can change its page structure, labels, checkout flow, or catalog API. The observer is deliberately conservative and pauses when it cannot prove a safe zero-cost action.
- CAPTCHA, Cloudflare challenges, age gates, terms requiring explicit user action, payment prompts, and non-zero prices require manual handling.
