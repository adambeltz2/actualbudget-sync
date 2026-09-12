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

## P7 — Mint-style redesign

### [FEATURE] Mint.com-inspired dashboard and email redesign — DONE
Full visual redesign of `index.html`, `explorer.html`, and `login.html` around a shared design system (muted off-white/dark backgrounds, teal accent, "Sora" + "Source Sans 3" fonts, card+shadow style) prototyped first as a design canvas mockup and approved before implementation. The dashboard's Net Worth widget was replaced with:
- **Income vs Spend (this month)** — big Income/Spend numbers plus a net-saved delta, backed by `actualService.getIncomeVsSpend()` using `@actual-app/api`'s `getBudgetMonth()` (`totalIncome`/`totalSpent`), no custom transaction aggregation needed.
- **Income vs Spend · Year to Date** — a compact secondary card summing every available budget month from January through the current month, via `actualService.getIncomeVsSpendYTD()`.
- **Spend by Category** — converted from a bar chart to a donut (Chart.js `doughnut`) with a center total and a color-coded legend.
- **Balance Trend** — same data as before, restyled as an axis-free sparkline with a soft area fill.
- **Spend vs Budget** — a new widget: one consumption bar per category (filled to `min(spent/budgeted, 100%)`, teal when on track, red and capped at 100% when over budget, with a "$X remaining" or "-$X over" label), backed by `actualService.getBudgetVsActual()` using `getBudgetMonth()`'s per-category `budgeted`/`spent` fields. `summarizeBudgetCategory()` is exported as a pure, unit-tested helper for the percentage/remaining/over-budget math.
- **Accounts** — restyled as a colored-dot list within a card (unchanged data source).

The sync email got the same "Spend vs Budget" section (compact bars, capped to 6 categories) and a "Total Balance" headline replacing the old plain balances table; existing account/transaction content was restyled to match (colored dots, muted category subtitles) rather than removed. Added an optional `config.publicUrl` ("Dashboard URL") field that, when set, renders a "View Full Report" button in the email linking back to the user's own dashboard.
`dashboardWidgets` and `emailSections` gained matching new toggle keys (`incomeVsSpend`, `incomeVsSpendYTD`, `budgetVsActual`); `netWorth` was dropped from the defaults for new installs (existing installs are unaffected since the frontend already treats a missing key as "shown," per the `!== false` convention established when these toggles were first built).
Verified via `npm test` (46/46, including new `summarizeBudgetCategory` and `emailReport` budget-section tests) and, since this environment can't reach a live Actual Budget server, via Playwright driving a real headless browser against the app with the Actual/Chart.js-dependent endpoints mocked — confirming zero console/page errors and correct rendering across light and dark mode on all three pages.
Affected files: `src/actualService.js`, `src/routes.js`, `src/config.js`, `src/syncJob.js`, `src/emailReport.js`, `public/index.html`, `public/explorer.html`, `public/login.html`, `test/actualService.test.js`, `test/emailReport.test.js`

## P8 — Product review findings (2026-09-12)

Grouped by technical dependency, not by how they were raised. Merge after each group.

### Group 1 — Security & sync health — DONE
Foundational and low-risk; shipped first.

#### [BUG] No brute-force protection on login — DONE
Added in-memory rate limiting in `src/auth.js` keyed by client IP (`isLoginLocked`/`recordLoginFailure`/`recordLoginSuccess`): 5 failed attempts within 15 minutes locks that IP out for 15 minutes, returning `429` with a "try again in N minutes" message; a successful login clears the counter. `index.js` now sets `trust proxy` so the real client IP is used behind a reverse proxy (Pikapod, nginx) rather than the proxy's own address. State is in-memory and resets on restart — the goal is slowing an automated guesser, not surviving a restart.
Affected files: `src/auth.js`, `src/routes.js`, `index.js`, `test/auth.test.js`

#### [FEATURE] Surface last sync status on the dashboard — DONE
`syncJob.js` now records `lastSyncAt`/`lastSyncStatus` (`success`/`warning`/`error`)/`lastSyncError` to config after every sync (re-reading config immediately before the write so a settings change made mid-sync isn't clobbered); a bank-connection issue that doesn't throw is recorded as `warning` rather than a silent `success`. The dashboard shows a colored pill next to the "Dashboard" heading ("✓ Synced 2 hours ago" / "⚠ Synced with a warning..." / "✕ Sync failed..."), with the error detail in its hover tooltip, and refreshes automatically after a manual sync completes.
Affected files: `src/syncJob.js`, `src/config.js`, `src/routes.js`, `public/index.html`

### Group 2 — Setup UX & data safety — DONE

#### [FEATURE] "Test Connection" button before saving — DONE
Added `actualService.testConnection()` (reuses `ensureReady()` + `getAccounts()` — a failed test only tears down the shared session temporarily, since the next real call re-initializes from the saved config's own fingerprint) and `POST /api/config/test-connection`. The Actual Budget Configuration card has a "Test Connection" button that posts the current form values (falling back to the saved password when the field is left blank, same masked-password convention as Save) and shows "✓ Connected — found N accounts" or the actual error inline, without saving anything.
Affected files: `src/actualService.js`, `src/routes.js`, `public/index.html`

#### [FEATURE] Config export/import (backup/restore) — DONE
Added `GET /api/config/export` (downloads the full decrypted config as JSON — a backup the user stores themselves, clearly labeled as containing plaintext credentials) and `POST /api/config/import` (validates the upload is a plain object, then replaces the config wholesale and reschedules the cron job). A "Backup & Restore" card provides Export/Import buttons; import asks for confirmation before overwriting and reloads the page afterward.
Affected files: `src/routes.js`, `public/index.html`

### Group 3 — Access & notifications — DONE

#### [FEATURE] Shareable read-only access — DONE
Sessions now carry a role (`admin`/`viewer`) embedded and signed in the session token itself (`signSession`/`verifySession` in `src/auth.js`), so a viewer token can't be reinterpreted as admin even if the admin password later changes. A separate `viewerPasswordHash` in config is set/cleared via `POST /api/auth/viewer-password` (admin-only), and login checks it as a fallback after the admin password. `requireAdmin` middleware gates every state-changing or secret-exposing route (`POST /api/config`, `/api/config/test-connection`, `/api/config/test-webhook`, `GET/POST /api/config/export|import`, `POST /api/sync`, `POST /api/auth/viewer-password`); the read-only data-explorer/dashboard-summary routes stay open to both roles, matching the intent of "visibility without edit access." Disabling viewer access immediately revokes any already-issued viewer session (`requireAuth` re-checks `viewerPasswordHash` on every request) rather than waiting for the 7-day token to expire. The dashboard hides the entire settings form, "Trigger Manual Sync", and "Customize" behind `config.role === 'viewer'` and shows a "Read-only access" badge instead; a new "Access & Sharing" card lets the admin set/update/disable the viewer password. `public/explorer.html` needed no changes — it was already fully read-only.
Affected files: `src/auth.js`, `src/config.js`, `src/routes.js`, `public/index.html`, `test/auth.test.js`

#### [FEATURE] Alternative notification channels (Discord/Slack webhook) — DONE
Added `src/webhookReport.js` (`buildWebhookPayload`/`sendWebhookReport`, using Node's built-in global `fetch` — no new dependency) supporting Discord embeds, Slack blocks, or a flat "generic" JSON body for other automations. New config fields `webhookEnabled`/`webhookPlatform`/`webhookUrl` (the URL is treated as a bearer credential and added to `SECRET_FIELDS` for at-rest encryption alongside the existing passwords). Wired into `syncJob.js` right after the email send, gated on the same "was there anything to report" condition, with its own try/catch so a webhook failure never fails the sync. A "Webhook Notifications" card (mirroring the Email card's toggle/masked-URL conventions) includes a "Send Test Message" button backed by `POST /api/config/test-webhook`.
Affected files: `src/config.js`, `src/syncJob.js`, `src/routes.js`, `src/webhookReport.js`, `public/index.html`, `test/webhookReport.test.js`

## P9 — Financial Insights (guided projections) — DONE

### [FEATURE] Spending trend detection and balance/net-worth projections — DONE
Requested directly by the user ("as if you were a financial advisor... last 6 months we've seen an increase in grocery spending... based on current investments we should see a total account balance of X in 10 years"). Added `src/insights.js`: pure, dependency-free math (unit-tested in isolation from `@actual-app/api`) — `linearRegression` (ordinary least squares over month-indexed points), `projectFutureValue` (future value of a lump sum plus a recurring monthly contribution, compounded monthly — falls back to simple addition at a 0% rate rather than dividing by zero), `classifySpendTrend`/`buildSpendingInsights` (compares the first half vs. second half of a category's monthly spend to flag sustained moves ≥15% across at least 4 months, avoiding false positives from one noisy month), and `buildBalanceProjection` (regresses monthly balance history for a real "average monthly net change" figure, then projects 1/5/10 years both as a straight-line continuation of that pace and as compound growth at a user-selectable assumed annual return rate).
`src/actualService.js` adds `getCategorySpendTrend` (one grouped query per of the last N months — the query builder doesn't support a clean two-key groupBy), `getMonthlyBalanceHistory` (resamples the existing daily `getBalanceTrend` series to one point per calendar month), and `getFinancialInsights` combining both into `{ spendingTrends, balanceProjection }`. New `GET /api/data/insights` route (read-only, open to both admin and viewer roles like the rest of the data explorer). A "Financial Insights" dashboard widget shows the trend sentences (colored up/down like the example in the request) and a Balance Projection table ("if current pace continues" vs. "invested at assumed return"), with an inline 0%/4%/7%/10% return-rate selector for quick what-ifs (persisted as `config.insightsAnnualReturnPct` on next save) plus an explicit "not financial advice" disclaimer given the nature of the projections.
Affected files: `src/insights.js`, `src/actualService.js`, `src/config.js`, `src/routes.js`, `public/index.html`, `test/insights.test.js`

### [FEATURE] Wealthfront/Personal Capital-style projection visuals — DONE
Follow-up on user feedback to take inspiration from investment-tracking tools. `buildBalanceProjection` now also computes `monthlyVolatility` (population standard deviation of month-to-month balance changes) and derives a `trendLow`/`trendHigh` "typical range" band around the trend-continuation line for every horizon — the band widens with `sqrt(months)`, the same way a random walk's uncertainty grows over time, rather than staying a fixed width regardless of how far out the projection goes. It also returns a `chartSeries` (yearly resolution, 0..`chartHorizonYears`) and the raw `history` array for charting. `buildSpendingInsights` now includes each category's `monthlyTotals` so the dashboard can draw a small trend sparkline next to each alert (Personal Capital's cash-flow view). The dashboard widget gained: a Personal-Capital-style headline "Projected Balance · 10 Years" big number; a Wealthfront-style projection line chart (real Chart.js line chart — history solid, current-pace trend dashed with a shaded typical-range band via two hidden-border datasets and `fill: '-1'`, invested-at-rate solid in the accent color) with history and future joined at "today" so there's no visual gap; and inline hand-rolled SVG sparklines per spending-trend row (one Chart.js instance per row for what could be a dozen categories seemed like the wrong tool for a 6-point line). The projection table's "if current pace continues" column now also shows the typical range beneath the point estimate instead of a single potentially-overconfident number.
Affected files: `src/insights.js`, `public/index.html`, `test/insights.test.js`

## P10 — Footer: version, GitHub, Buy Me a Coffee — DONE

### [FEATURE] App version + project links footer — DONE
Added `GET /api/version` (public, reads `package.json`'s `version` field so it never drifts out of sync with a release) and a small footer on all three pages (`index.html`, `explorer.html`, `login.html`) showing "Actual Budget Smart Sync v{version}" plus links to the GitHub repo and to Buy Me a Coffee, both `target="_blank" rel="noopener"` per house convention for external links. `/api/version` is listed in `auth.js`'s `PUBLIC_PATHS` so the version shows on the login page too, before any session exists.
Affected files: `src/routes.js`, `src/auth.js`, `public/index.html`, `public/explorer.html`, `public/login.html`

## P11 — Email report section order — DONE

### [FEATURE] Reorder email sections: new transactions, account status, budget, balances — DONE
Requested directly by the user. `buildReportHtml` now renders sections in the order: New Transactions (a headline count, always shown when the section is enabled, even at 0 — followed by the grouped list only when there are any), Account Status (the connection-issue alert, renamed from "Action Required" to "Account Status: Action Required" and still always shown regardless of section toggles, per its original design intent), Spend vs Budget, then Total Balance/Accounts. Previously balances led and transactions trailed. No section's own content or toggle behavior changed, only the order they're emitted in.
Affected files: `src/emailReport.js`, `test/emailReport.test.js`

## P12 — Bug: Payee always shows "Unknown" — DONE

### [BUG] Payee name never resolved (Data Explorer, CSV export, email report) — FIXED
User reported missing categories on the dashboard; investigation via the Data Explorer screenshot showed the categories dropdown and many transaction rows *did* have correct category names, ruling out a category-fetching regression — but every single row showed "Unknown" for Payee, which was the real, confirmed bug. Root cause: in the installed `@actual-app/api@26.9.0`, the transactions view/query schema does not include `payee_name` from a bare `select('*')` or `api.getTransactions()` — only the raw `payee` id. Actual's own codebase resolves this the same way this app already resolves category/account names: a separate `getPayees()` lookup. Added `actualService.getPayees()` and a pure, unit-tested `resolvePayeeNames(transactions, payees)` helper; wired into `queryTransactions` (Data Explorer + CSV export, which both consume it) and into `syncJob.js` (resolved once on the `added` diff array, so the email report and webhook payload get real payee names too, without refetching payees per account in the diffing loop). The originally-reported "missing categories" symptom on the Spend by Category dashboard widget is still open — category data itself checks out, so that one looks like a separate, frontend-side issue (likely a Chart.js runtime error on the live deployment) still being diagnosed with the user.
Affected files: `src/actualService.js`, `src/syncJob.js`, `test/actualService.test.js`

## P13 — Bug: CSV export silently capped at 5,000 rows — DONE

### [BUG] CSV export truncated to a hardcoded 5,000-row limit — FIXED
User reported their CSV export was missing rows: `queryTransactions` was called with a hardcoded `limit: 5000` in the export route, so any account with more matching transactions than that (theirs had 6,530+) silently lost the rest with no warning. Added `actualService.queryAllTransactions(filterArgs, { sort, pageSize, maxRows })`, which pages through the query in batches (default 1,000/page) until a short page confirms there's nothing left, rather than a single arbitrarily-sized limit — so it keeps working correctly regardless of how large a budget's transaction history grows. `maxRows` (default 100,000) is a sanity backstop against a runaway loop, not a real-world ceiling. The CSV export route now calls this instead of `queryTransactions` with a magic number. Tested against a stubbed `@actual-app/api` (module-mocked, since this exercises the actual pagination loop rather than a pure helper) confirming a 6,530-row dataset comes back complete across 7 pages, and that payee names resolve correctly across every page, not just the first.
Affected files: `src/actualService.js`, `src/routes.js`, `test/actualServicePagination.test.js`

## P14 — Root cause found: dashboard charts blank on restrictive networks — DONE

### [BUG] Chart.js loaded from an external CDN, breaking (and cascading) on blocked networks — FIXED
Root cause of the original "missing categories" report. The user's browser console showed `cdnjs.cloudflare.com/.../chart.umd.min.js` being blocked (MIME-type mismatch — something on their network returned an HTML page instead of the script), leaving `Chart` undefined. Two separate problems from that one root cause:
1. **Vendored the dependency**: a self-hosted, "remote-server-friendly" app shouldn't require every viewer's browser to reach an external CDN at runtime — corporate firewalls, ad blockers, DNS filtering, and offline/restrictive networks routinely block exactly this. Installed `chart.js@4.4.4` via npm (matching the previously-pinned CDN version), copied its UMD build to `public/vendor/chart.umd.js` (committed to the repo, served as a static asset — not a runtime npm dependency, since it's never `require()`'d from Node), and pointed `index.html`'s script tag at `/vendor/chart.umd.js` instead of cdnjs.
2. **Fixed the cascading failure**: `Chart` being undefined threw inside the Spend by Category widget's synchronous render code, and because nothing caught it, `loadDashboardWidgets` aborted entirely — silently blanking every widget that came after it (Balance Trend, Spend vs Budget, Financial Insights), not just the one that actually depended on the missing library. Wrapped each dashboard widget's render in its own try/catch (`safeRenderWidget`) so one widget's failure is isolated and logged to the console instead of taking down the rest of the dashboard. Also reordered each chart-widget's `hidden = false` to only happen after the chart is built successfully, so a failed widget cleanly disappears instead of showing an empty card with just a header (the exact visual from the original bug report).
Verified end-to-end with Playwright: real local Chart.js renders correctly (canvas actually draws), and a simulated block of `/vendor/chart.umd.js` (returning HTML, reproducing the exact console error from the report) now leaves only the genuinely chart-dependent widgets hidden while Income vs Spend, Spend vs Budget, and the rest of the Financial Insights widget's non-chart content all still render.
Affected files: `public/index.html`, `public/vendor/chart.umd.js` (new, vendored)
