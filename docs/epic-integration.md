# Epic integration

Every Epic surface the extension depends on. Most are internal and undocumented; treat any unexpected response as an error rather than as an empty result.

## HTTP endpoints

| Endpoint | Used by | Purpose |
| --- | --- | --- |
| `store-site-backend-static.ak.epicgames.com/freeGamesPromotions?country=…` | `fetchEpicGames` | Current and upcoming free promotions. |
| `www.epicgames.com/id/api/login/state` | `auth-client.js` | `isLoggedIn` plus account label. 4 s timeout. |
| `www.epicgames.com/account/v2/payment/ajaxGetOrderHistory` | `syncEpicLibrary`, `isOwnedOnAccount` | Paged order history (`nextPageToken`); refunded/cancelled/revoked orders are ignored. |
| `store.epicgames.com/graphql` | `fetchCatalogOfferImages` | `catalogOffer(namespace, id)` → `keyImages`, aliased `o0…oN`, 25 per request. Behind Cloudflare. |
| `store-content-ipv4.ak.epicgames.com/api/en-US/content/products/<slug>` | `fetchStoreContentThumbnail` | Fallback cover lookup by title slug for records without a namespace/offer id. |
| Epic image CDNs (`*.epicgames.com`, `*.unrealengine.com`) | `thumbnailUrl` | `?resize=1&w=112&quality=low` for small covers. |

### Cloudflare relay

When the worker's GraphQL request is blocked (non-JSON or HTTP error), the same query is sent to any open `store.epicgames.com` tab as a `freebies-catalog-images` message. The content script accepts it only from this extension and only if it matches `isCatalogOffersQuery` (a strict regex allowing nothing but catalog-offer image lookups), then POSTs it same-origin.

## Cookies

The worker watches `EPIC_BEARER_TOKEN`, `EPIC_EG1`, `EPIC_SSO`, `EPIC_SESSION_AP`, `EPIC_SSO_RM`, and `remember_me` on `epicgames.com`.

- `EPIC_SSO` is the ~8 h web session.
- `EPIC_SSO_RM` keeps the account remembered for months. "Logged out but remembered" still allows claims, because the account picker can be completed automatically.

## Page signals (`epic-observation.js`)

- **Actions** – exact normalised button labels: Get (`get`, `get now`, `nhan`, `nhan ngay`), Add to library, Place order / Confirm order (English and Vietnamese).
- **Ownership** – `owned`, `in library`, `already purchased`, order-success phrases such as `thanks for your order`.
- **Price evidence** – currency-aware zero / non-zero detection per CTA or checkout region. Product regions let a crossed-out original price coexist with a current zero; checkout totals treat any non-zero amount as decisive.
- **Blockers** – CAPTCHA, terms acceptance, login wall, device compatibility, parental PIN, region lock, age verification.
- **Account picker** – `www.epicgames.com/id/login/switch-account` or "Welcome back" text; `classifyAccountPicker` returns `single`, `ambiguous`, `no_account`, `password`, or `none`.

When Epic changes labels or layout, update these lists and add a case to `tests/content-observer.test.js` or `tests/core.test.js`.
