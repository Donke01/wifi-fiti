# =====================================================================
#  WiFi Fiti - router-side polling, usage reporting and acknowledgement
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

# ---------------------------- SETTINGS -------------------------------
:global fitiUrl   "https://cloud.wififiti.co.ke"
:global fitiSite  "kitale-1"
:global fitiToken "PASTE-THE-SITE-TOKEN-HERE"
# ---------------------------------------------------------------------

# One MAC-bound username may have only one active device. Also prevent a
# connected phone from forwarding received internet packets to tethered
# clients by delivering them with TTL 1.
/ip hotspot user profile set [find name="standard"] shared-users=1
/ip firewall mangle remove [find comment="WiFi Fiti anti-tethering"]
/ip firewall mangle add chain=postrouting out-interface=bridge-hs \
  action=change-ttl new-ttl=set:1 passthrough=yes \
  comment="WiFi Fiti anti-tethering"

:global fitiAck ""

/system script remove [find name="fiti-poll"]
/system script remove [find name="fiti-boot"]
/system scheduler remove [find name="fiti-poll"]
/system scheduler remove [find name="fiti-globals"]

/system script add name=fiti-poll owner=admin policy=read,write,test,policy source="\
:global fitiUrl\r\
\n:global fitiSite\r\
\n:global fitiToken\r\
\n:global fitiAck\r\
\n:if ([:len \$fitiToken] > 8) do={\r\
\n  :local report \"\"\r\
\n  :foreach u in=[/ip hotspot user find where name~\"^254\"] do={\r\
\n    :local n [/ip hotspot user get \$u name]\r\
\n    :local up [/ip hotspot user get \$u uptime]\r\
\n    :local lim [/ip hotspot user get \$u limit-uptime]\r\
\n    :local act 0\r\
\n    :if ([:len [/ip hotspot active find where user=\$n]] > 0) do={ :set act 1 }\r\
\n    :set report (\$report . \$n . \":\" . [:tonum \$up] . \":\" . [:tonum \$lim] . \":\" . \$act . \"\\n\")\r\
\n  }\r\
\n  :local sending \$fitiAck\r\
\n  :local url (\$fitiUrl . \"/api/router/sync\?site=\" . \$fitiSite . \"&token=\" . \$fitiToken . \"&ack=\" . \$sending)\r\
\n  :local reply \"\"\r\
\n  :local ok false\r\
\n  :do {\r\
\n    :set reply [/tool fetch url=\$url http-method=post http-data=\$report output=user as-value]\r\
\n    :set ok true\r\
\n  } on-error={\r\
\n    :log warning \"fiti: server unreachable\"\r\
\n  }\r\
\n  :if (\$ok) do={\r\
\n    :if (\$fitiAck = \$sending) do={ :set fitiAck \"\" }\r\
\n    :if ([:typeof \$reply] = \"array\") do={\r\
\n      :local body (\$reply->\"data\")\r\
\n      :if ([:len \$body] > 4) do={\r\
\n        :do {\r\
\n          [:parse \$body]\r\
\n        } on-error={\r\
\n          :log warning \"fiti: job script failed to run\"\r\
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
/system script add name=fiti-boot owner=admin policy=read,write,test,policy source="\
:global fitiUrl \"$fitiUrl\"\r\
\n:global fitiSite \"$fitiSite\"\r\
\n:global fitiToken \"$fitiToken\"\r\
\n:global fitiAck \"\"\r\
\n:log info \"fiti: settings restored after boot\"\r\
\n"

/system scheduler add name=fiti-globals start-time=startup interval=0 \
  policy=read,write,test,policy on-event="/system script run fiti-boot" \
  comment="WiFi Fiti: restore settings after reboot"

/system scheduler add name=fiti-poll interval=2s \
  policy=read,write,test,policy on-event="/system script run fiti-poll" \
  comment="WiFi Fiti: sync usage, ack jobs, collect work"

:put ""
:put "Installed. Polling every 2s, settings restored at boot."
:put "Test now:      /system script run fiti-poll"
:put "Check logs:    /log print where message~\"fiti\""
:put "Granted users: /ip hotspot user print detail"
