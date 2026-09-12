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

## P15 — Verifiable version + dashboard layout — DONE

### [FEATURE] Version footer now shows the actual build (git commit), not just a static number — DONE
User confirmed the chart fix worked, but flagged the version footer as unreliable for checking whether they'd actually pulled the latest image — `package.json`'s version had never been bumped across any release, so it always read "v1.0.0" regardless of which build was running (which is exactly why they couldn't self-diagnose "am I on the old image?" before asking). Fixed by baking the git commit SHA into the Docker image at build time: `publish.yml` now passes `build-args: GIT_COMMIT=${{ github.sha }}` to `docker/build-push-action`, the `Dockerfile` accepts it (`ARG GIT_COMMIT=""` / `ENV GIT_COMMIT=$GIT_COMMIT`, empty by default for a local build with no build-arg), and `GET /api/version` returns a 7-char short SHA alongside the version when present. The footer on all three pages now renders e.g. "v1.0.0 (343b577)" — a value that changes on every real release, so a user can directly compare it against the latest commit on GitHub's main branch.
Affected files: `.github/workflows/publish.yml`, `Dockerfile`, `src/routes.js`, `public/index.html`, `public/explorer.html`, `public/login.html`

### [BUG] Accounts widget dominated the dashboard's 3-column row — FIXED
With a real-scale account list (30+ accounts), the Accounts card's height dwarfed Spend by Category and Balance Trend in the same `grid-3` row, stretching the whole row and leaving both chart cards floating in a mostly-empty column. Pulled Accounts out into its own full-width card above, rendered as a compact multi-column tile grid (matching the Data Explorer's account-card style) with a `max-height` + scroll instead of one unbounded vertical list, and reflowed Spend by Category + Balance Trend into a 2-up row sized to their own natural height. Added a `title` attribute on each account tile's name so a truncated long name is still readable on hover. Verified responsive: at 400px width the tile grid collapses to one column with no horizontal scroll.
Affected files: `public/index.html`

## P16 — Docker image optimization — DONE

### [DEBT] Final image shipped an unnecessary native-build toolchain — FIXED
User asked directly whether the Docker image was optimized; it wasn't. `@actual-app/api` depends on `better-sqlite3`, whose install script tries `prebuild-install` first (fetches a prebuilt native binary for the platform) and only falls back to compiling from source — needing `python3`/`build-essential`/`node-gyp` — when no prebuilt binary matches. The single-stage Dockerfile installed that whole fallback toolchain unconditionally and then shipped it in the final image forever, even on the (common) path where `prebuild-install` succeeds and none of it is ever used at runtime. Converted to a two-stage build: a `deps` stage installs dependencies (with the build toolchain available in case the fallback is ever needed), and the final runtime stage copies over only the resulting `node_modules` — the compiler toolchain and apt cache from the deps stage are discarded entirely rather than shipped.
Since this sandbox has no Docker daemon access (verified: `docker info` and `docker buildx build --check` both fail to reach `/var/run/docker.sock`), the change couldn't be build-tested locally. Added a `docker-build` job to `test.yml` (build-only, `push: false`) so every PR now actually builds the image via GitHub Actions before merge — previously only `publish.yml` built it, and only *after* a push to `main`, so a broken Dockerfile would have gone unnoticed until it was already live.
Affected files: `Dockerfile`, `.github/workflows/test.yml`

## P17 — Dashboard time window: calendar months, not rolling days — DONE

### [FEATURE] Replace "Last N days" dropdown with a calendar-month picker — DONE
User feedback: budgets live in monthly buckets (like Actual's own budget-month model), not rolling day windows — "Last 30 days" as a lens on Spend by Category / Balance Trend didn't match how anyone actually thinks about their spending. Replaced the dashboard's `summaryDays` dropdown ("Last 7/30/90 days", "Last year") with a `summaryMonth` picker offering **This Month** and **Last Month**, and rewrote the affected backend functions around calendar-month bounds instead of a day count:
- `actualService.monthDateRange(month)` (new, exported for testing): resolves a `"YYYY-MM"` string to its calendar start/end dates, clamped to today when the month is the current one (so "This Month" never reaches into the future).
- `getSpendByCategory({ month })` and `getBalanceTrend({ month })` rewritten around this — `getBalanceTrend` now correctly re-anchors net worth to the *end of the requested month* (by subtracting everything that happened after it from today's real net worth) before walking the month's own daily transaction totals, rather than always assuming the window ends today. Verified end-to-end against a stubbed `@actual-app/api` for both "This Month" and "Last Month", confirming the cross-month balance math resolves correctly (`currentNetWorth = netWorthAtLastMonthEnd + laterSpend`).
- `getMonthlyBalanceHistory` (used by Financial Insights, which needs a continuous multi-month series, not a single calendar month) kept its old rolling-window logic as a private `getDailyBalanceHistoryForDays` helper rather than being broken by the `getBalanceTrend` signature change.
- `/api/data/summary` now also passes the selected month through to `getIncomeVsSpend`/`getBudgetVsActual` (which already accepted a `month` param, previously just never wired to the selector) — so "This Month"/"Last Month" now applies consistently across every summary widget, not just the two that used to key off `days`.
- Dashboard headers ("Income vs Spend · This Month", "Spend by Category · This Month", etc.) now update dynamically based on the selected month, including a proper month/year label (e.g. "August 2026") if a month were ever added beyond the two current options.
Affected files: `src/actualService.js`, `src/routes.js`, `public/index.html`, `test/actualService.test.js`

## P18 — Follow-ups from Docker/optimization review (2026-09-12)

### [DEBT] `@actual-app/api` pinned to `"latest"`, no committed lockfile — DONE
Root cause pattern behind two bugs found this session (the payee-name query-shape assumption, and the general fragility of relying on this SDK's exact query behavior): `package.json` pinned `@actual-app/api` to `"latest"`, and `.gitignore` excluded `package-lock.json` entirely, so every `npm install` (in Docker builds, in CI) could silently resolve a different version with different query behavior — with no lockfile to catch the drift or roll back from. Pinned to the exact version already verified working (`26.9.0`) and committed `package-lock.json` so builds are reproducible; a future upstream change now shows up as a visible diff instead of a silent behavior change discovered via a user's screenshot.
Affected files: `package.json`, `package-lock.json` (new), `.gitignore`

### [BUG] Suspected: Data Explorer's payee search filter may not work — OPEN, needs live verification
`buildTransactionFilters`'s search filter does `.filter({ payee_name: { $like: ... } })`, but a search of `@actual-app/api@26.9.0`'s bundled source turns up no evidence `payee_name` (unqualified) is a registered field in the query engine's schema — only the raw `payee` id and a dot-path `payee.name` used elsewhere (Actual's own CSV export). This is the same class of issue as the payee-name display bug already fixed, just on the filter side: the search box may silently return zero results, or the filter may simply be ignored. Not fixed yet because it can't be verified without a live Actual server — next step is to try searching a payee name in the Data Explorer and report what actually happens (all results / no results / an error).
Affected files (if confirmed): `src/actualService.js` (`buildTransactionFilters`)

### [DEBT] CI builds the Docker image but never runs it — OPEN
The `docker-build` CI job (added alongside the multi-stage Dockerfile optimization) confirms the image builds successfully, but doesn't confirm the resulting container actually boots and serves traffic. A smoke-test step (start the built image, curl `/healthz`, fail the job if it doesn't return 200 within a few seconds) would close that gap.
Affected files: `.github/workflows/test.yml`

## P19 — Financial Health Check — DONE

### [FEATURE] "Financial advisor" view: emergency fund, savings rate, debt load score — DONE
Requested directly by the user ("view our finances as if they were a financial advisor"). Sketched as an interactive Artifact mockup and approved before building. Actual Budget's data model has no checking/savings/investment/credit account-type field — only name, balance, `offbudget`, and `closed` — so which accounts count as liquid emergency savings can't be inferred automatically; the user confirmed manual account tagging (in this app) as the approach.
Added `src/financialHealth.js`: pure, dependency-free scoring (`computeEmergencyFund` — months of coverage vs. a target; `computeSavingsRate` — % of income saved vs. a target; `computeDebtLoad` — total debt expressed as months of income, since Actual only has balances, not monthly payment amounts; `computeOverallScore` — a weighted 0-100 score, 40/40/20; `buildRecommendations` — strictly rule-based, threshold-driven messages, deliberately not LLM-generated text, so every recommendation is auditable back to a specific check). `actualService.getFinancialHealthData()` sums the manually-tagged `emergencyFundAccountIds` for liquid balance, uses a 3-month trailing average (excluding the current, possibly-partial month) of income/spend/debt for the ratios, and feeds it all through the scoring module. New config fields: `emergencyFundAccountIds` (array, default empty), `financialHealthTargetMonths` (default 6), `financialHealthTargetSavingsPct` (default 20). New `GET /api/data/financial-health` route.
The dashboard gained a "Financial Health Check" widget (score ring + label, three stat tiles with progress bars and good/watch/action pills for emergency fund/savings rate/debt load, a recommendations list, and a footnote noting the debt figure is a balance-based approximation) with live-editable target selectors, and a new "Emergency Fund Accounts" settings card — a checklist of every account (with balance) for tagging which ones count as liquid savings. Verified via unit tests (20 new, 120/120 total) and a Playwright pass against mocked API routes confirming widget rendering, pill/score/recommendation correctness, the settings checklist reflecting saved tags, and a live refetch on target change, with zero console/page errors.
Affected files: `src/financialHealth.js` (new), `src/actualService.js`, `src/config.js`, `src/routes.js`, `public/index.html`, `test/financialHealth.test.js` (new)

### [FEATURE] Net Worth Breakdown (manual investment account tagging) — DONE
Follow-up: user asked whether investment accounts get the same manual-tagging treatment as emergency fund accounts, having assumed Actual classified investment accounts natively — confirmed via a direct read of `@actual-app/api`'s bundled schema and `getAccounts()` query (`SELECT a.*` against the `accounts` table) that it doesn't: the only fields are `id`/`name`/`offbudget`/`closed`/`sort_order`/`tombstone`/`account_id`/`official_name`/`account_sync_source`, no type enum. Added a second manual checklist, "Investment Accounts" (mirroring Emergency Fund Accounts' UI/UX), with mutual exclusivity enforced client-side — tagging an account as investment untags it from emergency fund and vice versa, since a given account can't be both. New config field `investmentAccountIds` (array, default empty). Added `computeNetWorthBreakdown({ netWorth, investmentBalance, debtTotal })` to `src/financialHealth.js` (pure, unit-tested — clamps investment/liquid to non-negative for display, and the identity `liquid + investment - debt = netWorth` always holds) and wired it into `getFinancialHealthData()`, which now also computes `netWorth` (sum of all account balances) and `investmentBalance` (sum of tagged accounts). The Financial Health Check widget gained a "Net Worth Breakdown" section: a big net-worth number, a proportional three-segment stacked bar (liquid/investment/debt), and a color-coded legend with dollar values per segment. Verified via 4 new unit tests and a Playwright pass confirming correct values, proportional bar widths, and the mutual-exclusivity behavior, with zero console errors.
Affected files: `src/financialHealth.js`, `src/actualService.js`, `src/config.js`, `src/routes.js`, `public/index.html`, `test/financialHealth.test.js`
