'use strict';

// This small document is fetched to the router's hotspot/login.html. It must
// work in restricted captive-network browsers with no third-party assets.
const ROUTER_LOGIN_TEMPLATE_VERSION = 'v2';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderRouterLoginPage({ title, portalUrl }) {
  const url = String(portalUrl || '');
  if (!/^https:\/\/[^\s/]+(?:\/|\?|$)/i.test(url)) {
    throw new Error('Captive portal redirect must use an HTTPS URL');
  }
  const href = escapeHtml(url);
  // Escape HTML-significant characters in a JavaScript string, rather than
  // HTML-escaping inside <script>. Keep RouterOS $(...) macros untouched so
  // the router can substitute the visiting customer's MAC and login URL.
  const jsUrl = JSON.stringify(url)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title || 'Wi-Fi Fiti')} - Wi-Fi packages</title>
<script>try{window.location.replace(${jsUrl});}catch(_){}</script>
<meta http-equiv="refresh" content="1;url=${href}">
<style>
body{font:16px system-ui,-apple-system,Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7fb;color:#182438;text-align:center}
main{padding:24px;max-width:360px}a{display:block;margin:20px auto 0;padding:14px 24px;background:#1965d7;color:white;border-radius:10px;text-decoration:none;font-weight:700}
</style>
</head>
<body><main>
<p>Opening Wi-Fi packages...</p>
<a href="${href}">Open packages</a>
<p>If the page does not open automatically, tap the button.</p>
</main></body>
</html>`;
}

module.exports = { ROUTER_LOGIN_TEMPLATE_VERSION, renderRouterLoginPage };
