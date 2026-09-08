# Backlog

## [FEATURE] Local data replication layer for querying synced budget data
Maintain a queryable local copy of budget data (accounts, categories, transactions) pulled via `@actual-app/api` into the existing `./data` cache, kept fresh alongside the existing sync cron. This is the shared data-access foundation for the data explorer, templated dashboard, and customized email features below.
Affected files: `index.js`

## [FEATURE] Data explorer UI
Add a searchable/filterable table view (accounts, categories, transactions) in the web dashboard, backed by new read-only `GET` endpoints wrapping `api.getAccounts()` / `api.getTransactions()` / etc. against the local data cache. Inspired by https://github.com/actualbudget/browser-app-demo, but server-side against already-synced data instead of client-side WASM/IndexedDB.
Affected files: `index.js`, `public/index.html`

## [FEATURE] Templated, customizable dashboard
Add reusable dashboard widgets (net worth, spend-by-category, balance trend) rendered with a lightweight charting library, with a simple layout/template config so users can choose which widgets are shown. Depends on the data explorer's read-only endpoints.
Affected files: `index.js`, `public/index.html`

## [FEATURE] Customized email report templating
Replace the current fixed "new transactions" email with a template engine (e.g. Handlebars) so users can choose which sections/formatting appear in the sync report email, driven by the same underlying synced data.
Affected files: `index.js`
