# R1 LiveKit SFU S0-F spike

This directory is deliberately outside the application deployment workflow. It
creates a disposable, single-Machine SFU for the S0-F go/no-go only; it does
not move the phone lane off LiveKit Cloud.

## Local Docker smoke test

Config A is the default and has no `rtc.ips` filter, so it needs no Fly-only
address resolution. The local override is only for a Config-B smoke test; it
is rejected whenever `FLY_APP_NAME` or `FLY_MACHINE_ID` is present.

```sh
docker build -f infra/livekit-r1/Dockerfile -t livekit-r1-local infra/livekit-r1
docker run --rm --name livekit-r1-local -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -e NODE_IP=127.0.0.1 \
  -e LIVEKIT_KEYS='r1-local:0123456789abcdef0123456789abcdef' \
  -e LIVEKIT_R1_CONFIG=B \
  -e LIVEKIT_R1_FGS_IP_OVERRIDE=127.0.0.1 \
  livekit-r1-local
# In another terminal: curl -fsS http://127.0.0.1:7880/
```

The startup log must say it is using `LIVEKIT_R1_FGS_IP_OVERRIDE`; never set
that variable in Fly. Stop/remove the test container when the check completes.

## Create and deploy

Run these commands from the repository root. The dedicated IPv4 is required for
UDP; record its value locally only long enough to set `NODE_IP`.

```sh
fly apps create project-hello-r1-rtc-spike
fly ips allocate-v4 -a project-hello-r1-rtc-spike
fly secrets set -a project-hello-r1-rtc-spike \
  LIVEKIT_KEYS="r1-spike:$(openssl rand -base64 48)" \
  NODE_IP=replace_me   # the dedicated IPv4 printed by `fly ips allocate-v4`
fly deploy infra/livekit-r1 --ha=false --remote-only -a project-hello-r1-rtc-spike
```

`--ha=false` is required: Redis is intentionally absent, and Fly routes UDP per
packet rather than by flow. Do not add a second Machine or a UDP port range.
The build context must be `infra/livekit-r1`; the old root-context `--config`
form cannot find `/entrypoint.sh` during the Docker build.

The SFU scripts and templates are pinned to LF in `.gitattributes`, and the
Dockerfile removes CRLF defensively: a CRLF entrypoint makes its shebang
`/bin/sh\r`, which Fly reports as “No such file or directory”. The entrypoint
also unsets `LIVEKIT_KEYS` before it starts LiveKit. The rendered YAML already
contains the validated key mapping, while the environment variable uses a
different format that would otherwise collide with LiveKit's own parser.

Before every deploy or repeat, prove the existing app has exactly one Machine
in `sin`; this script accepts captured JSON too and never invokes Fly itself:

```sh
fly machines list -a project-hello-r1-rtc-spike --json | node infra/livekit-r1/preflight.mjs
# or: node infra/livekit-r1/preflight.mjs machines.json
```

Run **Config A first** (the default: no `rtc.ips` filter and no FGS lookup).
Use Config B only if Config A fails, including a forced-TCP test. Config B is
the opt-in FGS filter experiment:

```sh
fly secrets set -a project-hello-r1-rtc-spike LIVEKIT_R1_CONFIG=B
```

Do not interpret Config B as a production setting. Repeat its UDP and forced
TCP checks and record why Config A failed before considering it.

## Config C: worker media over Fly 6PN

Config C is Config B plus the SFU Machine's own Fly 6PN (private IPv6) address.
It exists because the R1 browser worker cannot reach the SFU over the public
dedicated IPv4. Select it with `LIVEKIT_R1_CONFIG=C`; Configs A and B render
byte-for-byte what they rendered before and are unaffected.

### Why (R1 A0 smoke, 2026-10-07 20:37 UTC)

- The worker (`project-hello-voice`, `sin`, livekit-agents 1.6.4 / livekit rtc
  1.1.12) received the job, then logged
  `livekit::rtc_engine failed to connect: wait_pc_connection timed out`, retried,
  and gave up.
- The SFU's `ICE candidate pair stats` for the agent participant showed local
  `37.16.23.137:7882 udp host` against remotes `172.19.66.154:55113 udp host` and
  `138.199.24.x:55113 udp srflx`, with `requestsSent 8, responsesReceived 0,
  requestsReceived 0`. UDP from a Fly Machine to another app's dedicated public
  IPv4 never arrives (no hairpin; observed, not documented by Fly).
- The ICE/TCP fallback on 7881 through Fly's proxy failed with
  `could not proxy TCP data ... Connection reset by peer`. Config B binds only
  `fly-global-services`, pion's TCP mux matches connections by local IP, and the
  proxy delivers them on eth0 instead.
- Browsers are unaffected: they connect over UDP to `37.16.23.137:7882`, which is
  exactly how S0-F1 passed under Config B.

### What Config C changes

The entrypoint renders both addresses into `rtc.ips.includes`:

```yaml
rtc:
  ips:
    includes:
      - "<fly-global-services IPv4>/32"   # browsers (advertised as node_ip)
      - "<fly-local-6pn IPv6>/128"        # the worker, over private IPv6
```

`<fly-local-6pn IPv6>` comes from `getent hosts fly-local-6pn` at every boot (the
address is not static, so it is never stored in `fly.toml` or a secret;
`$FLY_PRIVATE_IP` is only a fallback when the alias does not resolve). It must be
an `fdaa:` address made of hex groups, or the entrypoint exits with an error. A
Config C start without a 6PN address fails closed instead of quietly behaving
like Config B.

How it works, from the pinned LiveKit v1.13.7 / pion sources:

- LiveKit's single-port UDP mux binds one socket per local IP that passes
  `rtc.ips`, so the second include opens `[fdaa:...]:7882` next to the
  `fly-global-services` socket and gathers a UDP host candidate for it. The TCP
  listener on 7881 is dual-stack, so ICE/TCP over 6PN works too, and a direct 6PN
  connection arrives on the address that the mux matches.
- `node_ip` stays the IPv4. Its rewrite rule is scoped to the IPv4 family, so the
  fdaa candidate is advertised unchanged while the `fly-global-services` one is
  still advertised as `37.16.23.137`.
- The worker needs **no change**: libwebrtc (livekit rtc 1.1.12) gathers IPv6 ULA
  host candidates by default, and ranks them above IPv4. It pairs
  `fdaa:` with `fdaa:` directly over Fly's private network: no proxy and no
  hairpin. The browser also receives the fdaa candidate, cannot reach it, and
  keeps using the public IPv4 pair.
- Signaling stays on the public `wss://` URL. Fly's proxy still autostarts the
  Machine, and the API's readiness contract
  (`LIVEKIT_URL` host == `R1_LIVEKIT_URL` host) is unchanged. Do not point the
  worker at a `.internal` URL.
- There is no other `livekit.yaml` change. LiveKit has no IPv6 switch (UDP6 and
  TCP6 are on unless `force_tcp` is set). Never set `rtc.port_range_start` or
  `port_range_end` (it bypasses the mux and drops the 6PN socket; the validator
  rejects it).

### Preconditions

- `project-hello-voice` and the SFU app must be in the same Fly organization and
  on the default 6PN network (neither created with `fly apps create --network`).
  Check that both Machines share the first three hextets:

  ```sh
  fly ssh console -a project-hello-r1-rtc-spike -C 'getent hosts fly-local-6pn'
  fly ssh console -a project-hello-voice -C 'getent hosts fly-local-6pn'
  ```

- The worker Machine needs a normal global-scope fdaa address (not deprecated,
  not EUI-64): `fly ssh console -a project-hello-voice -C 'ip -6 addr show eth0'`.
- The production SFU app (`project-hello-r1-rtc`) repeats both checks.

### Deploy

Order matters: an older image rejects `LIVEKIT_R1_CONFIG=C` and would crash-loop.
Deploying changes the Machine, so do it with zero live rooms.

```sh
fly machines list -a project-hello-r1-rtc-spike --json | node infra/livekit-r1/preflight.mjs
fly deploy infra/livekit-r1 --ha=false --remote-only -a project-hello-r1-rtc-spike   # still Config B
fly secrets set -a project-hello-r1-rtc-spike LIVEKIT_R1_CONFIG=C                    # restarts the Machine
```

Roll back with `fly secrets set -a project-hello-r1-rtc-spike LIVEKIT_R1_CONFIG=B`.

To check the rendering locally without Docker (render-only mode redacts the key
and never starts LiveKit; `LIVEKIT_R1_6PN_IP_OVERRIDE` is rejected whenever
`FLY_APP_NAME` or `FLY_MACHINE_ID` is set, exactly like the FGS override):

```sh
NODE_IP=203.0.113.10 LIVEKIT_KEYS="r1-local:$(printf 'a%.0s' $(seq 40))" LIVEKIT_R1_RENDER_ONLY=1 \
  LIVEKIT_R1_CONFIG=C LIVEKIT_R1_FGS_IP_OVERRIDE=127.0.0.1 \
  LIVEKIT_R1_6PN_IP_OVERRIDE=fdaa:0:1:2:3:4:5:6 sh infra/livekit-r1/entrypoint.sh
```

### Verify Config C

1. The startup log names both addresses:

   ```sh
   fly logs -a project-hello-r1-rtc-spike --no-tail | grep livekit-r1-entrypoint
   # livekit-r1-entrypoint: Config C; advertising 37.16.23.137:7882 and 6PN fdaa:...
   ```

2. Both UDP sockets exist. If only the IPv4 one is listed, the `/128` matched no
   interface and LiveKit logs nothing, so this check is mandatory:

   ```sh
   fly ssh console -a project-hello-r1-rtc-spike -C 'ss -ulpn | grep :7882; ss -tlnp | grep :7881'
   # <fly-global-services>:7882  and  [fdaa:...]:7882  (7881 on a wildcard/[::] listener)
   ```

3. A worker job joins: start an R1 smoke session. The worker log must not show
   `wait_pc_connection timed out`.
4. The SFU's `ICE candidate pair stats` for the agent participant
   (`fly logs -a project-hello-r1-rtc-spike --no-tail | grep -i "ICE candidate pair stats"`)
   show the selected pair local `[fdaa:...]:7882` udp host against the worker's
   `fdaa:` address, with `responsesReceived > 0`. The failing pair was
   `37.16.23.137:7882` with `responsesReceived 0`.
5. Browsers still pair on the public IPv4: re-run the S0-F1 page and the
   forced-TCP check below. The selected UDP pair must still be
   `37.16.23.137:7882`, and connect time must not regress.

### Limits

- 6PN media bypasses Fly's proxy, so only the public WSS signaling connections
  keep the Machine from autostopping. They exist for every session already.
- Browsers see an unroutable `fdaa:` candidate: one extra failed ICE pair, and
  the SFU's internal 6PN address appears in their SDP.
- Config C depends on the worker and the SFU sharing a Fly 6PN. Moving either
  to another organization, a custom network, or a non-Fly host breaks the worker
  path silently; browsers keep working over the public IPv4.
- 6PN rides WireGuard (lower MTU). RTP and DTLS packets stay well below it, but
  this has not been measured on Fly.

## S0-F1 operator check

For Config A, the browser page must sample a selected UDP pair to the dedicated
IPv4 on port 7882. A missing selected UDP pair is a NO-GO. If Config A fails,
run the forced-TCP variant before the opt-in Config B test. For Config B only,
confirm the server bound the FGS source address rather than `0.0.0.0` or only
the ordinary eth0 address:

```sh
fly ssh console -a project-hello-r1-rtc-spike -C 'getent hosts fly-global-services; ss -ulpn | grep :7882'
```

The Config-B `ss` output must show `<fly-global-services>:7882`. In both
configs, the browser spike page reports the selected pair protocol; a run with
no selected UDP pair is NO-GO. Do not treat a TCP fallback as success.

## Create a spike room and tokens

Install dependencies once in `app/api` (the token script resolves the already
declared `livekit-server-sdk` from there). Start the echo worker separately in
an isolated Python environment with the worker's normal LiveKit Agents pins.

```sh
cd app/api && npm ci && cd ../..
export R1_SPIKE_URL=wss://project-hello-r1-rtc-spike.fly.dev
export R1_SPIKE_API_KEY=r1-spike
export R1_SPIKE_API_SECRET='<the secret supplied to LIVEKIT_KEYS>'
node infra/livekit-r1/spike/mint-token.mjs

export LIVEKIT_URL="$R1_SPIKE_URL"
export LIVEKIT_API_KEY="$R1_SPIKE_API_KEY"
export LIVEKIT_API_SECRET="$R1_SPIKE_API_SECRET"
python infra/livekit-r1/spike/echo_agent.py start
```

The script creates a room, dispatches only `r1-spike`, and prints only the
least-privilege candidate JWT. Open `spike/index.html` from an HTTPS preview (or
localhost), paste the candidate URL/token, and use headphones: the echo worker
returns microphone audio and speakers can create acoustic feedback.

Both helpers accept only `wss://project-hello-r1-rtc-spike.fly.dev` or its HTTPS
equivalent. They refuse LiveKit Cloud, the production SFU host, userinfo, ports,
and every other host. An intentionally different disposable host requires a
code change to the shared spike-host helper.

The `lk` CLI can mint equivalent manual tokens when needed:

```sh
lk token create --api-key "$R1_SPIKE_API_KEY" --api-secret "$R1_SPIKE_API_SECRET" \
  --join --room r1-spike-manual --identity candidate-manual --valid-for 15m
```

Use the force-TCP browser/network variant after S0-F1 because restricting
`rtc.ips` may affect the TCP mux. Fill out `spike/results-template.md`; it is
the evidence record for the S0-F decision.

## Teardown

Destroy the disposable app and explicitly release the billable dedicated IPv4
when the spike ends or fails:

```sh
fly ips list -a project-hello-r1-rtc-spike
fly ips release <allocated-ip> -a project-hello-r1-rtc-spike
fly apps destroy project-hello-r1-rtc-spike
```

Do not put the generated key, secret, or JWTs in an issue, commit, or result
matrix. Production uses `project-hello-r1-rtc`, an IK-controlled hostname, and
a separate manual zero-live-room deploy workflow (PR-SFU-2).
