# =====================================================================
#  WiFi Fiti - router-side polling and usage reporting
#
#  Every 10 seconds the router does one round trip: it reports how much
#  time each customer has actually consumed, and collects any new work.
#  Nothing inbound is opened - no port forward, no VPN, no exposed API.
#
#  Usage has to come from here because the router is the only thing that
#  counts real seconds. Without it the portal could show what someone
#  bought but never what they have left.
#
#  The reply is RouterOS script, evaluated from memory with :parse.
#  Nothing is written to disk: on 16MB of flash, a file written every
#  10 seconds would wear it out.
#
#  REQUIREMENTS
#    - device-mode must allow "fetch"   (/system device-mode print)
#    - the server must be reachable over HTTPS
#
#  Edit the three SETTINGS values, then paste the whole file.
# =====================================================================

# ---------------------------- SETTINGS -------------------------------
:global fitiUrl   "https://wififiti.co.ke"
:global fitiSite  "kitale-1"
:global fitiToken "PASTE-THE-SITE-TOKEN-HERE"
# ---------------------------------------------------------------------

/system script remove [find name="fiti-poll"]
/system script remove [find name="fiti-boot"]
/system scheduler remove [find name="fiti-poll"]
/system scheduler remove [find name="fiti-globals"]

# --- The poll itself --------------------------------------------------
/system script add name=fiti-poll owner=admin policy=read,write,test,policy source="\
:global fitiUrl\r\
\n:global fitiSite\r\
\n:global fitiToken\r\
\n:if ([:len \$fitiToken] < 8) do={ :log warning \"fiti: token missing\"; :return }\r\
\n:local report \"\"\r\
\n:foreach u in=[/ip hotspot user find where name~\"^254\"] do={\r\
\n  :local n [/ip hotspot user get \$u name]\r\
\n  :local up [/ip hotspot user get \$u uptime]\r\
\n  :local lim [/ip hotspot user get \$u limit-uptime]\r\
\n  :set report (\$report . \$n . \":\" . [:tonum \$up] . \":\" . [:tonum \$lim] . \"\\n\")\r\
\n}\r\
\n:local url (\$fitiUrl . \"/api/router/sync?site=\" . \$fitiSite . \"&token=\" . \$fitiToken)\r\
\n:local reply\r\
\n:do {\r\
\n  :set reply [/tool fetch url=\$url http-method=post http-data=\$report output=user as-value]\r\
\n} on-error={\r\
\n  :log warning \"fiti: server unreachable\"\r\
\n  :return\r\
\n}\r\
\n:if ([:typeof \$reply] != \"array\") do={ :return }\r\
\n:local body (\$reply->\"data\")\r\
\n:if ([:len \$body] < 5) do={ :return }\r\
\n:do {\r\
\n  [:parse \$body]\r\
\n} on-error={\r\
\n  :log warning \"fiti: job script failed to run\"\r\
\n}\r\
\n"

# --- Restore globals at boot -----------------------------------------
#  RouterOS clears global variables on restart. Without this the poll
#  silently stops after every power cut, and payments queue up unseen.
/system script add name=fiti-boot owner=admin policy=read,write,test,policy source="\
:global fitiUrl \"$fitiUrl\"\r\
\n:global fitiSite \"$fitiSite\"\r\
\n:global fitiToken \"$fitiToken\"\r\
\n:log info \"fiti: settings restored after boot\"\r\
\n"

/system scheduler add name=fiti-globals start-time=startup interval=0 \
  policy=read,write,test,policy on-event="/system script run fiti-boot" \
  comment="WiFi Fiti: restore settings after reboot"

/system scheduler add name=fiti-poll interval=10s \
  policy=read,write,test,policy on-event="/system script run fiti-poll" \
  comment="WiFi Fiti: report usage and collect jobs"

:put ""
:put "Installed. Polling every 10s, settings restored at boot."
:put "Test now:      /system script run fiti-poll"
:put "Check logs:    /log print where message~\"fiti\""
:put "Granted users: /ip hotspot user print"
