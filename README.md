# WiFi Fiti

M-Pesa pay-as-you-go WiFi for a MikroTik hAP lite TC. A customer connects,
picks a package, gets an STK prompt, enters their PIN, and is online. No
vouchers, no manual verification, no screenshots on WhatsApp.

Package durations are wall-clock subscriptions: time starts as soon as the
payment is confirmed and continues whether the customer is online or offline.
Refreshing the portal reads the same persisted expiry from the server.

```
                    ┌─────────────────────┐
   Safaricom  ──────▶  this app (public)  │  STK push + callback
                    │  Node + Express     │
                    └──────────┬──────────┘
                               │ RouterOS API :8728
                    ┌──────────▼──────────┐
   Internet ────────▶  hAP lite TC        │  captive portal, DHCP, NAT
                    │  ether1 = WAN       │
                    └──────────┬──────────┘
                               │ ether2
                    ┌──────────▼──────────┐
                    │  Archer AX72 (AP)   │  radios only, DHCP off
                    └──────────┬──────────┘
                          customers
```

---

## The one thing to decide first

The app must be reachable **from Safaricom** on public HTTPS, and it must
reach **the router** on a private LAN address. Those pull in opposite
directions, and it traps most people.

**For a single site:** run the app on a Raspberry Pi or old laptop plugged
into the hAP lite, and expose only the callback with a Cloudflare Tunnel
(free, no port forwarding, real certificate). The router is a LAN hop away
and nothing sensitive faces the internet.

**If you host in the cloud** (Railway, Render, a VPS): the router must dial
out to you over WireGuard or L2TP/IPsec, and `MIKROTIK_HOST` becomes the
tunnel address. Do **not** port-forward 8728 to the open internet — that
port is an admin channel and it gets scanned.

---

## Setup

Full step-by-step is in the chat history. Short version:

```bash
cp .env.example .env    # fill in Daraja + MikroTik details
npm install
npm test                # 30 tests, no hardware needed
npm start
```

Then `GET /api/health` — it returns the router's board name and RouterOS
version if the API connection is good.

Router config is in `routeros/hotspot-setup.rsc` (edit the SETTINGS block
first). The redirect page `routeros/login.html` goes in `/hotspot` on the
router via Winbox → Files.

---

## Changing what you sell

`src/packages.js` is the only file to edit for prices and durations.
Speed and device limits live on the router:

```
/ip hotspot user profile set standard rate-limit=5M/5M shared-users=1
```

`shared-users=1` stops one purchase covering a whole hostel. `2` is a
reasonable default — a phone and a laptop.

---

## Rebranding

Colours are six CSS variables at the top of `public/index.html`. The
current palette is drawn from matatu livery: hard black keylines, offset
sticker shadows, route blue and hot pink, tuned for legibility on a cheap
Android screen in direct sun. Portal copy is Sheng and Swahili.

---

## How failures are handled

Payment systems are mostly failure handling. What's covered:

| What goes wrong | What happens |
|---|---|
| Callback never arrives | A sweep every 30s queries Daraja and recovers it |
| Callback arrives, router is down | Payment is banked; a sweep retries provisioning |
| Safaricom replays a callback | Transaction state and receipt both checked; no double credit |
| Customer cancels / wrong PIN / no funds | Specific message, no charge, no provisioning |
| Customer buys again with time left | The new package extends their existing expiry time |
| Customer disconnects or refreshes | The wall-clock subscription continues and shows the same expiry |
| Auto-login fails on a stubborn phone | Credentials still work and are shown on screen |

The reconciliation sweep in `src/server.js` is not optional. Without it,
every lost callback is a customer who paid and got nothing.

---

## Before taking real money

- [ ] `MPESA_ENV=production` with the live shortcode and passkey
- [ ] `DATABASE_PATH` on a **persistent volume** — on Railway or Render the
      default filesystem is wiped on redeploy, taking payment records with it
- [ ] Router API restricted by source address (the script does this)
- [ ] A strong `hotspot-api` password that is not your admin password
- [ ] Walled garden verified: turn WiFi off and on, confirm an
      unauthenticated phone can load the portal over HTTPS
- [ ] Test with 1/= to yourself, end to end
- [ ] Know your refund process before you need it

---

## Capacity

The hAP lite handles a single site comfortably — roughly 20–40 people
actively browsing. Its ceiling is the 650MHz single core, 32MB of RAM and
100Mbps ports, not this software. When you outgrow it, move to a hEX or
hAP ax² and change one line in `.env`.

---

## Notes

The RouterOS API client in `src/lib/routeros-api.js` is written from
scratch rather than pulled from npm — the published clients are
unmaintained, and this protocol is small and frozen. Its length-prefix
codec is unit-tested across every boundary.
