# Backlog

Priority order below reflects an architecture review (2026-09-08): the current
`index.js` does `api.init()` → work → `api.shutdown()` on every sync, so
nothing is queryable between runs. The foundation items unlock the data
explorer/dashboard/email features safely; do them first.

## P0 — Foundation

### [REFACTOR] Split monolithic index.js into modules
Break `index.js` (config I/O, Express routes, cron, sync logic, email HTML) into `config.js`, `actualService.js`, `syncJob.js`, `emailReport.js`, `routes/`, `server.js`. Mechanical, no behavior change; de-risks all following work.
Affected files: `index.js` (split into new files)

### [REFACTOR] Long-lived ActualDataService instead of init/shutdown per sync
Replace the per-sync `api.init()` / `api.shutdown()` lifecycle with a service that initializes once, refreshes via `downloadBudget()` on schedule/demand, and exposes query methods (accounts, categories, transactions, balances). This is the shared data-access foundation the data explorer, dashboard, and email templating below depend on — no separate replication layer needed.
Affected files: `index.js`

### [DEBT] Plaintext secrets in config.json
`actualPassword` and `emailPass` (SMTP app password) are stored unencrypted in `/data/config.json`, readable by anything with host/container filesystem access. Consider encrypting at rest with a key derived from an env-provided secret, or documenting the risk clearly if left as-is.
Affected files: `index.js`

### [BUG] No authentication on dashboard/API
`/api/config`, `/api/sync`, and the dashboard UI have no auth — anyone with network access to port 3000 can read the config (incl. secrets), change settings, or trigger syncs. Needs at minimum a shared-password/session gate before the data explorer or dashboard (which expose real financial data) ship.
Affected files: `index.js`, `public/index.html`

## P1 — Data explorer UI
Add a searchable/filterable table view (accounts, categories, transactions) in the web dashboard, backed by new read-only `GET` endpoints wrapping the `ActualDataService` query methods. Inspired by https://github.com/actualbudget/browser-app-demo, but server-side against already-synced data instead of client-side WASM/IndexedDB.
Affected files: `index.js`, `public/index.html`

## P2 — Templated, customizable dashboard
Add reusable dashboard widgets (net worth, spend-by-category, balance trend) rendered with a lightweight charting library, with a simple layout/template config so users can choose which widgets are shown. Depends on the data explorer's read-only endpoints.
Affected files: `index.js`, `public/index.html`

## P3 — Customized email report templating
Replace the current fixed "new transactions" email with a template engine (e.g. Handlebars) so users can choose which sections/formatting appear in the sync report email, driven by the same underlying synced data. Can share the "report definition" concept with the dashboard's widget selection.
Affected files: `index.js`
