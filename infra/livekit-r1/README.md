# R1 LiveKit SFU S0-F spike

This directory is deliberately outside the application deployment workflow. It
creates a disposable, single-Machine SFU for the S0-F go/no-go only; it does
not move the phone lane off LiveKit Cloud.

## Local Docker smoke test

`fly-global-services` exists only inside a Fly Machine. For a local Docker
check, pass the explicit test-only override below; without it the entrypoint
fails closed rather than silently binding an unreviewed address. This proves
the rendered config and LiveKit health endpoint, but is not an S0-F1 media
result.

```sh
docker build -f infra/livekit-r1/Dockerfile -t livekit-r1-local infra/livekit-r1
docker run --rm --name livekit-r1-local -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -e NODE_IP=127.0.0.1 \
  -e LIVEKIT_KEYS='r1-local:0123456789abcdef0123456789abcdef' \
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
  NODE_IP="<the allocated dedicated IPv4>"
fly deploy --ha=false --config infra/livekit-r1/fly.toml
```

`--ha=false` is required: Redis is intentionally absent, and Fly routes UDP per
packet rather than by flow. Do not add a second Machine or a UDP port range.

The rendered configuration deliberately uses `rtc.ips.includes` for
`fly-global-services`. This is Config B in the networking memo. It is the
S0-F1 assertion, not a production claim: first prove it did not break the raw
TCP fallback.

## S0-F1 operator check

Obtain the actual Fly address and confirm the server bound that exact source
address, not `0.0.0.0` or only the ordinary eth0 address:

```sh
fly ssh console -a project-hello-r1-rtc-spike -C 'getent hosts fly-global-services; ss -ulpn | grep :7882'
```

The `ss` output must show `<fly-global-services>:7882`. In the browser spike
page, the selected candidate pair must be UDP and its remote must be
`<dedicated IPv4>:7882`. Either failure is S0-F1 NO-GO; do not treat a TCP
fallback as success.

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

The script creates a room, dispatches only `r1-spike`, and prints a candidate
and a test-agent JWT. Open `spike/index.html` from an HTTPS preview (or
localhost), paste the candidate URL/token, and use headphones: the echo worker
returns microphone audio and speakers can create acoustic feedback.

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
