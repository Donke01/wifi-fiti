'use strict';

/*
 * The easy hotspot address (CAPTIVE_DOMAIN, e.g. wififiti.net).
 *
 * Every paired router gets a local DNS entry for the domain (and www.) that
 * points at its own HotSpot address. On the hotspot, typing the domain opens
 * the router's own page: login.html for a customer who is not logged in
 * (already a redirect to this location's portal) and status.html for one who
 * is, which this block replaces with the same redirect. Each router therefore
 * sends its customers to its own tenant's portal.
 *
 * The HotSpot profile's built-in dns-name is deliberately NOT used: the kits
 * clear it because desktop captive assistants can stop at that alias instead
 * of following the external portal redirect. A plain static DNS entry has no
 * effect on captive-portal detection.
 *
 * The block is idempotent and guarded by a router global, so a router that
 * has already applied this domain does nothing until it reboots or the
 * domain changes.
 */

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function captiveHostnames(domain) {
  const bare = String(domain || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return HOSTNAME.test(bare) ? [bare, `www.${bare}`] : [];
}

/** True when a request's Host is the captive domain or its www. form. */
function isCaptiveHost(host, domain) {
  const names = captiveHostnames(domain);
  return names.length > 0 && names.includes(String(host || '').toLowerCase());
}

function captiveDomainScript(domain) {
  const names = captiveHostnames(domain);
  if (!names.length) return '';
  const [bare, www] = names;
  return [
    ':do {',
    '  :global fitiUrl',
    '  :global fitiSite',
    '  :global fitiToken',
    '  :global fitiHotspotServer',
    '  :global fitiPortalAppliedHost',
    '  :global fitiCaptiveApplied',
    `  :local fitiCdName "${bare}"`,
    '  :if ($fitiCaptiveApplied != $fitiCdName) do={',
    '    :local fitiCdHs [/ip hotspot find where name=$fitiHotspotServer]',
    '    :if ([:len $fitiCdHs] = 1) do={',
    '      :local fitiCdProf [/ip hotspot get $fitiCdHs profile]',
    '      :local fitiCdAddr ""',
    '      :do { :set fitiCdAddr [:tostr [/ip hotspot profile get [find where name=$fitiCdProf] hotspot-address]] } on-error={}',
    // A profile without a hotspot-address uses the HotSpot interface's own.
    '      :if ([:len $fitiCdAddr] = 0) do={',
    '        :local fitiCdIf [/ip hotspot get $fitiCdHs interface]',
    '        :local fitiCdIp [/ip address find where interface=$fitiCdIf and disabled=no]',
    '        :if ([:len $fitiCdIp] > 0) do={ :local fitiCdCidr [/ip address get [:pick $fitiCdIp 0] address]; :set fitiCdAddr [:pick $fitiCdCidr 0 [:find $fitiCdCidr "/"]] }',
    '      }',
    '      :if ([:len $fitiCdAddr] > 0) do={',
    `        :foreach fitiCdN in={"${bare}";"${www}"} do={`,
    '          :local fitiCdE [/ip dns static find where name=$fitiCdN]',
    '          :if ([:len $fitiCdE] = 0) do={ /ip dns static add name=$fitiCdN address=$fitiCdAddr ttl=5m comment="Wi-Fi Fiti easy hotspot address" } else={ /ip dns static set $fitiCdE address=$fitiCdAddr }',
    '        }',
    '        :local fitiCdDir [/ip hotspot profile get [find where name=$fitiCdProf] html-directory]',
    '        :if ([:len $fitiCdDir] = 0) do={ :set fitiCdDir "hotspot" }',
    '        :local fitiCdTls "yes"',
    '        :do { :if ([:typeof [:find [/system script get [find where name="fiti-poll"] source] "check-certificate=no"]] != "nil") do={ :set fitiCdTls "no" } } on-error={}',
    '        :local fitiCdUrl ($fitiUrl . "/api/tenant/" . $fitiSite . "/router-login?page=status")',
    '        :if ([:len $fitiPortalAppliedHost] > 0) do={ :set fitiCdUrl ($fitiCdUrl . "&portal=" . $fitiPortalAppliedHost) }',
    '        /tool fetch url=$fitiCdUrl check-certificate=$fitiCdTls http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) dst-path=($fitiCdDir . "/status.html")',
    '        :set fitiCaptiveApplied $fitiCdName',
    '      }',
    '    }',
    '  }',
    '} on-error={ :log warning "Wi-Fi Fiti: easy hotspot address not applied yet" }',
  ].join('\n');
}

module.exports = { captiveHostnames, isCaptiveHost, captiveDomainScript };
