# =====================================================================
#  WiFi Fiti - MikroTik hAP lite TC (RB941-2nD-TC)
#  Topology: hAP lite hangs OFF your existing router as a separate
#            hotspot segment. Your main network is not touched.
#
#      Internet -> main router (e.g. Archer AX72)
#                     |  LAN port
#                     v
#                  hAP lite ether1 = WAN (gets DHCP from main router)
#                     |
#                  hotspot 10.5.50.x, SSID broadcast from wlan1
#
#  BEFORE RUNNING
#  --------------
#  1. Reset the hAP lite with NO default config, so this script starts
#     from a known state:
#         /system reset-configuration no-defaults=yes skip-backup=yes
#     It reboots with no IP at all. Reconnect in Winbox using the
#     Neighbors tab and clicking its MAC address, not an IP.
#
#  2. Leave ether1 UNPLUGGED for now. Plug your laptop into ether2.
#
#  3. Edit the SETTINGS block below.
#
#  4. Paste this whole file into a Winbox terminal. Watch for red text.
# =====================================================================

# ---------------------------- SETTINGS -------------------------------
# Public WiFi Fiti app that captive customers must be able to reach before
# they sign in. Keep this on app.wififiti.co.ke for the hosted service.
:global portalHost  "app.wififiti.co.ke"

# Optional legacy local-app address. Keep it only when this router also uses
# a billing computer on the trusted LAN; it is not the customer portal host.
# Find a Mac address with: ipconfig getifaddr en0
:global portalIp    "192.168.0.75"
:global portalPort  "3000"

# Password for the billing app's API account. Make it long and random,
# and do NOT reuse your admin password.
:global apiPassword "CHANGE-ME-LONG-RANDOM"

# The network your main router hands out. Your Mac and Windows box live
# here. Used to permit API access from the trusted side only.
:global trustedLan  "192.168.0.0/24"

# The hotspot's own network. Must not overlap trustedLan.
:global hsNet       "10.5.50"

# What customers see in their WiFi list.
:global hotspotSsid "WiFi Fiti"
# ---------------------------------------------------------------------

# --- Identity ---------------------------------------------------------
/system identity set name=wifi-fiti
/system clock set time-zone-name=Africa/Nairobi
/system ntp client set enabled=yes

# --- Radio ------------------------------------------------------------
# Open network on purpose: the captive portal is the gate, not a WPA key.
/interface wireless security-profiles
set [find default=yes] mode=none

# If your RouterOS build rejects "kenya", delete that line and re-run
# this command. Everything else is unaffected.
/interface wireless
set [find default-name=wlan1] mode=ap-bridge band=2ghz-b/g/n \
    ssid="$hotspotSsid" disabled=no country=kenya distance=indoors \
    wireless-protocol=802.11

# --- Bridge the hotspot side -----------------------------------------
/interface bridge
add name=bridge-hs protocol-mode=none comment="WiFi Fiti hotspot"

/interface bridge port
add bridge=bridge-hs interface=ether2
add bridge=bridge-hs interface=ether3
add bridge=bridge-hs interface=ether4
add bridge=bridge-hs interface=wlan1

# --- WAN: takes an address from your main router ----------------------
/ip dhcp-client
add interface=ether1 disabled=no add-default-route=yes use-peer-dns=yes \
    comment="uplink to main router"

# --- Hotspot addressing -----------------------------------------------
/ip address
add address="$hsNet.1/24" interface=bridge-hs comment="hotspot gateway"

/ip pool
add name=hs-pool ranges="$hsNet.10-$hsNet.250"

/ip dhcp-server
add name=hs-dhcp interface=bridge-hs address-pool=hs-pool \
    lease-time=1h disabled=no

/ip dhcp-server network
add address="$hsNet.0/24" gateway="$hsNet.1" dns-server="$hsNet.1"

/ip dns
set allow-remote-requests=yes servers=8.8.8.8,1.1.1.1 cache-size=2048KiB

/ip firewall nat
add chain=srcnat out-interface=ether1 action=masquerade \
    comment="hotspot NAT"

# --- Hotspot ----------------------------------------------------------
/ip hotspot profile
add name=hsprof hotspot-address="$hsNet.1" dns-name=fiti.connect \
    html-directory=hotspot login-by=http-chap,http-pap use-radius=no

/ip hotspot
add name=hotspot1 interface=bridge-hs address-pool=hs-pool \
    profile=hsprof addresses-per-mac=2 idle-timeout=10m \
    keepalive-timeout=5m disabled=no

# --- User profile -----------------------------------------------------
#  rate-limit is upload/download per user.
#  Each paid device gets its own MAC-bound user. shared-users=1 prevents
#  copied credentials from opening another device slot.
#  mac-cookie means a returning customer with time left skips the portal
#  entirely - the single biggest UX win available here.
/ip hotspot user profile
add name=standard rate-limit=3M/3M shared-users=1 \
    add-mac-cookie=yes mac-cookie-timeout=1d \
    status-autorefresh=1m transparent-proxy=no

# Give packets delivered to a customer a TTL of 1. The customer's own
# device can use them, but a phone forwarding them to a tethered client
# decrements the TTL to zero and drops them. This blocks ordinary hotspot
# sharing; MAC/TTL spoofing can never be made impossible on consumer gear.
/ip firewall mangle
add chain=postrouting out-interface=bridge-hs action=change-ttl \
    new-ttl=set:1 passthrough=yes comment="WiFi Fiti anti-tethering"

# --- Walled garden ----------------------------------------------------
#  An unauthenticated phone must reach the portal, or the payment flow
#  dead-ends before it starts.
/ip hotspot walled-garden
add dst-host="$portalHost" action=allow comment="WiFi Fiti live app"
add dst-host="$portalIp" action=allow comment="legacy local portal compatibility"

/ip hotspot walled-garden ip
add dst-address="$portalIp" action=accept comment="legacy local portal compatibility"

# --- API account for the billing app ----------------------------------
#  Least privilege, and reachable only from your trusted LAN.
/user group
add name=billing policy=api,read,write,test,winbox comment="WiFi Fiti app"

/user
add name=hotspot-api group=billing password="$apiPassword" \
    address="$trustedLan" comment="WiFi Fiti billing service"

/ip service
set api disabled=no port=8728 address="$trustedLan"
set api-ssl disabled=no port=8729 address="$trustedLan"
set telnet disabled=yes
set ftp disabled=yes
set www-ssl disabled=yes

# --- Protect the router itself ----------------------------------------
/ip firewall filter
add chain=input action=accept connection-state=established,related \
    comment="established"
add chain=input action=accept in-interface=bridge-hs protocol=udp \
    dst-port=53 comment="hotspot DNS"
add chain=input action=accept in-interface=bridge-hs protocol=tcp \
    dst-port=53 comment="hotspot DNS"
add chain=input action=accept in-interface=bridge-hs protocol=udp \
    dst-port=67 comment="hotspot DHCP"
add chain=input action=accept in-interface=bridge-hs protocol=tcp \
    dst-port=80,443,64872,64873 comment="hotspot portal"
add chain=input action=drop in-interface=bridge-hs \
    comment="customers get nothing else from the router"

# --- Keep 16MB of flash from filling up -------------------------------
/system logging action
set memory memory-lines=200
set disk disabled=yes

:put ""
:put "Config applied."
:put "1. Plug ether1 into a LAN port on your main router."
:put "2. Upload login.html to /hotspot via Winbox > Files."
:put "3. Find this router's WAN address: /ip address print"
:put "   That address goes in MIKROTIK_HOST in your .env"
