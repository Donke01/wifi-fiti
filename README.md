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
   Safaricom  ──────▶ cloud.wififiti.co.ke │  STK push + callback
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
router via Winbox → Files. For the hosted service, leave that script's
`portalHost` set to `cloud.wififiti.co.ke`; business locations should then use
their dashboard pairing kit for outbound router polling.

---

## WiFi Fiti for Business

This is an independently built, Pawa-inspired operating model: a business
subscribes for the capacity it needs, pairs its own routers, and runs its own
customer portal. It does not reuse Pawa branding, code, accounts or customer
data.

Open `https://cloud.wififiti.co.ke/business.html` to create an operator account
or sign in. A newly registered business starts with a 14-day trial. The
control centre is designed around this operating sequence:

1. **Register the business.** The owner creates a business account and
   chooses a collection mode and subscription plan.
2. **Set the customer portal identity.** Choose the portal name, support
   phone, colour, short message and optional logo. The logo is served from the
   cloud portal domain, so it remains available behind the Hotspot walled
   garden.
3. **Use the router wizard.** Give each physical hotspot its location name,
   model, bridge and Hotspot-server name. A new/reset RouterOS 7 kit creates
   Wi-Fi, DHCP, NAT, Hotspot and cloud pairing. An existing-Hotspot kit first
   verifies the selected bridge and server, then preserves its WAN, Wi-Fi and
   DHCP settings while adding WiFi Fiti pairing.
4. **Copy or import the one-time kit.** The router polls WiFi Fiti over
   outbound HTTPS, so it stays behind NAT without exposing its administration
   API to the internet. New-router kits never reset a router or change its
   administrator password; the owner must set and save that password through
   the normal RouterOS process. The kit blocks WAN management and keeps
   retrying cloud pairing until WAN/DNS is ready. The dashboard defaults to
   the existing-Hotspot path and requires an explicit fresh-router
   confirmation before generating a new-network kit. Paste the complete kit
   in one operation or import the downloaded `.rsc` file; do not execute it
   line by line, because the installer intentionally keeps local variables in
   one RouterOS transaction and stops on the first preflight error.
5. **Verify the portal.** From a fresh unauthenticated phone, join the Wi-Fi
   and confirm the location portal opens at the address shown in the dashboard
   (or the cloud `/p/<location-id>` fallback before the optional edge gateway
   is enabled). The dashboard changes the router state to online after its
   first cloud check-in.
6. **Sell and support.** The customer portal shows that business's packages,
   starts M-Pesa collection, restores interrupted payment screens, remembers
   a wall-clock subscription, supports voucher redemption and lets the payer
   move an existing package to the current phone. One optional TV can share a
   subscription; it does not turn a purchase into a general shared hotspot.

The new/reset templates currently cover hAP lite / RB941, RB951Ui, other
RouterOS 7 legacy-wireless hardware, and RouterOS 7 devices using the modern
WiFi interface. Select the actual interface names shown in WinBox. A router
with live customers should always use the existing-Hotspot path.

### Package speed limits

Each customer package can optionally include a simple speed setting such as
`2M/5M` (upload/download). RouterOS interprets the two numbers as receive and
transmit from the router's perspective: customer upload first, then customer
download. Use `k` or `M`, such as `512k/2M`. Leave it blank to use the router's
normal Hotspot profile speed.
WiFi Fiti snapshots a chosen package's speed when the customer pays or redeems
a voucher, then sends it to RouterOS with that customer account. The linked TV
gets the same **per-device** cap; it is not a shared aggregate bandwidth cap
across both devices. Editing a package affects future sales; a later top-up
adopts the newly selected package speed, or restores the normal profile speed
if that package is blank.

### Operations and payouts

`/operations.html` gives an operator customer history, support tickets and
confirmed platform-plan receipts. It also tracks customer money collected by
WiFi Fiti and lets the operator submit a payout request. Payout requests are
an internal record and reservation only: this application **does not transfer
money**, verify bank disbursements, or automate refunds or chargebacks. A
platform staff member must independently verify a destination and record the
external reference before marking a payout paid. The platform desk is at
`/operations.html?admin=1` and requires a strong `ADMIN_TOKEN`; do not share
that token with an operator.

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
location is created or when a replacement kit is generated. WiFi Fiti keeps
only a hash of that token, so it cannot be redisplayed later. A replacement
token is staged for 24 hours: the live router remains online until the new kit
checks in, then the old token is retired. Treat every one-time pairing kit like
a router password: paste it directly into the intended router and do not put it
in screenshots, tickets or chat groups.

---

## Two-stage router onboarding

WiFi Fiti intentionally separates **getting a router online** from optional
remote support:

1. The owner connects a new or existing router to the internet and imports its
   one-time pairing kit locally. This first physical step is unavoidable: an
   unconfigured router has no safe path for us to reach it remotely.
2. The router completes an authenticated outbound HTTPS poll. Billing,
   provisioning and customer service now work without exposing a management
   service to the public internet.
3. The owner can explicitly request managed remote setup from the location
   card. The platform records consent, approval, allocation and revocation as
   separate audited states. After platform configuration, the router receives
   a narrowly-scoped prepare command through its normal poll: it creates a
   **disabled** native WireGuard interface and reports only its public key.
   The owner can withdraw consent at any time; the router must acknowledge the
   matching cleanup command before a replacement support identity can be used.

The polling path remains the product's source of truth. A support connection
must never carry customer browsing traffic or be required for payment
fulfilment. A router with no remote-support consent continues working normally.

The generated RouterOS kit includes a dormant native WireGuard support
bootstrap. It is disabled by default, stores no private VPN material in the
WiFi Fiti database, and never opens WinBox, SSH, API, a route, a peer, or a WAN
port. Its separate control queue cannot acknowledge, delay or modify customer
HotSpot jobs. Revocation disables the tagged retry schedule and removes only
the tagged support interface; it never changes billing, the Hotspot, firewall
or normal WiFi Fiti polling. When a dedicated management gateway is later
provisioned, the approved router can report only its generated public key over
the existing authenticated
HTTPS connection. The gateway then has to allocate a unique `/32` management
address and enforce one-router-per-peer isolation.

Do not claim that the `configured` dashboard state means a VPN is live: until a
separate UDP WireGuard gateway reports a handshake, it means only that secure
support inventory has been prepared. Railway remains the web, M-Pesa and router
polling host; run the future WireGuard gateway on a separate VPS or MikroTik
CHR with a stable public UDP endpoint.

---

## Public domains: root landing page and live cloud

WiFi Fiti uses two hostnames with deliberately different jobs:

| Address | Purpose |
|---|---|
| `https://wififiti.co.ke` | Public **WiFi Fiti for Business** landing page — product, pricing and trial invitation. During migration it also keeps only the legacy portal/API paths old routers need. |
| `https://cloud.wififiti.co.ke` | Live platform — business workspace, customer portals, router polling, installers and M-Pesa callbacks. |

The public landing is served at the root domain; the existing `business.html`
dashboard belongs on `cloud`. Do **not** point a captive portal at the root once
its router has been migrated: use `cloud` instead.

For Railway, keep the existing `wififiti.co.ke` custom domain attached and add
only `cloud.wififiti.co.ke` as the second custom domain on the same service. Add
the CNAME and verification TXT records Railway gives you; do not replace the
root domain's DNS record or guess a Railway IP address. If the current Railway
plan permits only one custom domain, upgrade to a plan that permits two before
adding `cloud`; replacing the root domain would disconnect existing routers.

Set these Railway variables together:

```bash
PUBLIC_URL=https://cloud.wififiti.co.ke
APP_URL=https://cloud.wififiti.co.ke
MARKETING_URL=https://wififiti.co.ke
LEGACY_HOST=wififiti.co.ke
```

`APP_URL` is the source for the dashboard, customer portal fallback and router
pairing API. `PUBLIC_URL` is the source for new M-Pesa callbacks; in production
it must be the same `cloud` URL. The optional Cloudflare gateway below adds a
separate customer-facing hostname without changing either value. If `APP_URL`
is omitted for an older or staging deployment, it safely falls back to
`PUBLIC_URL` rather than pointing routers at the production app. Existing
pending M-Pesa requests and old routers can continue to use the bare domain
because it remains on this service.
Business sign-in storage is per website origin, so operators should sign in
again at `cloud` after the switch. One-time pairing tokens should be copied again
or rotated there rather than moved through chat or screenshots.

### White-label tenant portal addresses with Cloudflare

When the optional edge gateway is enabled, the domains have three separate
jobs. Railway still hosts the first two; Cloudflare only serves customer portal
traffic on the wildcard.

| Address pattern | Service | Job |
|---|---|---|
| `wififiti.co.ke` | Railway | WiFi Fiti for Business landing page |
| `cloud.wififiti.co.ke` | Railway | Dashboard, SQLite data, M-Pesa callbacks, router polling and installers |
| `tenant-name.wififiti.co.ke` | Cloudflare Worker | The tenant's branded customer payment portal |

There is no per-tenant DNS record: one proxied wildcard record and one Worker
route serve every registered first-level tenant address. The Worker is a
restricted gateway, not a second backend. It asks `cloud` to resolve the
hostname and can proxy only that location's customer portal, logo and
`/api/tenant/<location>` routes. It cannot proxy dashboard, router, M-Pesa or
admin routes.

**Do not add the wildcard record yet** on a live system. Use this order:

1. Deploy this code to Railway with `PORTAL_GATEWAY_ENABLED=false` (and
   initially leave `PORTAL_ROOT_DOMAIN` and `EDGE_GATEWAY_SECRET` empty).
   Existing routers and portals remain on `cloud`.
2. Deploy `edge/portal-gateway` to Cloudflare. Set its `EDGE_GATEWAY_SECRET`
   secret to a new value generated with `openssl rand -hex 32`.
3. Move the **DNS zone** (not the hosting) for `wififiti.co.ke` to Cloudflare.
   Copy every existing Railway CNAME/verification TXT record and all MX, SPF,
   DKIM and DMARC records before changing nameservers. Confirm root, `cloud`,
   email, M-Pesa callbacks and router polling still work.
4. Add the proxied wildcard A record `* → 192.0.2.0`, then attach
   `*.wififiti.co.ke/*` to the Worker. Add explicit no-Worker exclusions for
   `cloud.wififiti.co.ke/*` and every other existing website hostname. This is
   a release gate: immediately open `https://cloud.wififiti.co.ke/api/health`.
   It must still return the Railway application response. If it returns a
   Worker error or a portal-not-found page, fix the `cloud` no-Worker exclusion
   before continuing; otherwise the Worker can recursively call itself.
5. Only after the wildcard and both route exclusions have been checked, set
   these Railway variables and redeploy:

   ```bash
   PORTAL_ROOT_DOMAIN=wififiti.co.ke
   EDGE_GATEWAY_SECRET=<the same value stored in the Worker>
   PORTAL_GATEWAY_ENABLED=true
   ```

6. Test one newly created location from an unauthenticated phone. Its new kit
   keeps `fitiUrl=https://cloud.wififiti.co.ke` for polling, but allows its
   specific tenant hostname in the Hotspot walled garden. Re-import a fresh
   kit for each existing router one at a time; old kits intentionally keep
   redirecting to `cloud` until then.

The dashboard lets a tenant choose a managed first-level address. Changing it
keeps the former hostname as a live alias so an already paired router does not
break; each location is limited to three active addresses, after which support
can retire an old one. Tenant-owned domains are a later feature: they need DNS
ownership verification and certificate lifecycle management, not merely a
CNAME.

After the variables are deployed, normal visitors to the root domain see the
public landing page. A legacy Hotspot redirect carrying RouterOS values such as
`?mac=...`, plus legacy `/api/*` and `/p/*` requests, remains available only
for the migration period so no existing customer or pending payment is cut off.

### Move an existing router safely

Do this one router at a time, after `cloud` has valid HTTPS:

1. **Allow the cloud host first.** Add `cloud.wififiti.co.ke` to the Hotspot
   walled garden before changing the login page. An unauthenticated customer
   otherwise cannot reach the new captive payment page. On a legacy router:

   ```routeros
   :if ([:len [/ip hotspot walled-garden find where dst-host="cloud.wififiti.co.ke"]] = 0) do={ /ip hotspot walled-garden add dst-host="cloud.wififiti.co.ke" comment="WiFi Fiti live cloud" }
   ```
2. **Update the login redirect.** Upload the current `routeros/login.html` as
   the router's `hotspot/login.html`. It points to
   `https://cloud.wififiti.co.ke/legacy`.
3. **Move router polling.** For a legacy router, re-run the current
   `routeros/poll-setup.rsc` with its existing site ID and token. For a
   business location, sign in at `cloud`, rotate its router token to generate a
   fresh pairing kit, and paste it into the router. Changing only a live
   `fitiUrl` global is not enough: the router's boot script restores its saved
   settings after reboot.
4. **Verify.** Join the Wi-Fi as an unauthenticated customer, make sure the
   payment page loads from `cloud`, then run `/system script run fiti-poll` and
   inspect `/log print where message~"fiti"` on the router.

Keep the legacy root API paths live until every router has been tested and old
pending payments have settled. Do not use a browser-only redirect for router
polling or M-Pesa callbacks: they must keep reaching the same backend directly.

---

## Railway and production configuration

For a Railway deployment, mount a persistent volume at `/data` and set:

```bash
DATABASE_PATH=/data/hotspot.db
TENANT_SECRETS_KEY=<a long, stable random value>
PUBLIC_URL=https://cloud.wififiti.co.ke
APP_URL=https://cloud.wififiti.co.ke
MARKETING_URL=https://wififiti.co.ke
LEGACY_HOST=wififiti.co.ke
```

Generate the tenant key once with `openssl rand -base64 48`. Keep it in
Railway's secret variables, never in Git, and do not rotate it casually: it
encrypts connected businesses' Daraja credentials and changing it without a
credential-migration process would make those connections unreadable.
The same key encrypts temporary router setup kits for the **Copy one-line
installer** action. If it is absent, the dashboard explains that secure
installer storage is unavailable and offers the full `.rsc` download.
After adding the key, redeploy and generate a fresh connection kit. Existing
saved kits do not automatically become downloadable through the short installer.

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
The normal package speed and device limit live on the router:

```
/ip hotspot user profile set standard rate-limit=5M/5M shared-users=1
```

`shared-users=1` stops one purchase covering a whole hostel. `2` is a
reasonable default — a phone and a laptop.

When an operator sets a package-specific speed in the business dashboard,
WiFi Fiti creates a reusable `fiti-*` HotSpot user profile once per speed,
on that router and assigns the customer to it. RouterOS v7 applies
`rate-limit` on HotSpot user profiles, not directly on HotSpot user records.

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
