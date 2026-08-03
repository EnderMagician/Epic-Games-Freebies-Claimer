# Serial Claim Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claim Epic free games one at a time, opening the next page only after the current claim has terminated.

**Architecture:** A pure queue model defines deterministic state transitions. The background service worker persists that state and advances it only from terminal claim or tab-close events.

**Tech Stack:** Chrome Manifest V3 extension, JavaScript UMD modules, Node built-in test runner.

## Global Constraints

- Keep at most one batch claim tab active.
- Persist queue state in `chrome.storage.session`, with the existing local fallback.
- A `needs_attention` result pauses instead of advancing.
- Do not add dependencies.

---

### Task 1: Queue state model

**Files:**
- Create: `scripts/core/claim-queue.js`
- Modify: `tests/core.test.js`

**Interfaces:**
- Produces: `createClaimQueue(items, now)`, `beginNextClaim(queue, tabId, now)`, `finishCurrentClaim(queue, result)`, `skipNextClaim(queue, result)`, and `cancelClaimQueue(queue, now)`.

- [ ] **Step 1: Write failing tests** covering one-active-item enforcement, terminal release, mismatched tab protection, and cancellation.
- [ ] **Step 2: Run** `node --test tests/core.test.js` and confirm failure because `claim-queue.js` is absent.
- [ ] **Step 3: Implement** the minimal pure UMD queue model.
- [ ] **Step 4: Run** `node --test tests/core.test.js` and confirm all tests pass.

### Task 2: Background queue integration

**Files:**
- Modify: `scripts/background.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: the queue-model functions from Task 1.
- Produces: persisted queue helpers, a single-item queue pump, and terminal-event advancement.

- [ ] **Step 1: Import** the queue model and add the session-storage queue key.
- [ ] **Step 2: Replace** the batch tab-opening loop with queue creation plus one pump call.
- [ ] **Step 3: Persist** the current item before navigating its tab.
- [ ] **Step 4: Advance** after owned/claimed/failed completion or unexpected tab closure.
- [ ] **Step 5: Cancel** pending items from Kill Instance and expose persisted running state to the popup.
- [ ] **Step 6: Document** strict serial claiming in the README.

### Task 3: Verification

**Files:**
- Test: `tests/core.test.js`
- Check: all extension JavaScript entry points and core modules.

- [ ] **Step 1: Run** the complete Node test suite and confirm zero failures.
- [ ] **Step 2: Run** `node --check` for background, content, popup, test harness, and every core module.
- [ ] **Step 3: Reload** the unpacked extension for manual signed-in acceptance testing.

