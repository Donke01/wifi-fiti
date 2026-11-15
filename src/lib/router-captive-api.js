'use strict';

// This is RouterOS's native HotSpot CAPPORT document. RouterOS expands the
// macros and serves it from https://<profile dns-name>/api. Deliberately omit
// seconds-remaining: RouterOS session uptime is not the service's absolute
// wall-clock purchase expiry, so reporting it would mislead a device UI.
function renderRouterCaptiveApi() {
  return `{
  "captive": $(if logged-in == 'yes')false$(else)true$(endif),
  "user-portal-url": "$(link-login-only)",
  "can-extend-session": true
}\n`;
}

module.exports = { renderRouterCaptiveApi };
