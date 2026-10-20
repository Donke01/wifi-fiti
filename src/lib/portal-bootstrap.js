'use strict';

// The customer-facing config is already public at /api/tenant/:location/config.
// Inline the same snapshot in the HTML to remove a mandatory extra network
// round trip before packages can be drawn on slower captive connections.
function escapeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function embedPublicPortalConfig(html, publicConfig) {
  if (typeof html !== 'string' || !/<\/head>/i.test(html)) {
    throw new Error('Missing portal HTML head');
  }
  const data = escapeInlineJson(publicConfig);
  return html.replace(/<\/head>/i,
    '<script>globalThis.__WIFI_FITI_CONFIG__=' + data + ';</script></head>');
}

module.exports = { embedPublicPortalConfig, escapeInlineJson };
