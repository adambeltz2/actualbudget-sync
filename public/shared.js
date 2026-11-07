// Shared boilerplate for every public/*.html dashboard page (not
// login.html, which has none of this): dark-mode theme toggle (persisted
// in localStorage), the error banner show/hide helpers, the footer
// version fetch, and the logout button handler. Every element this
// touches (#themeToggleBtn, #errorBanner, #appVersion, #logoutBtn) is
// looked up defensively -- a page that doesn't have one (wrapped.html has
// no error banner, version footer, or logout button) just skips that
// part rather than throwing.
//
// No build step or bundler in this app, so a plain shared <script> include
// is the right level of tooling for this -- not a module system. Include
// it near the top of a page's own <script> block, after the DOM elements
// above exist: <script src="/shared.js"></script>.
//
// A page whose theme toggle needs to do more than flip the CSS class --
// e.g. a Chart.js page re-rendering its canvases, since canvas colors are
// resolved at draw time and don't follow a live CSS variable -- can set
// window.onThemeChange = (isDark) => { ... } before this script runs (or
// any time after), and it's called on every toggle.
(function () {
  function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.innerText = isDark ? '☀️' : '🌙';
  }

  try {
    const stored = localStorage.getItem('theme');
    applyTheme(stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) { /* localStorage may be unavailable (private mode); default light theme is fine */ }

  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const isDark = !document.documentElement.classList.contains('dark');
      applyTheme(isDark);
      try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
      if (typeof window.onThemeChange === 'function') window.onThemeChange(isDark);
    });
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }

  fetch('/api/version').then(r => r.json()).then(({ version, commit }) => {
    const el = document.getElementById('appVersion');
    if (el) el.innerText = version ? `v${version}${commit ? ` (${commit})` : ''}` : '';
  }).catch(() => {});

  window.showError = function (message) {
    const el = document.getElementById('errorBanner');
    if (el) { el.innerText = message; el.hidden = false; }
  };
  window.hideError = function () {
    const el = document.getElementById('errorBanner');
    if (el) el.hidden = true;
  };
})();
