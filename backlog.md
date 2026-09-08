# Backlog

Priority order below reflects an architecture review (2026-09-08): the current
`index.js` does `api.init()` → work → `api.shutdown()` on every sync, so
nothing is queryable between runs. The foundation items unlock the data
explorer/dashboard/email features safely; do them first.

## P0 — Foundation

### [REFACTOR] Split monolithic index.js into modules — DONE
Broke `index.js` into `src/config.js`, `src/logger.js`, `src/actualService.js`, `src/emailReport.js`, `src/syncJob.js`, `src/scheduler.js`, `src/auth.js`, `src/routes.js`; `index.js` is now a slim bootstrap. No behavior change.
Affected files: `index.js`, `src/*.js`

### [REFACTOR] Long-lived ActualDataService instead of init/shutdown per sync — DONE
`src/actualService.js` now initializes `@actual-app/api` once and keeps it open across sync cycles (re-initializing only if the Actual URL/syncId/password change), refreshing via `downloadBudget()` per sync instead of `init()`/`shutdown()` per run. `index.js` shuts it down on SIGTERM/SIGINT. This is the shared data-access foundation the data explorer, dashboard, and email templating below will build on.
Affected files: `src/actualService.js`, `src/syncJob.js`, `index.js`

### [BUG] No authentication on dashboard/API — DONE
Added session-cookie auth (`src/auth.js`, `src/routes.js`, `public/login.html`): dashboard password is scrypt-hashed and set on first login, sessions are signed with a per-install HMAC secret and expire after 7 days, and `requireAuth` middleware gates all routes except the login page/endpoints. `dashboardPasswordHash`/`sessionSecret` are excluded from the `/api/config` response.
Affected files: `src/auth.js`, `src/routes.js`, `src/config.js`, `index.js`, `public/login.html`, `public/index.html`

### [DEBT] Plaintext secrets in config.json — DONE (opt-in)
Added `src/secretCrypto.js`: when the operator sets a `CONFIG_ENCRYPTION_KEY` env var, `actualPassword` and `emailPass` are encrypted at rest (AES-256-GCM, key derived via scrypt) and transparently decrypted on read; `config.js` handles this in `getConfig`/`saveConfig` so no caller changes were needed. Without the env var, behavior is unchanged (plaintext) for backward compatibility with existing deployments — documented in the README and `docker-compose.yaml`.
Affected files: `src/secretCrypto.js`, `src/config.js`, `README.md`, `docker-compose.yaml`

## P1 — Data explorer UI — DONE
Added `public/explorer.html`: account balance cards, and a filterable (account/category/date range/payee search), paginated transactions table. Backed by new read-only endpoints in `src/routes.js` (`GET /api/data/accounts`, `/api/data/categories`, `/api/data/transactions`) built on new `actualService` query methods (`getCategories`, `queryTransactions`, `countTransactions`) using `@actual-app/api`'s query builder (`$gte`/`$lte`/`$like`/`$count`). Reused `api.getAccountBalance()` instead of the hand-rolled balance query the sync job had been using. Inspired by https://github.com/actualbudget/browser-app-demo, but server-side against the already-synced data instead of client-side WASM/IndexedDB. Protected by the same session auth as the rest of the dashboard (no new auth work needed).
Affected files: `src/actualService.js`, `src/routes.js`, `public/explorer.html`, `public/index.html`

### [FEATURE] CSV export from the data explorer — DONE
Added `GET /api/data/transactions/export` (same filters as the explorer, capped at 5,000 rows, no pagination) returning a CSV with proper quote/comma escaping, and an "Export CSV" button in `public/explorer.html` that carries the current filters into the download.
Affected files: `src/routes.js`, `public/explorer.html`

### [DEBT] Data explorer transaction count runs a separate query per request
`GET /api/data/transactions` issues both a paged query and a `$count` query against the same filters on every request. Fine at current scale; revisit if budgets with very large transaction histories make this noticeably slow.
Affected files: `src/actualService.js`, `src/routes.js`

## P2 — Templated, customizable dashboard — DONE
Added three dashboard widgets in `public/index.html` (Net Worth stat tile, Spend-by-Category bar chart, Balance Trend line chart for the last 30 days) rendered with Chart.js (loaded via CDN script tag, same pattern as the existing Tailwind CDN usage — no new npm dependency). Backed by a new `GET /api/data/summary` endpoint and three new `actualService` methods: `getNetWorth()`, `getSpendByCategory()`, and `getBalanceTrend()` (the last reconstructs a trend from daily transaction totals walked backward from the current balance, since Actual doesn't persist balance history). Widget visibility is a "Dashboard Widgets" checkbox group saved to `config.dashboardWidgets`, fulfilling the "customizable" part of this item.
Affected files: `src/actualService.js`, `src/routes.js`, `src/config.js`, `public/index.html`

## P3 — Customized email report templating — DONE
`src/emailReport.js` now takes a `sections` config (`config.emailSections.balances` / `.transactions`) and conditionally includes the balances table and/or the new-transactions list; the bank-connection-issue alert always shows regardless, since that's not something users should be able to silence. Added checkboxes for both sections in the Email Notifications block of `public/index.html`. Used `lodash`'s `_.escape()` for user-provided text (account/payee names) instead of adding a template engine — `lodash` is already a dependency and covers the escaping need, so no new dependency (e.g. Handlebars) was introduced.
Affected files: `src/emailReport.js`, `src/syncJob.js`, `src/config.js`, `public/index.html`
