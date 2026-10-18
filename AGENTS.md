# AGENTS.md

Guidance for coding agents working in this repository. User-facing behaviour is in [README.md](README.md); deeper internals are in [docs/](docs/).

## What this is

A Manifest V3 browser extension (Brave/Chrome) that finds the current Epic Games Store giveaways and claims them by driving Epic's normal store and checkout pages in inactive tabs. It uses the session already signed in to the browser profile and never handles passwords, tokens, or payment details.

There is no build step, no bundler, and no runtime dependency. The files in the repo are what the browser loads.

## Layout

| Path | Role |
| --- | --- |
| `manifest.json` | Permissions, host permissions, service worker, content scripts. Version must match `package.json`. |
| `scripts/background.js` | Service worker: storage, catalog fetch, auth, scheduling (alarms), serial claim queue, library sync, cover cache, message router. |
| `scripts/content-epic.js` | Content script on Epic pages: reads the DOM into an observation, sends it to the worker, clicks only what the worker decides. Also relays the cover GraphQL query. |
| `scripts/core/*.js` | Pure, DOM-free modules shared by the worker, the content script, and Node tests. |
| `popup/` | Popup UI (`popup.html`, `popup.js`, `popup.css`); talks to the worker only through messages. |
| `tests/` | Node built-in test runner suites, plus an optional manual Playwright/Brave harness. |
| `docs/` | Architecture and internals documentation (tracked in git). |

See [docs/architecture.md](docs/architecture.md) for how the pieces talk to each other.

## Commands

```bash
npm test          # node --test tests/*.test.js
npm run check     # node --check on every script
```

Run both before committing. `npm run check` lists each file explicitly: when you add a script, add it there too.

To try a change in the browser: load the folder unpacked at `brave://extensions` / `chrome://extensions`, press **Reload** after edits, and refresh any open Epic tab so the new content script is injected.

## Conventions

- **Core module pattern.** Every file in `scripts/core/` is a UMD-style IIFE that sets `globalThis.Freebies<Name>` and, under Node, `module.exports`. The worker loads them with `importScripts`; content scripts get them via the `content_scripts.js` list in `manifest.json`; tests `require` them. Keep them free of `chrome.*` and DOM access so they stay testable.
- **Decide in the worker, act in the page.** The content script reports observations; `reduceClaimTask` in `claim-machine.js` returns the decision (`click_get`, `click_confirm`, `click_account`, `complete_owned`, `needs_attention`, `wait`). The content script re-reads the DOM and re-checks price evidence before every click.
- **Safety is conservative by design.** Never click Get or confirmation without zero-cost evidence; never bypass CAPTCHA, Cloudflare, terms, age gates, password/MFA prompts, or non-zero prices. When unsure, pause (`needs_attention`) rather than act.
- **Locks.** Every read-modify-write of the claim queue or active tasks goes through `withQueueLock` (and per-tab `serializeClaimTask`). Do not do network work while holding the queue lock; it stalls popup `get-state` polling.
- **Single-flight helpers.** `runScheduledCheck`, `runClaimNow`, `syncEpicLibrary`, `resolveLibraryThumbnails` and `pumpClaimQueue` reuse an in-flight promise. Follow that pattern for new long-running worker jobs.
- **Storage.** Keys are constants at the top of `background.js`. Large blobs (cover data URLs) live under their own key so the polled popup state stays small. See [docs/storage.md](docs/storage.md).
- **Localisation.** Page matching normalises text (lowercase, accents stripped) and carries English and Vietnamese labels. Add both when you extend label lists.
- **Style.** Plain modern JS, no TypeScript, no framework. Comments explain *why* (Epic quirks, race conditions), not *what*. Match the existing density.

## Testing notes

- `tests/core.test.js` covers the pure modules.
- `tests/content-observer.test.js` runs `content-epic.js` in a `vm` with a fake DOM.
- `tests/pipeline-simulation.test.js` runs the whole `background.js` in a `vm` with a mocked `chrome` API and mocked Epic endpoints (catalog, login state, order history, store GraphQL). Add a scenario here for any change to the claim flow, scheduling, or library sync.
- `tests/live-brave.mjs` is a manual smoke harness against real Epic; it is not part of `npm test`.

More in [docs/testing.md](docs/testing.md).

## Gotchas

- Epic's endpoints used here (order history, store GraphQL, store-content) are undocumented and can change. Parse defensively and treat unexpected shapes as errors, never as "owns nothing" or "no cover". See [docs/epic-integration.md](docs/epic-integration.md).
- The service worker can be killed at any time. Anything that must survive lives in `chrome.storage`; the one-minute watchdog alarm (`reconcileClaimState`) repairs queue/task state after a restart.
- `EPIC_SSO` expires after ~8 hours while `EPIC_SSO_RM` keeps the account remembered; treat "logged out but remembered" as claimable.
- Bump `version` in both `manifest.json` and `package.json` for a release, and add a "Reliability safeguards" note to the README when behaviour changes.

## Commits

Conventional-commit style subjects (`feat:`, `fix:`, `chore:`, `docs:`) with a bulleted body grouped by area.
