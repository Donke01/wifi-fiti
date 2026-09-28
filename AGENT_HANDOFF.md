# Wi-Fi Fiti — agent handoff

This repository is the source of truth for Wi-Fi Fiti. Work from the `main`
branch and do not put production secrets, router keys, database files, or
`.env` files into Git or support messages.

## Handover — 28 Sep 2026, evening (read this first)

### Where the code is

- `main` is deployed on Railway (cloud.wififiti.co.ke). Merged and live today:
  PR #10 `map-wifi`, PR #11 (owner's Wi-Fi kept, one-step setup, restart
  reports), then `setup-polish`, `poll-guard`, `lighter-reports` and
  `faster-connect` (latest merge `8533043`).
- **Branch `stage3-finish` is pushed but NOT merged.** It includes
  `change-follow` and closes stage 3 (see below). The full suite passes, and
  the map was checked in a browser against a local seeded server at 1280 px
  and 390 px. It still needs a real-router test of "add Wi-Fi to a running
  hotspot". Merge only when the owner says **"push"**.
- `test/ceiling.js` flakes with the clock; rerun it before assuming a failure.
- **Don't apply `changes.diff`** (repo root). It turns on remote access and
  the VPN automatically, without the owner's explicit consent, which the
  Architecture section forbids. Offer the owner to delete it.

### Stage 3 (network changes from the map): status

Proven on real routers:
- RB951: PPPoE bridge with ports moved into it, rename, verify.
- hAP lite: one-step setup (hotspot + customer Wi-Fi + cable ports, one
  Ethernet port kept for the owner), verified, phone got the login page.
- RB951: hotspot + Wi-Fi "CLOUDNET" on bridge DON from the map, verified.
- Restart during a change: the startup guard undid it and the dashboard
  said so (`rebooted_start`).
- Undo on the RB951 (hotspot + Wi-Fi "CLOUDNET", change 9): finished on the
  router within seconds, ports and wlan1 free again.

On `stage3-finish` (not live yet):
1. **Wi-Fi added to a hotspot that already runs**: new change kind `wifi`
   (job `wifi`).
   - Validation: `existing[].wifi = { ssid, radio }` on the bridge running
     the hotspot. A saved plan stores `{ ssid, radios: [...] }`, and both
     forms are accepted.
   - Script: preflight (bridge still there, hotspot still on it
     (`hotspot_missing`), no VLAN filtering, radio still free), the radio's
     settings are saved first, then takeover or virtual AP, then the port is
     added to the bridge.
   - Undo removes only the Wi-Fi. The hotspot bridge's own change can't be
     undone while that Wi-Fi is there.
   - `matchesLayout` verifies the radio (or VAP) is in the bridge. A radio
     already on the air is not added twice.
   - UI: a Wi-Fi panel on the running hotspot's card.
2. **The one-step card comes back** after a failed, reverted, cancelled,
   no-answer or undone try. Saved bridges from those changes are dropped
   from the draft.
3. **"+ Hotspot bridge" is disabled** while a hotspot runs or the map
   already has one, with a note; the same for a second PPPoE network.
4. **The change follow never stops** when the tab is hidden or the map is in
   use (the dashboard stayed on "Undoing…"). The undo timer counts from the
   undo, not from the original change.
5. Also: a gap between the "Reserve a port" card and the first bridge card.
   The Analytics and Customers "All locations" options now have `value=""`;
   before, the Customers page filtered out every customer and analytics got
   a 400.

6. After an independent review:
   - Apply builds the changes from the freshly re-checked plan, so a radio
     switched on since the map was saved gets a separate network and is
     never taken over.
   - A takeover preflight requires the radio to be switched off
     (`radio_busy`), except a radio moved out of a Wi-Fi Fiti bridge.
   - The undo keeps the saved radio settings until it has proven the radio's
     on/off state is back.

Left for later: band/channel choice for customer Wi-Fi, and a hardware test
of the RouterOS 7 `wifi` package (hAP ax etc.; code exists, untested).

### Other work merged today (all live)

- **Router clock fix**: `/router-time` plus a short "clock fix" paste under
  "cert not valid (before: …)". The installed kit switches on NTP when it is
  off. Boards without a clock battery (hAP lite) lose the date on restart.
- **Small routers** (the hAP lite ran at 100% CPU, kernel failures,
  console crashes):
  - One poll at a time: the scheduler's on-event runs `fiti-poll` only when
    no `fiti-poll` job is running. Installed routers get this through the
    poll tuning.
  - A change travels alone in the reply and waits for 3 MiB free memory
    (`low_memory`).
  - The layout report runs every 25 s only within 2 min of the owner viewing
    the router, otherwise every 10 min.
  - A pending portal update polls fast for 2 min at most.
  - Result: hAP lite 100% → 39% CPU.
- **Faster connection after payment**: the router polls every 1 s while a
  customer is paying (`tenant.paymentInProgress`). The portal checks every
  1 s once paid.
- **`[payment timing]` log line** per paid login: prompt→paid, paid→sent,
  sent→confirmed. The owner reports payments now connect quickly. Tuma has no
  status API, so a slow "prompt→paid" is Tuma's side.

### The owner's routers

- **KITALE location, business ACHIENG, router "CLOUDNET"**: RB951Ui-2HnD,
  RouterOS 7.24.2. The owner says it is his own router with no customers and
  asked to test on it. After today's Undo it has no hotspot. ether5 is
  reserved for him.
- **SIRENDE, hAP lite**, RouterOS 7.24.1, 32 MB: restarted by itself twice
  today (kernel failure, out of memory). The owner asked to leave it alone
  for now.
  - Advice given: use boards with 64 MB or more for customer sites.

### Next steps (in this order)

1. The owner says "push" → merge `stage3-finish`, check the live
   business.html.
2. On the RB951: one-step setup cable-only (no Wi-Fi), then add Wi-Fi to the
   running hotspot from its card, check a phone gets the login page, then
   Undo the Wi-Fi only.
3. Then: "Add TV" not showing in the customer portal, and the other open
   items (regenerate the exposed Daraja sandbox key, replace placeholder
   router API credentials).

### Working with the owner (Don)

- Plain, short, step by step. He is not a network engineer.
- His goal: a seamless, lightweight kit that never keeps clients waiting.
- He tests in Firefox (read-only to agents; ask for screenshots) and has
  the dashboard in Chrome. Agents can use Claude in Chrome in its own tab
  group; it is signed in to the ACHIENG business.
- Working convention:
  - One feature branch per task, pushed with `-u`.
  - Commit messages end with the Co-Authored-By line.
  - Keep the old "automatic" and full kits as a fallback. The universal kit
    (`bootstrap vlan=1`) is the default.
- To run every test one by one, run each `node …` command from the `test`,
  `test:tenant` and `test:tenant:http` scripts in package.json.

### Don't break

- The existing network of any onboarded router: every change needs a
  preflight, an undo-first script and a boot guard. The guard reports back
  after a restart.
- The owner's own Wi-Fi: never reconfigure a radio that is on. Use a
  virtual AP.
- One poll at a time (`POLL_GUARD_EVENT`).
- A change alone in its reply.
- Draft persistence (`networkPlanDrafts`, `quickSetupNames`). Redraws are
  skipped while an input has focus or the review is open.
- Test fixtures: plans with a radio in a hotspot bridge need
  `wifi: { ssid }`.

### Reference: stage 3 change order on the router

1. Read-only preflight, including free memory.
2. Write `fiti-undo-<id>`.
3. Write `fiti-step-<id>` and `fiti-reboot-<id>`.
4. Add the startup guard `fiti-revert-<id>`.
5. Run the body inside on-error → undo, updating the step as it goes.
6. Loop until the cloud answers "confirmed". Without that answer the router
   undoes the change and reports `reverted`.
7. Report `kept` and send a fresh layout report. The status becomes
   `verified` or `mismatch`.

Timeouts are 8 min for sent and 10 min for confirming.

## What is live

- Marketing site: `https://wififiti.co.ke`
- Application, tenant dashboard, customer portal API, M-Pesa callbacks, and
  router polling: `https://cloud.wififiti.co.ke`
- GitHub: `https://github.com/Donke01/wifi-fiti`
- Railway uses a persistent volume mounted at `/data`; production must set
  `DATABASE_PATH` inside that volume.

## Architecture

Customer MikroTik routers make authenticated **outbound HTTPS** requests to
the cloud. Wi-Fi Fiti does not expose public WinBox, API, or SSH.

```text
MikroTik ── outbound HTTPS poll ──> cloud.wififiti.co.ke
MikroTik ── outbound WireGuard ──> Wi-Fi Fiti VPN gateway
VPN gateway ── outbound HTTPS ──> cloud.wififiti.co.ke
```

The WireGuard path is private management only. Customer internet traffic and
payments do not travel through it. Each router receives its own key and
management address only after a verified cloud check-in and explicit owner
consent; never embed a shared VPN private key or gateway peer in a generic
RouterOS kit.

## Router onboarding contract

There are intentionally separate paths:

- **Existing Hotspot router:** preserve WAN, Wi-Fi, DHCP, bridge membership,
  Hotspot, NAT, and administrator credentials. Install Wi-Fi Fiti polling and
  captive-portal assets only after validating the saved bridge and Hotspot.
- **New/reset router:** use the full generated `.rsc` kit. It is the only
  safe path that can create customer Wi-Fi and WAN configuration.
- **One-line installer:** the dashboard generates a location-specific
  `fetch → import → cleanup` command for an existing Hotspot router. It calls
  `GET /api/router/v1/bootstrap?site=loc-…` with the router token in
  `X-WiFi-Fiti-Router`, never in a URL query parameter.

The bootstrap endpoint is header-authenticated, returns `Cache-Control:
no-store`, and is restricted to saved `existing` setup. It must not reset the
router or change passwords, WAN, Wi-Fi, DHCP, bridge topology, NAT, RouterOS
services, or fixed WireGuard configuration.

## Current onboarding UX

The business dashboard uses a focused three-step journey:

1. Add router
2. Secure connection
3. Map router

Owners can go back without losing configuration, pause and resume onboarding,
and remove only an unused, unpaired router. Removal deletes the cloud draft
and pairing credential after an explicit confirmation; it never resets the
physical router. Once a router has contacted Wi-Fi Fiti or has customer
history, the safe alternative is **Start router setup again**, which stages a
replacement rather than deleting records.

## Verification

```sh
npm test
git diff --check
```

The focused tenant suite is also available as:

```sh
npm run test:tenant
```

Before deploying, verify the generated dashboard text from the live service:

```sh
curl --http1.1 -fsSL --connect-timeout 8 --max-time 25 \
  'https://cloud.wififiti.co.ke/business.html?cache-check=1'
```

## First steps for the next agent

```sh
git pull --ff-only origin main
npm install
npm test
```

Read these first:

- `src/server.js` — HTTP routes and tenant/router controls
- `src/lib/tenant.js` — durable tenant, token, subscription, and VPN state
- `src/lib/router-setup.js` — safe RouterOS kit generation
- `public/tenant-router-install.rsc` — router-side polling installer
- `public/business.html` — dashboard and guided onboarding UI
- `vpn-gateway/` — VPS WireGuard gateway reconciler

## Operational cautions

- Never ask a user to paste a router token, VPN private key, M-Pesa secret,
  SSH private key, or third-party bearer token into chat.
- A successful M-Pesa payment becomes connected only after the paired router
  polls, runs the queued job, and acknowledges it.
- Do not treat a router `fetch` failure as evidence that a payment failure
  occurred; inspect the pairing, DNS, time, CA trust, and scheduler state.
- Do not use a generic static RouterOS script for every board. The automatic
  and full-kit paths validate runtime interfaces and preserve known-safe
  existing-router configuration.
