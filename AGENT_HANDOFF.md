# Wi-Fi Fiti — agent handoff

This repository is the source of truth for Wi-Fi Fiti. Work from the `main`
branch and do not put production secrets, router keys, database files, or
`.env` files into Git or support messages.

## Handover — 28 Sep 2026, night (read this first)

### Where the code is

- `main` is deployed on Railway (cloud.wififiti.co.ke). Everything in this
  handover is merged and live; the latest merge is `de8a944`
  (`onboarding-simplify`). Merged today, in order: PR #10 `map-wifi`, PR #11
  (owner's Wi-Fi kept, one-step setup, restart reports), `setup-polish`,
  `poll-guard`, `lighter-reports`, `faster-connect`, `multi-wan` (with
  `stage3-finish`), `go-live`, `map-advanced`, `router-tools`, PR #12 (PPPoE
  customer payments), `map-entry`, `onboarding-simplify`.
- **No feature branch is waiting to be merged.** Branches that still show
  commits ahead of `main` (`billing-hub`, `guided-setup`, `trial-guards` and
  others from 14–27 Sep) are old history, far behind `main`.
  They are not pending work; ask the owner before touching them.
- Merge a new branch only when the owner says **"push"**, then check the live
  business.html (see Verification). A push to `main` redeploys the server.
- Stage 3 still needs a real-router test of "add Wi-Fi to a running hotspot"
  (see Next steps).
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

Merged with `multi-wan` (`3e60fc9`, live):
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

7. **Two internet connections** (branch `multi-wan`, on top of
   `stage3-finish`).
   - The layout report (agent 5) lists every line: `inv|wans|<if>|<kind>`
     for running PPPoE clients, bound DHCP clients with a default route, and
     default routes; `inv|wanlist|WAN|<if>` for the router's "WAN" interface
     list.
   - Every line (and the port under it) is "Internet" and locked on the map.
   - The hotspot's NAT masquerade and the DNS drops cover every line, so
     customers keep internet on failover or load sharing. When the "WAN"
     list holds the main line, the rules use `out-interface-list=WAN` /
     `in-interface-list=WAN` (a line added later is covered), plus a rule for
     any line outside the list.
   - Older (agent 4) reports keep the single-WAN rules. Routers get the new
     report script automatically (every 10 min while their agent is older).

### Stage 4 (go live): `go-live` (live)

A guided path from a set-up router to the first paying customer.

- **Server:** `GET /api/business/locations/:id/go-live`
  (`goLiveStatus` in server.js).
  - It uses the same checks a real `/pay` does: hotspot running, packages
    sellable within trial limits, how payments are collected
    (Tuma/own/Wi-Fi Fiti), `businessCanSell` blocks, a payment in progress,
    and the latest paid sale with whether its login job was acknowledged.
  - `live` means the first customer was switched on.
  - `POST /api/business/packages/starter` adds 3 ready-made packages when
    there are none: 30 min/KES 1, 2 h/KES 2, 1 day/KES 3 on the trial;
    1 h/KES 10, 1 day/KES 50, 1 week/KES 250 otherwise.
- **Dashboard:** `appendGoLive` / `drawGoLive` / `renderGoLiveOverview`.
  - The card sits above the routerboard once a hotspot runs, and at the top
    of Overview until the first customer is connected.
  - It refreshes every 5 s while visible and not live, so the owner watches
    the test purchase go "Paid → switching on → You're live!".
  - Buttons open Packages, Branding, Payments, Transactions, or the login
    page.

### Map: advanced changes: `map-advanced` (live)

- **Adopt an owner's hotspot** (kind/job `adopt`).
  - `existing[].adopt` on the bridge that runs a hotspot not named
    `fiti-hotspot`, while the router is awaiting its map.
  - Nothing about the hotspot is rebuilt. The poller is pointed at it
    (fiti-map, globals), the cloud and portal hosts are added to the walled
    garden, and the portal refresh is forced so Wi-Fi Fiti's login page
    replaces theirs.
  - Saved first: `login.html` to `login-before-wifi-fiti.html`, the
    profile's `dns-name`, and the fiti-globals on-event. The preflight
    refuses (`login_backup_failed`) if the login page can't be read in full.
  - Undo stops billing first, restores the login page (the undo is
    incomplete until it is back), then dns-name and the walled garden.
  - Bridges only. `/file add` needs RouterOS 7.
- **PPPoE on a VLAN:** an existing VLAN can take the PPPoE job; the PPPoE
  setup accepts any interface.
- **Wi-Fi channel:** "More Wi-Fi options" on a radio Wi-Fi Fiti takes over.
  - The report (agent 6) sends `inv|radio|<if>|2ghz|5ghz`.
  - Channels: 1/6/11 or 36–48/149–161. The frequency is saved before it
    changes and put back by undo. Automatic leaves it alone.
  - A shared radio follows the owner's channel.
- **Not yet tested on hardware:** adopt (no router with an owner hotspot to
  hand) and the RouterOS 7 `wifi`-package channel path.

Left for later: a hardware test
of the RouterOS 7 `wifi` package (hAP ax etc.; code exists, untested).

### PPPoE customer payments: PR #12 from `claude/keen-goldberg-3n2ttc` (live)

Built on `main` `4a6e045`. PPPoE subscribers pay for their own internet: plan
prices, username as account number (pay page prompt, PayBill, owner-recorded
cash), credit for short/extra payments, installation fee, 3 grace days (owner
setting), plan changes (faster now for the difference, cheaper at renewal),
24-hour speed boosts, pay for someone else (masked), receipts, SMS reminders,
and refusal while the owner's own PPPoE plan has lapsed. See the README section
"PPPoE customer payments" for the rules.
- Code: `src/lib/pppoe-billing.js` (all money maths, `applyPayment`),
  `src/lib/pppoe.js` (new columns, boost profile, `reconnect` drops the live
  session, optional expired pay-page profile, expiry compared with julianday),
  `src/server.js` (`pushTenantPrompt` shared with hotspot sales; `/pay/...`,
  `/api/pppoe-pay/...`, owner `/api/business/pppoe/...` routes; PayBill
  matching, validation and reversal; 10-minute sweep), `public/pppoe-pay.html`
  (customer, self-contained for the walled garden), `public/pppoe.html`
  (owner page, rebuilt).
- Tests: `test/pppoe-billing.js`, `test/pppoe-pay-integration.js` (both in
  `npm test`); full suite passes. Pages checked in Chromium at 390 and 1280 px
  against a seeded local server.
- Still to prove:
  1. A live M-Pesa prompt and a real PayBill payment with the username.
  2. PayBill refusal needs Safaricom validation switched on for the tenant's
     PayBill; without it, money that arrives while the owner is lapsed is kept
     as credit.
  3. The expired pay page (off by default) on a real router: address list,
     walled garden, web-proxy redirect on RouterOS 6 and 7.
  4. That dropping the session after a plan change or boost reconnects the
     customer's router within seconds.

### First-time onboarding, simplified: `onboarding-simplify` (live)

For a new owner who found step 2 confusing (two pages, two progress lists,
duplicate buttons, text about a Wi-Fi name the page no longer asks for).
All in `public/business.html` unless named.

- **Organisation screen:** a hint under each field. The hotspot name follows
  the organisation name until the owner edits it (`dataset.edited`).
- **Add-router popup:** "Save and continue" and "I'll add it later" only.
- **Header:** kicker "SETUP GUIDE", plain intro and rail subtitles, no
  "N / 3" counter (the rail and "STEP N OF 3" show progress).
- **Step 2 is one page** (stage 2 in `renderOnboarding`):
  - "Router just reset? Give it internet first" is a collapsed, optional
    section with the reset and DHCP commands (`appendPreparation(body,
    location, isOpen)`). The connection phase is `'install'` by default;
    `'prepare'` only keeps this section open across a refresh (opening it,
    or "Review WAN preparation", sets it).
  - Before a kit exists, "Generate connection kit" is the only main action:
    no connection-state card, no "Check connection now". The kit choice
    sits in a collapsed "Other kit"; the connection kit stays the default.
  - Kit console (`appendRouterInstaller`): the certificate, clock and
    device-mode fixes are collapsed troubleshooting items. "Generate a new
    kit" stays under More kit options; "Create a different kit" is gone.
  - Pairing card (`appendPairingPatience`): the first message says to paste
    the kit in WinBox. The timer starts only when a kit is copied:
    `copyKit` stores `copiedAt` on the session kit and calls
    `startPatience(key)`. `appendPatienceCard` has `waitForStart` and
    `repeatFrom` options for this.
  - Footer: only "Back to router".
- **Step 1:** "Add another router" appears once another router exists or
  this one has connected before. "Continue to connection kit" starts a fresh
  pairing (drops the kit, "Previous verification is paused") only for a
  router that verified before (`beginFreshRouterPairing`); a router that
  never connected keeps its kit.
- **Step 3:** universal routers have no "Confirm your router map" heading.
  `appendQuickSetupLead` adds "Go to one-step setup" at the top when the
  `.rb-quick` card exists; CSS (`:has`) hides it once that card is gone.
- **Welcome page:** `billing-hub.js` and `tuma-payout.js` send no requests
  while signed out (their `api()` fails at once without a token). Portal
  templates load only when signed in, and again when their page opens.
- **Customer portal:** the voucher icon's SVG path is fixed
  (`tenant-portal.html`).
- **Router kit:** the universal kit's no-internet message points to the
  setup page's DHCP command (`src/lib/router-setup.js`, text only).
- Checked: full suite; Chromium at 390 and 1280 px against a local server
  with a fake router (pairing, layout report, one-step card). Not yet:
  Firefox, and a real router through the new pages.

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
- **Router tools page** (`router-tools`): health, log, speed test, check a
  customer, backup and restart, one at a time per router, riding the poll
  reply. Restart and backup check the poller's permissions first and say
  plainly when the kit needs pasting again. The map also got a "Go to my
  dashboard" button.
- **Universal routers count as mapped** once they run a hotspot or bill the
  owner's own (`map-entry`). Each router on the Routers page has a Router
  map button; an open map stays open and refreshes until "Go to my
  dashboard".

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

1. Walk the owner through the new onboarding in Firefox, and pair one real
   router through it (a new account, or "Start router setup again" on a
   spare router).
2. On the RB951: one-step setup cable-only (no Wi-Fi), then add Wi-Fi to the
   running hotspot from its card, check a phone gets the login page, then
   Undo the Wi-Fi only.
3. Then: "Add TV" not showing in the customer portal, and the other open
   items (regenerate the exposed Daraja sandbox key, replace placeholder
   router API credentials).
4. Small UI follow-ups: when a universal router goes quiet during step 3,
   step 2 says "Router setup needs attention — Paired · map its network
   next. Correct the router setting…", which doesn't fit a router that is
   just offline. Reloading while on Portal templates loads the list twice
   (harmless).

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
- Scrolling to something inside the map: `.router-map` is `overflow:hidden`,
  so `scrollIntoView` scrolls the card itself and hides its top for good.
  Use `scrollPageTo(node)`, which moves only the window.
- `test/business-ui.js` runs `appendRouterInstaller`, `appendSimpleRouterSetup`
  and a few helpers in a vm with a tiny DOM (no `querySelector`, `dataset` or
  `classList.toggle`). Guard page globals with `typeof`, as
  `kitConsolesShown` and `startPatience` are.

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

Step 2 is a single page: optional reset help (collapsed), one connection kit,
then a wait card whose timer starts when the kit is copied.

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
