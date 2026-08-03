# Background Claims and Native Notifications Design

## Goal

Keep the existing Epic Games Store claim state machine and serial queue while preventing claim tabs from taking focus, then notify the user through the browser's native notification surface when a game is newly confirmed as owned.

## Architecture

The extension continues to open real Epic Store tabs in the user's current browser profile so cookies, login state, Cloudflare clearance, checkout, and content scripts behave exactly as they do today. Serial queue tabs open with `active: false`; if Epic creates an active checkout child tab, the background worker rebinds the task and restores the most recent non-claim tab.

Successful ownership transitions are detected centrally in `recordClaimStatus`. A notification is emitted only when a record changes from a non-completed state to `owned` or `claimed`, preventing duplicate notifications from repeated page observations. Notification work is deliberately detached from the claim queue. The service worker fetches the catalog game cover for at most two seconds and converts it to a data URL accepted by the native notification API, falling back to the extension icon if the cover cannot be prepared.

## Notification

- Native `chrome.notifications` notification.
- Title: `Claimed successfully`.
- Message: `<game title> added to your library`.
- Queue context: `<completed> of <total> claimed · Next game starting` while more games remain.
- Final/single-game context: `Added to your Epic Games library`.
- Game cover converted to a data URL and supplied as `iconUrl`; extension icon used as a fallback.
- Non-persistent and silent so the operating system presents it unobtrusively.

The operating system controls the notification container, typography, duration, and final cropping of the cover image.

## Focus Preservation

Each generated claim task remembers the active non-claim tab in its window. While a claim is running, activation changes update that return target. When an Epic checkout child tab is created and takes focus, the extension returns focus to the remembered user tab after rebinding the task.

## Manual Attention

Login, CAPTCHA, Cloudflare, age/terms, and other manual-attention states remain visible in the activity log. Background operation does not automatically foreground the claim tab in this scope.

## Scope

No external headless browser, native messaging host, new dependency, custom webpage overlay, or broad non-Epic host permission is added.
