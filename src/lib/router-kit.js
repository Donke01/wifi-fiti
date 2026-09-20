'use strict';

/**
 * Render the CA-compatible form of the current router kit.
 *
 * The compatibility kit is deliberately not a second installer. Keeping one
 * source of truth means captive-portal, payment, polling, receipt and hotspot
 * fixes cannot silently land in the normal kit but miss older RouterOS boards.
 * The only supported difference is disabling certificate verification for
 * boards whose RouterOS trust store cannot validate the HTTPS certificate.
 */
function compatibilityRouterKit(source) {
  return String(source || '')
    .replace(/check-certificate=yes/g, 'check-certificate=no')
    .replace(/tenant-router-install\.rsc/g, 'tenant-router-install-compat.rsc');
}

/**
 * Render an isolated telemetry test kit from the production kit.  This is an
 * additive transform: the production installer remains the source of truth
 * and is never edited.  Every optional RouterOS read is guarded so an older
 * board simply reports blanks and continues its normal poll.
 */
function telemetryTestRouterKit(source) {
  const input = String(source || '');
  const marker = String.raw`  :local url (\$fitiUrl . \"/api/router/sync\?site=\" . \$fitiSite`;
  const telemetryLines = [
    '  :local fitiTelemetryCpu \\"\\"',
    '  :local fitiTelemetryFreeMemory \\"\\"',
    '  :local fitiTelemetryTotalMemory \\"\\"',
    '  :local fitiTelemetryUptimeSeconds \\"\\"',
    '  :local fitiTelemetryUptimeText \\"\\"',
    '  :local fitiTelemetryRxBytes \\"\\"',
    '  :local fitiTelemetryTxBytes \\"\\"',
    '  :local fitiTelemetryActiveUsers \\"\\"',
    '  :local fitiTelemetryDevices \\"\\"',
    '  :do { :set fitiTelemetryCpu [/system resource get cpu-load] } on-error={}',
    '  :do { :set fitiTelemetryFreeMemory [/system resource get free-memory] } on-error={}',
    '  :do { :set fitiTelemetryTotalMemory [/system resource get total-memory] } on-error={}',
    '  :do { :set fitiTelemetryUptimeSeconds ([:tonsec [/system resource get uptime]] / 1000000000) } on-error={}',
    '  :do { :set fitiTelemetryUptimeText [/system resource get uptime] } on-error={}',
    '  :do { :set fitiTelemetryRxBytes [/interface get [find where name=\\$fitiBridge] rx-byte] } on-error={}',
    '  :do { :set fitiTelemetryTxBytes [/interface get [find where name=\\$fitiBridge] tx-byte] } on-error={}',
    '  :do { :set fitiTelemetryActiveUsers [:len [/ip hotspot active find]] } on-error={}',
    // Keep the discovery report small and limited to bound customer DHCP
    // leases. Hostnames are optional; the portal still has a safe manual MAC
    // fallback when a board does not expose this menu.
    '  :do { :foreach fitiLease in=[/ip dhcp-server lease find where status=bound] do={ :local fitiLeaseMac [/ip dhcp-server lease get $fitiLease mac-address]; :local fitiLeaseIp [/ip dhcp-server lease get $fitiLease address]; :if ([:len $fitiTelemetryDevices] < 1800) do={ :if ([:len $fitiTelemetryDevices] > 0) do={ :set fitiTelemetryDevices ($fitiTelemetryDevices . \",\") }; :set fitiTelemetryDevices ($fitiTelemetryDevices . $fitiLeaseMac . \\"~\\" . $fitiLeaseIp) } } } on-error={}',
  ];
  const telemetry = telemetryLines.map((line) => line + '\\r\\\n\\n').join('');
  if (!input.includes(marker)) return input;
  const withReads = input.replace(marker, telemetry + '\\n' + marker);
  const bridgeMarker = String.raw`&bridge=\" . \$fitiBridge)`;
  const telemetrySuffix = String.raw`&bridge=\" . \$fitiBridge . \"&telemetry=1&cpu=\" . \$fitiTelemetryCpu . \"&freeMem=\" . \$fitiTelemetryFreeMemory . \"&totalMem=\" . \$fitiTelemetryTotalMemory . \"&uptime=\" . \$fitiTelemetryUptimeSeconds . \"&uptimeText=\" . \$fitiTelemetryUptimeText . \"&rx=\" . \$fitiTelemetryRxBytes . \"&tx=\" . \$fitiTelemetryTxBytes . \"&activeUsers=\" . \$fitiTelemetryActiveUsers . \"&devices=\" . \$fitiTelemetryDevices)`;
  return withReads.replace(bridgeMarker, telemetrySuffix);
}

module.exports = { compatibilityRouterKit, telemetryTestRouterKit };
