# =====================================================================
#  WiFi Fiti - router-side polling
#
#  The router asks the server for work every 10 seconds and does the
#  provisioning itself. Nothing inbound is ever opened: no port forward,
#  no VPN, no API exposed. Works behind any NAT, and adding a second
#  hotspot is this script with a different SITE, not a server change.
#
#  The reply is RouterOS script, evaluated from memory with :parse.
#  Nothing is written to disk - on 16MB of flash, a file written every
#  10 seconds would wear it out.
#
#  REQUIREMENTS
#    - device-mode must allow "fetch"  (/system device-mode print)
#    - the server must be reachable over HTTPS
#
#  Edit the three SETTINGS values, then paste the whole file.
# =====================================================================

# ---------------------------- SETTINGS -------------------------------
:global fitiUrl   "https://your-app.up.railway.app"
:global fitiSite  "kitale-1"
:global fitiToken "PASTE-THE-SITE-TOKEN-HERE"
# ---------------------------------------------------------------------

/system script remove [find name="fiti-poll"]
/system scheduler remove [find name="fiti-poll"]

/system script add name=fiti-poll owner=admin \
  policy=read,write,test,policy source="\
:global fitiUrl\r\
\n:global fitiSite\r\
\n:global fitiToken\r\
\n:local url (\$fitiUrl . \"/api/router/jobs?site=\" . \$fitiSite . \"&token=\" . \$fitiToken)\r\
\n:local reply\r\
\n:do {\r\
\n  :set reply [/tool fetch url=\$url output=user as-value]\r\
\n} on-error={\r\
\n  :return\r\
\n}\r\
\n:if ([:typeof \$reply] != \"array\") do={ :return }\r\
\n:local body (\$reply->\"data\")\r\
\n:if ([:len \$body] < 5) do={ :return }\r\
\n:do {\r\
\n  [:parse \$body]\r\
\n} on-error={\r\
\n  :log warning \"fiti-poll: server script failed to run\"\r\
\n}\r\
\n"

/system scheduler add name=fiti-poll interval=10s \
  policy=read,write,test,policy \
  on-event="/system script run fiti-poll" \
  comment="WiFi Fiti: collect provisioning jobs"

:put ""
:put "Polling every 10s."
:put "Test it now with:  /system script run fiti-poll"
:put "Watch results in:  /log print where message~\"fiti\""
:put "See granted users:  /ip hotspot user print"
