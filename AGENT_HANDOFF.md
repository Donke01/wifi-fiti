# Wi-Fi Fiti — agent handoff

This repository is the source of truth for Wi-Fi Fiti. Work from the `main`
branch and do not put production secrets, router keys, database files, or
`.env` files into Git or support messages.

## Handover — 28 Sep 2026 (read this first)

### Where the code is

- `main` is deployed on Railway. It holds everything up to and including the
  glass kit look and the "Reserve a port for management" card, merge `2c11f7f`.
- The **`map-wifi`** branch is pushed but **not merged**. Its commit is
  `04a2983`, "Customer Wi-Fi on hotspot bridges".
  - The full suite passes on it. `test/ceiling.js` flakes with the clock
    sometimes; rerun it before assuming a failure.
  - Still to do before merging:
    1. Check the Wi-Fi panel in a browser, on desktop and phone widths.
    2. Test on a real hAP lite: a hotspot bridge with `wlan1` and an SSID.
       Then check that a phone sees the SSID and gets the login page.
    3. Undo the change and check that wlan1's old ssid, mode and security
       profile come back exactly.
  - Then merge to `main` and push. **Only merge or push to main when the
    owner says "push".**
- Working convention:
  - One feature branch per task, pushed with `-u`.
  - Commit messages end with the Co-Authored-By line.
  - Keep the old "automatic" and full kits working as a fallback. The
    **universal kit** (`bootstrap vlan=1`) is the default.
- To run every test one by one, run each `node …` command from the
  `test`, `test:tenant` and `test:tenant:http` scripts in package.json.
  Loop over them and print PASS or FAIL for each.

### What the universal kit does (proven on a real RB951 and hAP lite)

1. **Connect.** The connection kit is a ~314-character line: builtin trust
   store, a `fetch` with `check-certificate=yes` into `fiti.rsc`, then
   `/import`. The kit deletes `fiti.rsc` itself.
   - The router token travels only in the `X-WiFi-Fiti-Router` header over
     verified TLS, never in a URL.
   - The separate "certificate fix" step imports `/router-roots.pem` and
     keeps only certificates matching the SHA-256 pins in `ROUTER_ROOT_PINS`.
2. **Layout report.** The router sends a read-only inventory
   (`fiti-inventory`, `INVENTORY_AGENT=4`) about every 25 s, driven by poll
   replies.
   - There is deliberately no scheduler for it: the scheduler version never
     reported, and the cause is still unknown.
   - It is parsed by `parseRouterInventory` and `describeInventory` in
     `src/lib/router-topology.js`.
3. **Map.** The owner draws bridges on the routerboard map in
   `public/business.html`. `validateNetworkPlan` checks the plan: bridges,
   existing entries, moves, `keep` (up to 2 reserved management ports) and
   `wifi`.
4. **Stage 3 changes** (`src/lib/router-changes.js`). There is one change per
   bridge, sent one at a time in the poll reply. On the router, each change
   runs in this order:
   1. Read-only preflight.
   2. Write the `fiti-undo-<id>` script.
   3. Add the `fiti-revert-<id>` startup guard.
   4. Run the body inside on-error → undo.
   5. Loop asking `/api/router/change?state=applied` until the cloud answers
      "confirmed". Without that answer the router undoes the change itself.
   6. Report `kept`.
   7. Recheck the layout. The status becomes `verified` or `mismatch`.
   - Timeouts are 8 min for sent and 10 min for confirming. A slow hAP lite
     needed about 4 min.
   - Rename and undo are supported, with dependency rules: a newer change
     must be undone first.
   - A hotspot build picks a free subnet from 10.5.50–59/24. It then adds
     firewall rules before the first static input rule, NAT, the walled
     garden, and `fiti-map`.

### What `map-wifi` adds (the last request: "build and strategically place it for visibility")

- **Map UI:**
  - Free radios show "📶 can broadcast customer Wi-Fi".
  - Each hotspot bridge card has a `.rb-wifi` panel:
    - With a radio in the bridge: an SSID input with a live preview. The
      default name comes from the business hotspot name.
    - Without one: "+ Add wlanX" buttons, or a note that there is no radio.
  - Dropping a radio into a PPPoE bridge is refused with a notice.
- **Server:**
  - A radio (`wlan` or the `wifi` package) is allowed only in a hotspot
    bridge.
  - An SSID is required: 1–32 characters, with no `"`, `\` or `$`.
  - A switched-off radio counts as free.
- **Router script:**
  - After the hotspot is built, the script saves the radio's
    ssid/mode/profile/disabled values into `fiti-radio-<id>-<radio>-*`
    scripts.
  - It then adds an open security profile `fiti-open-<id>` and turns the
    radio on in ap-bridge mode.
  - Undo restores the radio first.
  - A new preflight reason, `radio_missing`, is added.

### What to build next (in this order; don't start again)

1. **Finish and merge `map-wifi`**, as listed above.
2. **Wi-Fi follow-ups** (not started):
   - Choose the band or channel. Right now the script keeps the radio's
     current values.
   - A warning when the owner's own Wi-Fi already uses that radio. Taking
     it over would drop their private SSID; offer a virtual AP instead.
   - A test on a router with the RouterOS 7 `wifi` package. That code path
     is untested on hardware.
3. **The first-time owner's journey:**
   - Keep the reassurance "patience cards" in step with any new waiting
     step, using `appendPatienceCard` and its single global ticker.
   - The goal is setup in 3 minutes or less.
4. **Open investigation:** why the scheduler-driven inventory never reached
   the cloud. The current workaround is reply-driven reports.
   - Before anyone removes that workaround, check the router log and the
     `fetch` result from a scheduler run.

### Don't break

- The existing network of any onboarded router: every change needs a
  preflight, an undo-first script and a boot guard.
- The old kits, kept as a fallback.
- Draft persistence (`networkPlanDrafts`). Redraws are skipped while an
  input has focus or the review is open; otherwise the owner loses their
  map.
- Test fixtures: plans that put a radio in a hotspot bridge must now
  include `wifi: { ssid }`.

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
