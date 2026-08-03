# Background Claims and Native Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing Epic serial claim queue in inactive tabs and show a native game-cover notification exactly once when ownership is newly confirmed.

**Architecture:** Keep the current Manifest V3 service worker, real Epic tabs, content-script observation, and serial queue. Add focus-target tracking around claim tabs and centralize notification emission on the stored claim-status transition so all successful claim paths behave consistently.

**Tech Stack:** Chrome/Brave Manifest V3 APIs, JavaScript, `chrome.tabs`, `chrome.storage`, `chrome.notifications`.

## Global Constraints

- Preserve the existing Epic login, Cloudflare, checkout, state-machine, and serial-queue flow.
- Open only one claim game at a time.
- Do not add non-Epic host permissions or external automation dependencies.
- Use native browser notifications; the operating system controls their outer appearance.
- Use the game's catalog cover when possible and the packaged extension icon as fallback.
- Do not execute automated tests; the user will perform browser testing.

---

### Task 1: Keep generated claim tabs in the background

**Files:**
- Modify: `scripts/background.js`

**Interfaces:**
- Consumes: existing `queueClaim(platform, id, active, options)` and serial queue state.
- Produces: inactive serial queue tabs and `returnTabId`/`returnWindowId` metadata on active claim tasks.

- [x] **Step 1: Record the active non-claim tab when a task is created**

Query the active tab in the current window before creating the background claim tab and attach its identifiers to the saved task.

- [x] **Step 2: Track later user tab changes while a claim remains active**

Add a `chrome.tabs.onActivated` listener that ignores claim tabs and Epic-created child tabs, then updates active tasks in the same window with the newest user-selected return tab.

- [x] **Step 3: Restore the return tab after an active Epic child tab is created**

After the existing child-task rebind completes, activate the saved return tab when the new child tab took focus.

- [x] **Step 4: Start serial claims with `active: false`**

Change the serial queue call from `queueClaim(next.platform, next.id, true, { serialQueue: true })` to `queueClaim(next.platform, next.id, false, { serialQueue: true })`.

### Task 2: Notify once when a game becomes owned

**Files:**
- Modify: `scripts/background.js`

**Interfaces:**
- Consumes: normalized claimed records, catalog `game.image`, and the current serial queue.
- Produces: `showClaimSuccessNotification(game)` and a native notification for a new completed-status transition.

- [x] **Step 1: Detect a newly completed status transition**

In `recordClaimStatus`, capture whether the existing record was already `owned` or `claimed`. After persisting the new record, call the notification helper only when the new status is completed and the previous record was not.

- [x] **Step 2: Build concise queue-aware notification copy**

Use the current queue before it advances. When a current item exists, calculate the just-completed position as `queue.results.length + 1` and total as `queue.results.length + queue.pending.length + 1`; mention the next game only when another pending item remains.

- [x] **Step 3: Create the native notification with the cover**

Fetch `game.image`, validate that it is an HTTPS image response, convert it to a data URL supported by the notification API, then call `chrome.notifications.create` with type `basic`, title `Claimed successfully`, the game-specific message, `silent: true`, and `requireInteraction: false`.

- [x] **Step 4: Retry with the extension icon if the cover is rejected**

Catch notification creation failure and retry with `chrome.runtime.getURL("icons/icon128.png")`, logging only if both attempts fail.

### Task 3: Review without running tests

**Files:**
- Review: `scripts/background.js`
- Review: `manifest.json`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a user-testable unpacked extension build.

- [x] **Step 1: Confirm permissions**

Verify that `manifest.json` already contains `notifications` and `tabs`, with no permission expansion.

- [x] **Step 2: Inspect all success paths**

Confirm both `claim-observation` and `claim-result` persist status through `recordClaimStatus`, and that the completed-state guard prevents duplicate native notifications.

- [x] **Step 3: Inspect focus and queue ordering**

Confirm the queue still opens only its current item, the claim and checkout tabs are tracked for Kill, and focus restoration never activates another generated claim tab.

- [x] **Step 4: Hand off manual verification**

Ask the user to reload the unpacked extension and verify background claiming, checkout child-tab behavior, game-cover notification rendering, duplicate suppression, and serial progression.
