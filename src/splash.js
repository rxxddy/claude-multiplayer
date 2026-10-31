// Boot splash status ticker (kept out of index.html so the strict CSP can forbid inline scripts)
const lines = ['initializing', 'loading local telemetry', 'scanning git repositories', 'linking servers', 'syncing operators'];
const el = document.getElementById('sp-status');
let i = 0;
window.__splashTimer = setInterval(() => {
  i = (i + 1) % lines.length;
  if (el) el.textContent = lines[i];
}, 520);
