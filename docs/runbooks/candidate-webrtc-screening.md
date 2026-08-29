# Candidate WebRTC screening runbook

## Candidate journey

`invite landing → consent → audio/network readiness → interview`

The candidate link token is in the URL fragment only. The web app removes the fragment immediately and keeps the token in memory. Never paste a candidate token into logs, tickets, screenshots, analytics, or query parameters.

## Readiness checks

The browser requests microphone access only after the candidate starts the test. The candidate chooses a microphone and speaks a short sentence. The app checks live audio activity, then uses a disposable `preflight-*` LiveKit room to verify a microphone-only publish path and a six-second stable connection.

The `voice-v1` thresholds are:

- ten-second connection timeout
- six-second uninterrupted stability window
- zero reconnects
- at least 50 outbound audio packets
- median RTT at most 300 ms when reported
- mean jitter at most 30 ms when reported
- packet loss at most 3% when reported
- at least 750 ms of measured voice activity

An explicit failing metric blocks progression. If a browser does not expose a numeric metric, the connected/no-reconnect/audio-packets fallback applies. There is no bypass button.

## Preflight safety

A preflight room:

- has random room and participant identifiers;
- contains only `{channel:"preflight",schema:1}` metadata;
- has no egress and no session binding;
- permits microphone publish only;
- cannot subscribe or publish data;
- expires quickly and is deleted on token failure;
- never consumes an invite or creates a candidate access grant.

The browser and phone workers must reject this marker before connecting, resolving worker context, recording, or persistence. If an agent appears in a preflight room, raise the production halt and investigate before enabling candidate links.

## Candidate support responses

- Permission blocked: explain browser site settings and retry.
- No microphone: connect/enable a microphone and retry.
- No audio detected: select another microphone and speak closer/clearly.
- Unstable/high-latency connection: move to a stronger network, pause downloads/VPN if permitted, and retry.
- Autoplay blocked: use the explicit “Enable interview audio” recovery control.
- Invite invalid/expired/used: issue a new invite; do not attempt to repair or reuse a consumed token.

## Privacy and transcript behavior

The interview view renders interviewer-only captions. Candidate transcription events are rejected before state mutation. No candidate transcript download, edit, copy, or export control is present. Device labels and raw RTC metrics stay in the browser.

## Rollback

1. Disable the candidate WebRTC UI feature flag, if enabled.
2. Verify the existing candidate link flow is restored.
3. Leave the preflight worker guard in place; it does not affect normal browser or phone rooms.
4. If consent presentation copy is withdrawn, reactivate the prior template version. Never delete or rewrite consent records.
5. Do not drop migration columns while any API version reads them.

## Verification commands

```bash
cd app/api && npm run typecheck && npm test -- --run
cd ../web && npm run lint && npm run test:typecheck && npm test -- --run && npm run build
cd ../voice-livekit && python3 -m unittest discover -s tests -p 'test_*.py' -v
```

All automated checks use fake media/provider boundaries. A rollout rehearsal must not place a real call or mutate production candidate data.
