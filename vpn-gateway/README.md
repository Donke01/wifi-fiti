# WiFi Fiti VPN gateway

This is a small pull agent for the dedicated `wg-fiti` WireGuard interface on
the WiFi Fiti VPN VPS. It reconciles only peer records issued by the Railway
application after a business explicitly enables managed access for a router.

It is not a general VPN dashboard and it never routes customer internet
traffic. Do not add a default route, a masquerade rule, or customer LAN routes
to `wg-fiti`.

## Security boundary

- The WireGuard private key stays in WireGuard and `/etc/wireguard/wg-fiti.conf`.
  The agent deliberately never calls `wg show … dump`, because that output
  includes a private key.
- The Railway application receives only the gateway public key.
- The agent contacts Railway over HTTPS; Railway never SSHs into the VPS.
- The only public VPS ports are SSH and UDP 51820. Use SSH keys and a firewall.
- The agent removes a revoked peer on its next pull even if the router is
  offline. It removes only keys it previously recorded in its local state file.
- Railway can issue only a `10.254.0.0/16` router-management `/32`; the agent
  independently rejects all other peer addresses, including the gateway
  address `10.254.0.1` and any default route.
- The local state file durably queues a confirmed peer addition/removal and a
  new handshake until Railway acknowledges it. Unchanged peers therefore do
  not create a database write every five seconds.

## Prerequisites

The VPS must already have WireGuard installed and a live interface named
`wg-fiti`, with this management-only address:

```ini
[Interface]
Address = 10.254.0.1/16
ListenPort = 51820
PrivateKey = <kept only on the VPS>
SaveConfig = false
```

In Railway, configure these variables before starting the agent:

```text
VPN_GATEWAY_ENABLED=true
VPN_GATEWAY_ID=primary
VPN_GATEWAY_ENDPOINT=vpn.wififiti.co.ke
VPN_GATEWAY_PORT=51820
VPN_GATEWAY_PUBLIC_KEY=<gateway public key>
VPN_GATEWAY_ADDRESS=10.254.0.1
VPN_GATEWAY_MANAGEMENT_CIDR=10.254.0.0/16
VPN_GATEWAY_CONTROL_SECRET=<openssl rand -hex 32>
```

Use the same `VPN_GATEWAY_CONTROL_SECRET` in the VPS environment file. It is
an agent credential, not a WireGuard key and not an administrator password.

## Install on Ubuntu

Install Node.js 18+ and copy the two repository files to the VPS:

```text
/opt/wifi-fiti-vpn-agent/agent.js
/etc/systemd/system/wifi-fiti-vpn-agent.service
```

Create `/etc/wifi-fiti-vpn-agent.env` with mode `0600`:

```text
WIFI_FITI_CORE_URL=https://cloud.wififiti.co.ke
WIFI_FITI_GATEWAY_ID=primary
WIFI_FITI_GATEWAY_SECRET=<same VPN_GATEWAY_CONTROL_SECRET from Railway>
# Must exactly equal Railway's VPN_GATEWAY_PUBLIC_KEY. The agent checks this
# against the live wg-fiti interface before it touches any peer.
WIFI_FITI_GATEWAY_PUBLIC_KEY=<gateway public key>
WIFI_FITI_WG_INTERFACE=wg-fiti
WIFI_FITI_GATEWAY_POLL_SECONDS=5
```

Create a dedicated service account before enabling the unit. It receives only
the `CAP_NET_ADMIN` capability required to talk to the live WireGuard
interface; systemd makes `/etc/wireguard` inaccessible to it, so the agent
cannot read the gateway private key:

```bash
useradd --system --home /var/lib/wifi-fiti-vpn-agent --shell /usr/sbin/nologin wifi-fiti-vpn-agent
```

Then enable it:

```bash
systemctl daemon-reload
systemctl enable --now wifi-fiti-vpn-agent
systemctl status wifi-fiti-vpn-agent
```

Use `journalctl -u wifi-fiti-vpn-agent -f` for diagnostics. Never paste the
environment file, WireGuard private key, or router pairing token into a log or
support chat.

Do not create router peers manually on `wg-fiti`. WiFi Fiti owns peers that
its agent has recorded under `/var/lib/wifi-fiti-vpn-agent/state.json`. Keep
that state directory in VPS backups: if it is deliberately removed, the agent
will safely leave an unknown old peer alone rather than deleting it.
