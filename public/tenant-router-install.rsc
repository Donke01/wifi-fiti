# =====================================================================
#  WiFi Fiti for Business - router-side polling, usage reporting and acknowledgement
#
#  Every 2 seconds the router does ONE round trip that carries: which
#  jobs it ran last cycle and a request for new work. The server also sends
#  disconnect commands for wall-clock subscriptions that have expired.
#  Nothing inbound is ever opened.
#
#  Usage and online state are retained as diagnostics. Package expiry is
#  controlled by the server's wall clock and does not pause when offline.
#
#  WHY ACK RIDES THIS REQUEST
#  An earlier version acknowledged jobs with a second fetch fired from
#  inside the downloaded script. It was wrapped in on-error={} so a blip
#  could not abort provisioning - which meant that when it failed, it
#  failed silently. Jobs were never acked, the server redelivered them
#  every 60 seconds, and each redelivery rewrote limit-uptime, so a
#  customer who topped up saw their balance snap back once a minute.
#  Now the ids ride on the sync request, which is already proven to work.
#
#  STYLE: nested :if, never a bare :return. A bare ":return" in a
#  scheduled script raises "missing value(s) of argument(s) value".
#
#  REQUIREMENTS
#    - device-mode must allow "fetch"   (/system device-mode print)
#    - the server must be reachable over HTTPS
#
#  Edit the three SETTINGS values, then paste the whole file.
# =====================================================================

# RouterOS 7.21+ includes built-in root CAs, but they can be disabled after
# an upgrade (especially on small-board devices). Enable them before the
# first HTTPS request; retain the older property as a safe fallback.
:do {
  # RouterOS parses scheduler/import source before :do can catch a bad
  # property. Keep version-specific certificate settings in :parse so an
  # older RouterOS 7 build reaches the trusted fallback instead of aborting
  # the whole tenant installer.
  [:parse "/certificate settings set builtin-trust-store=all"]
} on-error={
  :do {
    [:parse "/certificate settings set builtin-trust-anchors=trusted"]
  } on-error={
    :log warning "fiti: built-in CA trust store could not be enabled"
  }
}

# Settings must already exist as globals before import. The installer does
# not contain or overwrite the private site token.
:global fitiUrl
:global fitiPortalUrl
:global fitiPortalHost
:global fitiPortalAppliedHost
:global fitiSite
:global fitiToken
:global fitiSetupAck
:global fitiSetupProtocol
:global fitiBridge
:global fitiSupportEnabled
:global fitiSupportEnrollUrl
:global fitiSupportInterface
:if ([:len $fitiUrl] = 0 || [:len $fitiSite] = 0 || [:len $fitiToken] < 9) do={
  :error "Set fitiUrl, fitiSite and fitiToken before importing"
}
:if ([:len $fitiBridge] = 0) do={ :set fitiBridge "bridge-hs" }
:if ([:len $fitiPortalHost] = 0) do={ :set fitiPortalHost "" }
:if ([:len $fitiPortalAppliedHost] = 0) do={ :set fitiPortalAppliedHost "" }
:if ([:len $fitiSetupAck] = 0) do={ :set fitiSetupAck "" }
:if ([:len $fitiSetupProtocol] = 0) do={ :set fitiSetupProtocol "2" }
:if ([:len $fitiSupportEnabled] = 0) do={ :set fitiSupportEnabled "no" }
:if ([:len $fitiSupportEnrollUrl] = 0) do={ :set fitiSupportEnrollUrl ($fitiUrl . "/api/router/support-enroll") }
:if ([:len $fitiSupportInterface] = 0) do={ :set fitiSupportInterface "fiti-support-wg" }

# Device-mode restrictions otherwise allow a partial portal update and only
# fail later when the poll scheduler is created. Stop before touching the
# Hotspot if any mandatory WiFi Fiti feature is blocked. We intentionally
# request only the three required flags; the owner must confirm the change
# physically and re-import rather than the installer changing it silently.
:local fitiDeviceFetch true
:local fitiDeviceScheduler true
:local fitiDeviceHotspot true
:local fitiDeviceFlagged false
# Defer optional properties while returning values into this script's scope.
:do { :local fitiRead [:parse ":return [/system device-mode get fetch]"]; :set fitiDeviceFetch [$fitiRead] } on-error={}
:do { :local fitiRead [:parse ":return [/system device-mode get scheduler]"]; :set fitiDeviceScheduler [$fitiRead] } on-error={}
:do { :local fitiRead [:parse ":return [/system device-mode get hotspot]"]; :set fitiDeviceHotspot [$fitiRead] } on-error={}
:do { :local fitiRead [:parse ":return [/system device-mode get flagged]"]; :set fitiDeviceFlagged [$fitiRead] } on-error={}
:if (($fitiDeviceFetch != true) || ($fitiDeviceScheduler != true) || ($fitiDeviceHotspot != true)) do={
  :error "RouterOS device mode blocks a required WiFi Fiti feature. Run /system device-mode update fetch=yes scheduler=yes hotspot=yes, confirm it physically, then import this kit again."
}
:if ($fitiDeviceFlagged = true) do={
  :error "RouterOS has flagged this configuration. Audit it, then run /system device-mode update flagged=no and confirm it physically before importing this kit."
}


:global fitiHotspotServer
:if ([:len $fitiHotspotServer] = 0) do={ :set fitiHotspotServer "hotspot1" }

# Validate this router before modifying its portal or installed scripts.
:if ([:len [/ip hotspot find where name=$fitiHotspotServer]] != 1) do={
  :error "Hotspot server not found. Finish RouterOS Hotspot Setup and set fitiHotspotServer first."
}
:if ([:len [/interface find where name=$fitiBridge]] != 1) do={
  :error "Customer bridge not found. Correct fitiBridge before importing."
}
:local fitiHotspotBridge [/ip hotspot get [find where name=$fitiHotspotServer] interface]
:if ($fitiHotspotBridge != $fitiBridge) do={
  :error "The selected Hotspot server is not on fitiBridge. Correct the bridge or Hotspot name before importing."
}
:local previousBoot [/system script find where name="fiti-boot"]
:if ([:len $previousBoot] > 0) do={
  :local previous [/system script get $previousBoot source]
  :if ([:typeof [:find $previous $fitiSite]] = "nil") do={
    :error "This router is paired to a different WiFi Fiti site. Complete a deliberate migration before pairing it here."
  }
}

# Keep the private router credential out of request URLs.
:local profileId [/ip hotspot get [find where name=$fitiHotspotServer] profile]
:local htmlDir [/ip hotspot profile get [find where name=$profileId] html-directory]
:if ([:len $htmlDir] = 0) do={ :set htmlDir "hotspot" }
:local fitiLoginUrl ($fitiUrl . "/api/tenant/" . $fitiSite . "/router-login")
:if ([:len $fitiPortalHost] > 0) do={ :set fitiLoginUrl ($fitiLoginUrl . "?portal=" . $fitiPortalHost) }
/tool fetch url=$fitiLoginUrl \
  check-certificate=yes http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) dst-path=($htmlDir . "/login.html")
:set fitiPortalAppliedHost $fitiPortalHost

:if ([:len [/ip hotspot user profile find where name="standard"]] = 0) do={
  /ip hotspot user profile add name=standard shared-users=1
}

# Enforce one physical device per MAC-bound identity and prevent ordinary
# phone hotspot/tether forwarding by delivering client packets with TTL 1.
/ip hotspot user profile set [find name="standard"] shared-users=1
/ip firewall mangle remove [find comment="WiFi Fiti anti-tethering"]
:if ([:len [/interface find where name=$fitiBridge]] > 0) do={
  /ip firewall mangle add chain=postrouting out-interface=$fitiBridge \
    action=change-ttl new-ttl=set:1 passthrough=yes \
    comment="WiFi Fiti anti-tethering"
} else={
  :log warning "WiFi Fiti: anti-tethering was not applied; set fitiBridge to the customer bridge, then import again"
}

:global fitiAck ""
:global fitiSetupAck ""
:global fitiSupportAck ""
# Inventory is a bounded, non-secret port map sent through the existing
# authenticated poll. It deliberately excludes IPs, MACs, credentials,
# routes, users, security profiles and all WireGuard material.
:global fitiTopologyTick 0

/system script remove [find name="fiti-poll"]
/system script remove [find name="fiti-boot"]
/system scheduler remove [find name="fiti-poll"]
/system scheduler remove [find name="fiti-globals"]

/system script add name=fiti-poll policy=read,write,ftp,test,policy source="\
:global fitiUrl\r\
\n:global fitiPortalHost\r\
\n:global fitiPortalAppliedHost\r\
\n:global fitiSite\r\
\n:global fitiToken\r\
\n:global fitiBridge\r\
\n:global fitiHotspotServer\r\
\n:global fitiAck\r\
\n:global fitiSetupAck\r\
\n:global fitiSetupProtocol\r\
\n:global fitiSupportAck\r\
\n:global fitiTopologyTick\r\
\n:if ([:len \$fitiToken] > 8) do={\r\
\n  :local report \"\"\r\
\n  :local reportCount 0\r\
\n  :foreach u in=[/ip hotspot user find where name~\"^254\"] do={\r\
\n    :if (\$reportCount < 100) do={\r\
\n      :local n [/ip hotspot user get \$u name]\r\
\n      :local up [/ip hotspot user get \$u uptime]\r\
\n      :local lim [/ip hotspot user get \$u limit-uptime]\r\
\n      :local act 0\r\
\n      :if ([:len [/ip hotspot active find where user=\$n]] > 0) do={ :set act 1 }\r\
\n      :set report (\$report . \$n . \":\" . [:tonum \$up] . \":\" . [:tonum \$lim] . \":\" . \$act . \"\\n\")\r\
\n      :set reportCount (\$reportCount + 1)\r\
\n    }\r\
\n  }\r\
\n  :if ([:typeof \$fitiTopologyTick] != \"num\") do={ :set fitiTopologyTick 0 }\r\
\n  :set fitiTopologyTick (\$fitiTopologyTick + 1)\r\
\n  :if (\$fitiTopologyTick >= 6) do={\r\
\n    :set fitiTopologyTick 0\r\
\n    :local fitiTopology \"fiti-topology-v1\\n\"\r\
\n    :local fitiTopologyInterfaces 0\r\
\n    :local fitiTopologyWifiInterfaces 0\r\
\n    :local fitiTopologyBridgePorts 0\r\
\n    :local fitiTopologySafe do={\r\
\n      :local fitiTopologyValue \$1\r\
\n      :local fitiTopologyValid true\r\
\n      :if ([:len \$fitiTopologyValue] = 0 || [:len \$fitiTopologyValue] > 64) do={ :set fitiTopologyValid false }\r\
\n      :local fitiTopologyOffset 0\r\
\n      :while (\$fitiTopologyOffset < [:len \$fitiTopologyValue]) do={\r\
\n        :local fitiTopologyCharacter [:pick \$fitiTopologyValue \$fitiTopologyOffset (\$fitiTopologyOffset + 1)]\r\
\n        :if ([:typeof [:find \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-\" \$fitiTopologyCharacter]] = \"nil\") do={ :set fitiTopologyValid false }\r\
\n        :set fitiTopologyOffset (\$fitiTopologyOffset + 1)\r\
\n      }\r\
\n      :return \$fitiTopologyValid\r\
\n    }\r\
\n    :local fitiTopologyVersion [/system resource get version]\r\
\n    :local fitiTopologyVersionSpace [:find \$fitiTopologyVersion \" \"]\r\
\n    :if ([:typeof \$fitiTopologyVersionSpace] != \"nil\") do={ :set fitiTopologyVersion [:pick \$fitiTopologyVersion 0 \$fitiTopologyVersionSpace] }\r\
\n    :if ([\$fitiTopologySafe \$fitiTopologyVersion]) do={ :set fitiTopology (\$fitiTopology . \"topo|system|routeros|\" . \$fitiTopologyVersion . \"\\n\") }\r\
\n    :if ([\$fitiTopologySafe \$fitiHotspotServer]) do={ :set fitiTopology (\$fitiTopology . \"topo|hotspot|\" . \$fitiHotspotServer . \"\\n\") }\r\
\n    :if ([\$fitiTopologySafe \$fitiBridge]) do={ :set fitiTopology (\$fitiTopology . \"topo|customer-bridge|\" . \$fitiBridge . \"\\n\") }\r\
\n    :local fitiTopologyDhcpClients [/ip dhcp-client find where disabled=no]\r\
\n    :if ([:len \$fitiTopologyDhcpClients] = 1) do={\r\
\n      :local fitiTopologyWan [/ip dhcp-client get [:pick \$fitiTopologyDhcpClients 0] interface]\r\
\n      :if ([\$fitiTopologySafe \$fitiTopologyWan]) do={ :set fitiTopology (\$fitiTopology . \"topo|wan|\" . \$fitiTopologyWan . \"\\n\") }\r\
\n    }\r\
\n    :foreach fitiTopologyEther in=[/interface ethernet find] do={\r\
\n      :if (\$fitiTopologyInterfaces < 20) do={\r\
\n        :local fitiTopologyName [/interface ethernet get \$fitiTopologyEther name]\r\
\n        :local fitiTopologyState \"down\"\r\
\n        :do { :if ([/interface ethernet get \$fitiTopologyEther running] = true) do={ :set fitiTopologyState \"up\" } } on-error={}\r\
\n        :do { :if ([/interface ethernet get \$fitiTopologyEther disabled] = true) do={ :set fitiTopologyState \"disabled\" } } on-error={}\r\
\n        :if ([\$fitiTopologySafe \$fitiTopologyName]) do={ :set fitiTopology (\$fitiTopology . \"topo|interface|ether|\" . \$fitiTopologyName . \"|\" . \$fitiTopologyState . \"\\n\"); :set fitiTopologyInterfaces (\$fitiTopologyInterfaces + 1) }\r\
\n      }\r\
\n    }\r\
\n    :foreach fitiTopologyBridge in=[/interface bridge find] do={\r\
\n      :if (\$fitiTopologyInterfaces < 28) do={\r\
\n        :local fitiTopologyName [/interface bridge get \$fitiTopologyBridge name]\r\
\n        :local fitiTopologyState \"down\"\r\
\n        :do { :if ([/interface bridge get \$fitiTopologyBridge running] = true) do={ :set fitiTopologyState \"up\" } } on-error={}\r\
\n        :do { :if ([/interface bridge get \$fitiTopologyBridge disabled] = true) do={ :set fitiTopologyState \"disabled\" } } on-error={}\r\
\n        :if ([\$fitiTopologySafe \$fitiTopologyName]) do={ :set fitiTopology (\$fitiTopology . \"topo|interface|bridge|\" . \$fitiTopologyName . \"|\" . \$fitiTopologyState . \"\\n\"); :set fitiTopologyInterfaces (\$fitiTopologyInterfaces + 1) }\r\
\n      }\r\
\n    }\r\
\n    :local fitiTopologyWireless \"\"\r\
\n    :do { :set fitiTopologyWireless [/interface wireless find] } on-error={}\r\
\n    :foreach fitiTopologyRadio in=\$fitiTopologyWireless do={\r\
\n      :if (\$fitiTopologyInterfaces < 32 && \$fitiTopologyWifiInterfaces < 8) do={\r\
\n        :local fitiTopologyName [/interface wireless get \$fitiTopologyRadio name]\r\
\n        :local fitiTopologyState \"down\"\r\
\n        :do { :if ([/interface wireless get \$fitiTopologyRadio running] = true) do={ :set fitiTopologyState \"up\" } } on-error={}\r\
\n        :do { :if ([/interface wireless get \$fitiTopologyRadio disabled] = true) do={ :set fitiTopologyState \"disabled\" } } on-error={}\r\
\n        :if ([\$fitiTopologySafe \$fitiTopologyName]) do={ :set fitiTopology (\$fitiTopology . \"topo|interface|wireless|\" . \$fitiTopologyName . \"|\" . \$fitiTopologyState . \"\\n\" . \"topo|wifi|wireless|\" . \$fitiTopologyName . \"|\" . \$fitiTopologyState . \"\\n\"); :set fitiTopologyInterfaces (\$fitiTopologyInterfaces + 1); :set fitiTopologyWifiInterfaces (\$fitiTopologyWifiInterfaces + 1) }\r\
\n      }\r\
\n    }\r\
\n    :local fitiTopologyWifi \"\"\r\
\n    :do { :set fitiTopologyWifi [/interface wifi find] } on-error={}\r\
\n    :foreach fitiTopologyRadio in=\$fitiTopologyWifi do={\r\
\n      :if (\$fitiTopologyInterfaces < 32 && \$fitiTopologyWifiInterfaces < 8) do={\r\
\n        :local fitiTopologyName [/interface wifi get \$fitiTopologyRadio name]\r\
\n        :local fitiTopologyState \"down\"\r\
\n        :do { :if ([/interface wifi get \$fitiTopologyRadio running] = true) do={ :set fitiTopologyState \"up\" } } on-error={}\r\
\n        :do { :if ([/interface wifi get \$fitiTopologyRadio disabled] = true) do={ :set fitiTopologyState \"disabled\" } } on-error={}\r\
\n        :if ([\$fitiTopologySafe \$fitiTopologyName]) do={ :set fitiTopology (\$fitiTopology . \"topo|interface|wifi|\" . \$fitiTopologyName . \"|\" . \$fitiTopologyState . \"\\n\" . \"topo|wifi|wifi|\" . \$fitiTopologyName . \"|\" . \$fitiTopologyState . \"\\n\"); :set fitiTopologyInterfaces (\$fitiTopologyInterfaces + 1); :set fitiTopologyWifiInterfaces (\$fitiTopologyWifiInterfaces + 1) }\r\
\n      }\r\
\n    }\r\
\n    :foreach fitiTopologyBridgePort in=[/interface bridge port find] do={\r\
\n      :if (\$fitiTopologyBridgePorts < 64) do={\r\
\n        :local fitiTopologyPortBridge [/interface bridge port get \$fitiTopologyBridgePort bridge]\r\
\n        :local fitiTopologyPortInterface [/interface bridge port get \$fitiTopologyBridgePort interface]\r\
\n        :if ([\$fitiTopologySafe \$fitiTopologyPortBridge] && [\$fitiTopologySafe \$fitiTopologyPortInterface]) do={ :set fitiTopology (\$fitiTopology . \"topo|bridge-port|\" . \$fitiTopologyPortBridge . \"|\" . \$fitiTopologyPortInterface . \"\\n\"); :set fitiTopologyBridgePorts (\$fitiTopologyBridgePorts + 1) }\r\
\n      }\r\
\n    }\r\
\n    :set report (\$report . \$fitiTopology . \"fiti-topology-end\\n\")\r\
\n  }\r\
\n  :local fitiHealth \"ready\"\r\
\n  :if ([:len [/ip hotspot find where name=\$fitiHotspotServer]] != 1) do={ :set fitiHealth \"hotspot-missing\" }\r\
\n  :if ([:len [/interface bridge find where name=\$fitiBridge]] != 1) do={ :set fitiHealth \"bridge-missing\" }\r\
\n  :if ([:len [/system script find where name=\"fiti-poll\"]] != 1) do={ :set fitiHealth \"poller-missing\" }\r\
\n  :if ([:len \$fitiPortalHost] > 0 && \$fitiPortalAppliedHost != \$fitiPortalHost) do={ :set fitiHealth \"portal-missing\" }\r\
\n  :local sending \$fitiAck\r\
\n  :local sendingSetup \$fitiSetupAck\r\
\n  :local sendingSupport \$fitiSupportAck\r\
\n  :local url (\$fitiUrl . \"/api/router/sync\?site=\" . \$fitiSite . \"&ack=\" . \$sending . \"&setupAck=\" . \$sendingSetup . \"&supportAck=\" . \$sendingSupport . \"&protocol=\" . \$fitiSetupProtocol . \"&health=\" . \$fitiHealth . \"&portal=\" . \$fitiPortalHost . \"&portalApplied=\" . \$fitiPortalAppliedHost . \"&hotspot=\" . \$fitiHotspotServer . \"&bridge=\" . \$fitiBridge)\r\
\n  :local reply \"\"\r\
\n  :local ok false\r\
\n  :onerror fitiSyncError in={\r\
\n    :set reply [/tool fetch url=\$url check-certificate=yes http-header-field=(\"X-WiFi-Fiti-Router: \" . \$fitiToken) http-method=post http-data=\$report output=user as-value]\r\
\n    :if ([:typeof \$reply] = \"array\") do={ :if ((\$reply->\"status\") = \"finished\") do={ :set ok true } else={ :log warning \"fiti: cloud sync did not finish\" } } else={ :log warning \"fiti: cloud sync returned no status\" }\r\
\n  } do={\r\
\n    :log warning (\"fiti: cloud sync failed: \" . \$fitiSyncError)\r\
\n  }\r\
\n  :if (\$ok) do={\r\
\n    :if (\$fitiAck = \$sending) do={ :set fitiAck \"\" }\r\
\n    :if (\$fitiSetupAck = \$sendingSetup) do={ :set fitiSetupAck \"\" }\r\
\n    :if (\$fitiSupportAck = \$sendingSupport) do={ :set fitiSupportAck \"\" }\r\
\n    :local fitiFirstInstallScheduler [/system scheduler find where name=\"fiti-first-install\"]\r\
\n    :if ([:len \$fitiFirstInstallScheduler] = 1) do={\r\
\n      :local fitiFirstInstallComment [/system scheduler get \$fitiFirstInstallScheduler comment]\r\
\n      :if ([:typeof [:find \$fitiFirstInstallComment \"WiFi Fiti: retry cloud installer\"]] != \"nil\") do={\r\
\n        :if ([/system scheduler get \$fitiFirstInstallScheduler disabled] = false) do={\r\
\n          /system scheduler disable \$fitiFirstInstallScheduler\r\
\n          :log info \"fiti: cloud sync verified; first-install retry disabled\"\r\
\n        }\r\
\n      }\r\
\n    }\r\
\n    :if ([:typeof \$reply] = \"array\") do={\r\
\n      :local body (\$reply->\"data\")\r\
\n      :if ([:len \$body] > 4) do={\r\
\n        :onerror fitiJobError in={ [:parse \$body] } do={\r\
\n          :log warning (\"fiti: job script failed to run: \" . \$fitiJobError)\r\
\n        }\r\
\n      }\r\
\n    }\r\
\n  }\r\
\n} else={\r\
\n  :log warning \"fiti: token missing, not polling\"\r\
\n}\r\
\n"

# --- Restore settings at boot ----------------------------------------
#  RouterOS clears globals on restart. Without this the poll silently
#  stops after every power cut and payments queue up unseen.
/system script add name=fiti-boot policy=read,write,ftp,test,policy source="\
:global fitiUrl \"$fitiUrl\"\r\
\n:global fitiPortalUrl \"$fitiPortalUrl\"\r\
\n:global fitiPortalHost \"$fitiPortalHost\"\r\
\n:global fitiPortalAppliedHost \"$fitiPortalAppliedHost\"\r\
\n:global fitiSite \"$fitiSite\"\r\
\n:global fitiToken \"$fitiToken\"\r\
\n:global fitiSetupProtocol \"2\"\r\
\n:global fitiBridge \"$fitiBridge\"\r\
\n:global fitiHotspotServer \"$fitiHotspotServer\"\r\
\n:global fitiSupportEnabled \"$fitiSupportEnabled\"\r\
\n:global fitiSupportEnrollUrl \"$fitiSupportEnrollUrl\"\r\
\n:global fitiSupportInterface \"$fitiSupportInterface\"\r\
\n:global fitiTopologyTick 0\r\
\n:local fitiSupportScheduler [/system scheduler find where name=\"fiti-support-enroll\"]\r\
\n:if ([:len \$fitiSupportScheduler] = 1) do={ /system scheduler disable \$fitiSupportScheduler }\r\
\n:global fitiAck \"\"\r\
\n:global fitiSetupAck \"\"\r\
\n:global fitiSupportAck \"\"\r\
\n:log info \"fiti: settings restored after boot\"\r\
\n"

# --- Optional remote-support key bootstrap ---------------------------
# This is deliberately not a VPN installer. It runs only after an
# owner-consented, platform-authorized prepare job sets fitiSupportEnabled=yes.
# It creates a DISABLED
# RouterOS WireGuard interface (which generates a key pair), reports only the
# public key through the existing HTTPS router authentication, and ignores all
# response content. It never adds a peer, IP address, route, firewall rule,
# management service rule, or WAN port opening. A VPN hub must be provisioned
# separately before any remote connection can exist. After the gateway has
# accepted this public key, a separate, authenticated activate control may
# configure exactly one tagged gateway peer, this router's management /32,
# a gateway-only /32 return route, and an input rule limited to that gateway.
# It never changes a customer LAN route, default route, NAT rule or RouterOS
# service. To revoke support later, the dedicated revoke control removes only
# those tagged resources plus this tagged interface and retry scheduler.
:local fitiSupportSource "\
:global fitiUrl\r\
\n:global fitiSite\r\
\n:global fitiToken\r\
\n:global fitiSupportEnabled\r\
\n:global fitiSupportEnrollUrl\r\
\n:global fitiSupportInterface\r\
\n:local fitiSupportWireguard [/interface wireguard find where name=\$fitiSupportInterface]\r\
\n:if (\$fitiSupportEnabled = \"yes\") do={\r\
\n  :local fitiSupportExpectedUrl (\$fitiUrl . \"/api/router/support-enroll\")\r\
\n  :if ([:len \$fitiToken] > 8 && [:len \$fitiSite] > 0 && \$fitiSupportEnrollUrl = \$fitiSupportExpectedUrl && [:pick \$fitiSupportEnrollUrl 0 8] = \"https://\") do={\r\
\n    :local fitiSupportManaged false\r\
\n    :if ([:len \$fitiSupportWireguard] = 0) do={\r\
\n      /interface wireguard add name=\$fitiSupportInterface disabled=yes comment=\"WiFi Fiti support: pending owner-approved enrollment\"\r\
\n      :set fitiSupportWireguard [/interface wireguard find where name=\$fitiSupportInterface]\r\
\n      :set fitiSupportManaged true\r\
\n    } else={\r\
\n      :local fitiSupportComment [/interface wireguard get \$fitiSupportWireguard comment]\r\
\n      :if ([:typeof [:find \$fitiSupportComment \"WiFi Fiti support:\"]] != \"nil\") do={ :set fitiSupportManaged true } else={ :log warning \"fiti support: interface name is already used by a non-WiFi-Fiti tunnel\" }\r\
\n    }\r\
\n    :if (\$fitiSupportManaged) do={\r\
\n      :local fitiSupportPublicKey [/interface wireguard get \$fitiSupportWireguard public-key]\r\
\n      :local fitiSupportPayload (\"version=1\\nsite=\" . \$fitiSite . \"\\ninterface=\" . \$fitiSupportInterface . \"\\npublic-key=\" . \$fitiSupportPublicKey . \"\\n\")\r\
\n      :local fitiSupportUrl (\$fitiSupportEnrollUrl . \"\?site=\" . \$fitiSite)\r\
\n      :local fitiSupportScheduler [/system scheduler find where name=\"fiti-support-enroll\"]\r\
\n      :do {\r\
\n        /tool fetch url=\$fitiSupportUrl check-certificate=yes http-header-field=(\"X-WiFi-Fiti-Router: \" . \$fitiToken) http-method=post http-data=\$fitiSupportPayload output=none\r\
\n        :if ([:len \$fitiSupportScheduler] = 1) do={ /system scheduler disable \$fitiSupportScheduler }\r\
\n        :log info \"fiti support: public key reported; WireGuard remains disabled until the gateway is provisioned\"\r\
\n      } on-error={\r\
\n        :if ([:len \$fitiSupportScheduler] = 1) do={ /system scheduler enable \$fitiSupportScheduler }\r\
\n        :log warning (\"fiti support: HTTPS enrollment unavailable; WireGuard remains disabled. Public key: \" . \$fitiSupportPublicKey)\r\
\n        :put (\"WiFi Fiti support public key: \" . \$fitiSupportPublicKey)\r\
\n        :error \"fiti support: enrollment failed\"\r\
\n      }\r\
\n    }\r\
\n  } else={\r\
\n    :log warning \"fiti support: enrollment is pending until RouterOS pairing settings are restored\"\r\
\n  }\r\
\n}\r\
\n"
/system script remove [find name="fiti-support-bootstrap"]
/system script add name=fiti-support-bootstrap policy=read,write,ftp,test,policy source=$fitiSupportSource

# Leave the retry scheduler disabled until the customer has expressly opted
# in. A failed bootstrap enables this scheduler for a retry during that
# prepared session; a successful report disables it again. A reboot restores
# the dormant default.
:local fitiSupportScheduler [/system scheduler find where name="fiti-support-enroll"]
:if ([:len $fitiSupportScheduler] = 0) do={
  /system scheduler add name=fiti-support-enroll interval=1h disabled=yes \
    policy=read,write,ftp,test,policy on-event="/system script run fiti-support-bootstrap" \
    comment="WiFi Fiti: optional remote-support public-key enrollment"
} else={
  /system scheduler set $fitiSupportScheduler interval=1h \
    policy=read,write,ftp,test,policy on-event="/system script run fiti-support-bootstrap" \
    comment="WiFi Fiti: optional remote-support public-key enrollment"
}

/system scheduler add name=fiti-globals start-time=startup interval=0 \
  policy=read,write,ftp,test,policy on-event="/system script run fiti-boot" \
  comment="WiFi Fiti: restore settings after reboot"

# A repeating task with start-time=startup does not run on reboot in RouterOS.
# Anchor it at the epoch instead, so it becomes due within two seconds even
# on a freshly reset router whose clock is not trustworthy yet.
/system scheduler add name=fiti-poll start-date=1970-01-01 start-time=00:00:00 interval=2s disabled=no \
  policy=read,write,ftp,test,policy on-event="/system script run fiti-poll" \
  comment="WiFi Fiti: sync usage, ack jobs, collect work"

# Initialize the globals immediately. Do not wait for the first reboot/startup
# event; a newly installed router must send its first cloud pairing sync now.
:do { /system script run fiti-boot } on-error={ :log warning "fiti: boot globals could not be initialized" }
:do { /system script run fiti-poll } on-error={ :log warning "fiti: initial cloud sync failed; poll scheduler will retry" }

:put ""
:put "Business router paired. Polling is active (2s)."
:put "Test now:      /system script run fiti-poll"
:put "Check logs:    /log print where message~\"fiti\""
:put "Granted users: /ip hotspot user print detail"
