# WiFi Fiti — agent handoff

This repository is the source of truth for WiFi Fiti. Work from the `main`
branch and do not put production secrets, router keys, database files, or
`.env` files into Git or support messages.

## What is live

- Marketing site: `https://wififiti.co.ke`
- Application, tenant dashboard, customer portal API, M-Pesa callbacks, and
  router polling: `https://cloud.wififiti.co.ke`
- GitHub: `https://github.com/Donke01/wifi-fiti`
- Railway uses a persistent volume mounted at `/data`; production must set
  `DATABASE_PATH` inside that volume.

## Architecture

Customer MikroTik routers make authenticated **outbound HTTPS** requests to
the cloud. WiFi Fiti does not expose public WinBox, API, or SSH.

```text
MikroTik ── outbound HTTPS poll ──> cloud.wififiti.co.ke
MikroTik ── outbound WireGuard ──> WiFi Fiti VPN gateway
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
  Hotspot, NAT, and administrator credentials. Install WiFi Fiti polling and
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
physical router. Once a router has contacted WiFi Fiti or has customer
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
