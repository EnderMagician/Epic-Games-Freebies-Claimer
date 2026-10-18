# Claim flow

## Triggers

| Trigger | Entry point | Notes |
| --- | --- | --- |
| Browser startup / install | `runScheduledCheck("startup" \| "install")` | Retries every minute up to 5 times if Epic login is not ready. |
| Hourly alarm | `runScheduledCheck("periodic")` | Quiet logging. |
| Next promotion boundary | `runScheduledCheck("new-drop")` | Forces a catalog refresh. |
| Popup **Manual Start** | `runClaimNow()` | Forces catalog and library refresh; retries recently failed games immediately. |
| Popup **Claim** on one card | `queueClaim(platform, id, true)` | Single claim, outside the serial queue. |
| User opens a giveaway page | `claim-ready` → `getOrAdoptClaimTask` | Adopted only when Auto-claim is on and no other queue item is active. |

Scheduled checks are skipped when **Scheduled scans** or **Auto-claim** is off, and deferred when the account is logged out and not remembered.

## Batch pipeline

1. `runClaimBatch` increments `claimChecksInFlight`, returns early if a queue or active task is already running (`busyClaimSummary`).
2. Outside the queue lock: `refreshCatalog`, then `syncEpicLibrary` so games owned on the account are skipped without opening a tab.
3. If **Kill** bumped `claimCheckGeneration` meanwhile, the scan is cancelled.
4. Under the lock, `runClaimBatchLocked` filters out completed games and (for automatic runs) games that failed within the last 3 hours, then saves a `claimQueue` via `createClaimQueue`.
5. `pumpClaimQueue` takes the next pending item and calls `queueClaim`, which creates an inactive `about:blank` tab, saves an active task, calls `beginNextClaim`, and then navigates the tab to the store page.
6. When the item finishes (`finishSerialQueueItem`), the tab is closed and the pump continues. `finalizeSerialQueue` writes the summary when nothing is pending.

## Per-tab state machine (`reduceClaimTask`)

```text
waiting_for_get ──click_get──▶ awaiting_outcome ──click_confirm──▶ confirmation_clicked
       │                             │                                   │
       └──────── ownershipVisible ───┴──────────── ownershipVisible ─────┴──▶ completed (owned)

any non-terminal phase ──blockers──▶ needs_attention ──blockers cleared──▶ resumePhase
```

- **Get** requires product eligibility: the catalog says it is free, or the CTA region shows zero-price / "free" evidence, and never a non-zero current price.
- **Confirm** (`add_to_library` / `place_order`) requires a checkout total confirmed as zero.
- A Get or confirmation click with no visible effect is retried after 15 s, at most 3 times. Get is never re-clicked while the checkout overlay is open.
- Blockers: `captcha`, `terms`, `login`, `compatibility`, `parental_pin`, `region`, `age_verification`.

## Worker safeguards around the state machine

- **Order-history confirmation** (`isOwnedOnAccount`): checked every 10 s after an order click (after a 20 s grace), before a timeout, and when the claim tab is closed.
- **Reload once**: if a confirmation click leaves no ownership signal for 25 s, the product page is reloaded once.
- **Timeouts**: normal progress times out after 5 min; `needs_attention` is abandoned after 15 min so the queue continues.
- **Account picker**: on Epic's "Welcome back" page (`/id/login/switch-account`) the worker decides `click_account` only when exactly one remembered account is listed and no password field is present, at most twice per claim (8 s apart). Several accounts, a password, or MFA pause the claim.
- **Child tabs**: when Epic opens checkout in a new tab, the task and queue item are rebound to it (`rebindClaimToChildTab`) and the user's previous tab is restored.
- **Frame trust**: observations are accepted only from `https://store.epicgames.com`, `https://www.epicgames.com`, or, for checkout frames, the PCI payment host (`isTrustedClaimFrame`).
- **Watchdog**: every minute `reconcileClaimState` restores lost observers, fails items whose tab vanished, and applies timeouts.

## Kill

`killInstance` bumps `claimCheckGeneration`, cancels the queue (`cancelClaimQueue`), closes extension-created claim tabs, and clears active tasks. A scan still in its fetch phase notices the generation change and returns "Claim scan cancelled."

## Outcomes

Results are recorded with `recordClaimStatus` in `claimedGames` (`attempting`, `claimed`, `owned`, `failed`). Newly confirmed ownership shows a notification when **notifyOnClaim** is on.
