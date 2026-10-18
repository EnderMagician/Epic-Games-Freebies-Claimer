# Testing

```bash
npm test          # all *.test.js suites with Node's built-in runner
npm run check     # syntax check of every script listed in package.json
```

No dependencies are needed for either command.

## Suites

| File | Scope | Technique |
| --- | --- | --- |
| `tests/core.test.js` | Pure modules in `scripts/core/` | Direct `require` of each module. |
| `tests/content-observer.test.js` | `scripts/content-epic.js` | Runs the script in `node:vm` with a minimal fake DOM (`element`, `page` helpers) and a fake `chrome.runtime`, then asserts on messages and clicks. |
| `tests/pipeline-simulation.test.js` | `scripts/background.js` end to end | Runs the worker in `node:vm` via `createExtensionEnvironment`, which mocks `chrome.storage`, `tabs`, `alarms`, `cookies`, `notifications`, and `fetch` for the catalog, login state, order history, store-content and store GraphQL. `createSampleOffer` builds catalog entries. |

### Adding a pipeline scenario

1. Call `createExtensionEnvironment({ initialStorage, orderHistory, loginState, storeGraphql, customFetch, cookies })`.
2. Dispatch messages or fire listeners exactly as the browser would (popup messages, content-script observations, tab events, alarms).
3. Assert on storage, logs, opened/closed tabs, and returned summaries.

Cover new claim-flow branches, scheduling rules, Kill behaviour, and library-sync edge cases here.

## Manual live check

`tests/live-brave.mjs` launches Brave with the unpacked extension through Playwright in a throwaway profile, waits for you to sign in to Epic, then prints popup state and exercises a claim. It needs Playwright and Brave installed; set `CODEX_NODE_MODULES` to the `node_modules` containing Playwright and `BRAVE_PATH` to the Brave executable (the defaults are Windows paths). It is not part of `npm test`.

## Manual browser check

1. Load the repo unpacked at `brave://extensions` or `chrome://extensions`.
2. After edits press **Reload** on the extension and refresh any open Epic tab.
3. Inspect the service worker console from the extensions page, and the popup console by right-clicking the popup → Inspect.
