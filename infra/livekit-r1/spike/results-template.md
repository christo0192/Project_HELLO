# S0-F result matrix

Do not record tokens, API keys, candidate names, or raw media in this document.
Record browser/OS/network, UTC time, server version/digest, selected pair,
remote host/port, join latency, and a link to the sanitized stats JSON.

| Cell | Browser/device | Network/location | Attempts | Join success | UDP selected | p95 RTT | Loss/jitter | Video FPS / bandwidth-limited | Cloud baseline | Result / root cause |
|---|---|---|---:|---:|---:|---:|---|---|---|---|
| Home | Chrome Windows/macOS | Jio Fiber/Airtel/ACT; Bangalore/Chennai | 15+ | | | | | | | |
| Home | Safari macOS | Jio Fiber/Airtel/ACT; Mumbai/Pune | 15+ | | | | | | | |
| Mobile | Android Chrome | Jio/Airtel/Vi 4G/5G; Delhi/Hyderabad | 15+ | | | | | | | |
| Mobile | iOS Safari | Jio/Airtel/Vi 4G/5G | 15+ | | | | | | | |
| Corporate | Chrome/Safari | strict or TLS-inspecting network | 15+ | | | | | | | |
| Cloud control | matched device/network | Cloud baseline | 15+ | | | | | | | |

## S0-F1–F5 evidence

| Step | Required evidence | Result |
|---|---|---|
| S0-F1 | Config A first: selected pair is UDP to dedicated-IP:7882. If A fails (including forced TCP), record why before Config B; Config-B only: `ss -ulpn` shows `<fly-global-services>:7882` | |
| S0-F2 | Laptop + forced TCP join; 20 stop→start cycles; UDP first join 20/20; wake p95 ≤5s | |
| S0-F3 | 20 cold + 20 warm dispatches; agent joins 40/40; worker-to-SFU RTT p95 <5ms | |
| S0-F4 | Matrix above, at least 15 joins/cell and 150 total, matched Cloud baseline | |
| S0-F5 | Five 25-minute sessions, three concurrent sessions, mobility/reconnect, Cloud flip/back, deploy guard, key rotation | |

## Pass thresholds (v2 §10.1)

- Home/mobile join success ≥98% overall and no cell <93%; corporate 100% via ICE/TCP or T3.
- UDP selected for ≥90% of home/mobile joins; RTT p95 ≤200ms and ≤30ms worse than Cloud.
- Loss mean ≤2% and ≤5% in 95% of 30-second windows; jitter p95 ≤30ms; audio concealment ≤2%.
- Blind A/B ≥4/5 and within 0.5 of Cloud; video ≥12fps in ≥95% samples, no >2s freeze, bandwidth limitation <10%, PLI <1/min.
- Handover/short airplane resume ≥9/10; no >2s gap in long sessions; CPU throttle zero at three sessions; Cloud switch/back <15 minutes.

Any run without a selected UDP pair is NO-GO. Config B is allowed only after a documented Config-A failure, including forced TCP. A corporate failure requires tested external TURN (T3) or NO-GO.
