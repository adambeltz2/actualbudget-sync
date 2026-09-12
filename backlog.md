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

## P4 — UI/UX polish
Found during a UI/UX pass over the dashboard/explorer built in P1-P3. Ordered by priority (correctness/safety first, cosmetic last).

### [BUG] Fetch errors are silently swallowed in the UI — DONE
Added a dismissable error banner (`#errorBanner`) to `index.html` and `explorer.html`; every fetch path (config, sync, dashboard summary, accounts/categories/transactions, the SSE log stream) now shows a message on failure instead of silently returning. The log-stream banner clears itself on reconnect rather than nagging on every transient EventSource retry.
Affected files: `public/index.html`, `public/explorer.html`

### [BUG] First-run dashboard password has no confirmation field — DONE
`login.html` now shows a "Confirm Password" field whenever `/api/auth/status` reports no password is configured yet, and blocks submission client-side if the two don't match.
Affected files: `public/login.html`

### [FEATURE] Mask the Actual Budget password field instead of showing plaintext — DONE
`GET /api/config` no longer returns `actualPassword`/`emailPass` at all — it returns `actualPasswordSet`/`emailPassSet` booleans instead. The form now shows a "•••••••• (unchanged)" placeholder and leaves the field blank; `POST /api/config` keeps the existing stored password when the field is submitted blank, only changing it when the user types a new value. (Also fixed `explorer.html`'s "not configured" check, which was reading the now-removed `config.actualPassword` field.)
Affected files: `src/routes.js`, `public/index.html`, `public/explorer.html`

### [BUG] Manual sync button resets after a fixed 2s regardless of actual completion — DONE
Added `GET /api/sync/status` (backed by the existing `syncJob.isSyncRunning()`). The sync buttons now disable themselves and poll this endpoint every 1.5s (capped at ~5 minutes) until the sync actually finishes, instead of guessing with a fixed timeout.
Affected files: `src/routes.js`, `public/index.html`

### [FEATURE] Sortable transaction columns and adjustable dashboard time range — DONE
Added a `sort` param (`date_desc`/`date_asc`/`amount_desc`/`amount_asc`) to `actualService.queryTransactions()` and both `/api/data/transactions` and `/api/data/transactions/export`, with a Sort dropdown in the explorer. Added a time-range dropdown (7/30/90/365 days) to the dashboard, driving the existing `?days=` param on `/api/data/summary`.
Affected files: `src/actualService.js`, `src/routes.js`, `public/explorer.html`, `public/index.html`

### [FEATURE] Move dashboard widget visibility controls next to the widgets — DONE
Added a "⚙ Customize" toggle in the Dashboard section header that reveals the widget-visibility checkboxes directly above the widgets; the config-form copy of the same checkboxes was removed in favor of this one (they're read by element ID on save regardless of DOM location, so moving them was a pure relocation, not a new state mechanism).
Affected files: `public/index.html`

### [FEATURE] Dark mode — DONE
Added a dark mode toggle (🌙/☀️ button) on all three pages using Tailwind's `class`-based dark mode strategy, with the preference saved to `localStorage` and falling back to `prefers-color-scheme` on first visit.
Affected files: `public/index.html`, `public/explorer.html`, `public/login.html`

## P5 — Test coverage & container health check

### [DEBT] No automated tests — DONE
Added a unit test layer under `test/` using Node's built-in `node:test`/`node:assert` (no new dependency) with 32 tests covering: `auth.js` (hash/verify, session sign/verify incl. tampered/expired/wrong-secret tokens, cookie parsing), `secretCrypto.js` (encrypt/decrypt round trip, idempotent re-encryption, no-op when `CONFIG_ENCRYPTION_KEY` is unset), `emailReport.js` (subject/section toggles, HTML escaping of user-provided text), and `actualService.js`'s transaction filter/sort building (exported for testability). Run via `npm test`. Route-level integration tests and anything requiring a live Actual Budget connection are still out of scope for this pass.
Affected files: `test/*.test.js`, `package.json`, `src/actualService.js`

### [FEATURE] Docker health check — DONE
Added an unauthenticated `GET /healthz` (mounted before the auth middleware in `index.js`) and a `HEALTHCHECK` instruction in the `Dockerfile` that probes it via Node's built-in `http` module — no `curl`/`wget` dependency needed in the slim image.
Affected files: `index.js`, `Dockerfile`

### [FEATURE] Run tests on every PR — DONE
The repo's only workflow (`publish.yml`) builds/publishes on push to `main`; nothing checked pull requests before merge. Added `.github/workflows/test.yml` running `npm test` on every pull request (plus pushes to `main`, matching `publish.yml`'s trigger) on Node 20 to match the Docker image.
Affected files: `.github/workflows/test.yml`

## P6 — Multiple email recipients

### [FEATURE] Support sending the sync report to multiple recipients — DONE
`emailTo` already reached nodemailer as a raw string, and nodemailer accepts a comma-separated `to` natively, but the field was `type="email"` without the `multiple` attribute — browsers reject a comma-containing value against that constraint, silently blocking the save. Added the `multiple` attribute (native per-address validation now works correctly for a list) and a `parseRecipients()` helper in `emailReport.js` that splits on comma or semicolon, trims whitespace, drops empty entries, and de-duplicates before handing the list to nodemailer. Documented the format with a `title` tooltip on the field ("Separate multiple addresses with commas, e.g. alice@example.com, bob@example.com") and matching helper text beneath it, following the same pattern as the rest of the form.
Affected files: `src/emailReport.js`, `public/index.html`, `test/emailReport.test.js`
