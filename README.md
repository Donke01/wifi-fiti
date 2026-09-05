# WiFi Fiti

M-Pesa pay-as-you-go WiFi for a MikroTik hAP lite TC. A customer connects,
picks a package, gets an STK prompt, enters their PIN, and is online. No
vouchers, no manual verification, no screenshots on WhatsApp.

The original single-site flow remains supported. **WiFi Fiti for Business**
adds a separate, multi-tenant control centre so independent hotspot operators
can run their own locations, packages, customer payments, vouchers and
routers without seeing each other's customers or sales.

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

## WiFi Fiti for Business

This is an independently built, Pawa-inspired operating model: a business
subscribes for the capacity it needs, pairs its own routers, and runs its own
customer portal. It does not reuse Pawa branding, code, accounts or customer
data.

Open `/business.html` on your WiFi Fiti domain to create an operator account
or sign in. A newly registered business starts with a 14-day trial. The
control centre is designed around this operating sequence:

1. **Register the business.** The owner creates a business account and
   chooses a collection mode and subscription plan.
2. **Add a location.** Give each physical hotspot its own name and MikroTik
   hotspot-server name. Locations are isolated: their router jobs,
   subscriptions, vouchers, customer devices and sales never mix with another
   business or location.
3. **Copy the one-time pairing kit.** The dashboard provides the customer
   portal URL and RouterOS commands for that location. Paste them into the
   location's router while logged in as its administrator. The router polls
   WiFi Fiti over outbound HTTPS, so it can stay behind NAT without exposing
   its administration API to the internet. If the customer bridge has a name
   other than `bridge-hs`, replace the `fitiBridge` value in the kit before
   pasting it.
4. **Verify the portal.** The pairing kit allows the WiFi Fiti domain through
   the hotspot walled garden and enables the router polling job. From a fresh,
   unauthenticated phone, join the Wi-Fi and confirm the location portal opens
   at `/p/<location-id>`.
5. **Sell and support.** The customer portal shows that business's packages,
   starts M-Pesa collection, restores interrupted payment screens, remembers
   a wall-clock subscription, supports voucher redemption and lets the payer
   move an existing package to the current phone. One optional TV can share a
   subscription; it does not turn a purchase into a general shared hotspot.

### Subscription plans and business billing

The included commercial tiers are capacity plans, not a charge for every
router command:

| WiFi Fiti plan | Monthly price | Included capacity |
|---|---:|---|
| Starter | KES 1,500 | 2 routers, up to 2,000 monthly active devices |
| Growth | KES 3,500 | 5 routers, up to 5,000 monthly active devices |
| Custom | Quote | Bespoke router and active-device capacity |

The dashboard measures monthly active devices from subscriptions issued at
paired locations. A paid plan change is deliberately not applied when an STK
prompt is merely sent: it becomes active only after the M-Pesa payment is
confirmed. Confirmation grants 30 days from the later of the current expiry
or the confirmation time, so an early renewal is not lost. A custom plan is
arranged with WiFi Fiti rather than charged automatically.

If a business plan expires or is suspended, the platform stops that business
from taking **new** customer payments. Existing paid customer subscriptions
keep their already-issued wall-clock expiry. The business's platform plan and
a customer's Wi-Fi package are therefore two separate subscriptions.

### Customer M-Pesa collection

A business chooses one of these modes in the control centre:

- **Own M-Pesa** — the business connects its own Daraja application,
  shortcode and passkey. WiFi Fiti verifies the credentials before saving
  them, encrypts them at rest, and does not return them to the browser.
- **WiFi Fiti collection** — customer STK payments use the platform Daraja
  account. The business dashboard records the platform service fee alongside
  its sales, while WiFi Fiti handles the payment reconciliation and router
  provisioning path.

Selecting either option alone does not make live payments work. The platform
needs valid Daraja credentials, a valid shortcode/Till or Paybill, a passkey,
and a public HTTPS callback URL. A business can only use **Own M-Pesa** after
the platform has set `TENANT_SECRETS_KEY` and its supplied credentials pass
verification. Sandbox settings are for testing; they do not collect real
money.

### Pairing-token safety

Each location receives a high-entropy router token exactly once: when the
location is created or when its token is rotated. WiFi Fiti keeps only a hash
of that token, so it cannot be redisplayed later. Treat the one-time pairing
kit like a router password: paste it directly into the intended router, do not
put it in screenshots, tickets or chat groups, and rotate it immediately if it
is copied, a router is replaced, or it was sent to the wrong person.

---

## Railway and production configuration

For a Railway deployment, mount a persistent volume at `/data` and set:

```bash
DATABASE_PATH=/data/hotspot.db
TENANT_SECRETS_KEY=<a long, stable random value>
PUBLIC_URL=https://your-public-wifi-fiti-domain
```

Generate the tenant key once with `openssl rand -base64 48`. Keep it in
Railway's secret variables, never in Git, and do not rotate it casually: it
encrypts connected businesses' Daraja credentials and changing it without a
credential-migration process would make those connections unreadable.

Also set the platform `MPESA_*` values to real production Daraja credentials
before offering WiFi Fiti collection or automated business-plan billing. The
callback endpoint must be reachable over public HTTPS. Keep the database on
the `/data` volume; a Railway redeploy without that volume loses transaction,
subscription, router-pairing and billing records.

Routers need outbound DNS and HTTPS access to the public WiFi Fiti domain. Do
not solve a connection problem by opening MikroTik's API port (`8728`) to the
internet; use the polling pairing model or a properly secured VPN.

---

## Changing what you sell

`src/packages.js` is the only file to edit for prices and durations.
That applies to the original single-site portal. Business operators manage
their own packages in the WiFi Fiti for Business control centre, where those
packages remain scoped to their business.
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
