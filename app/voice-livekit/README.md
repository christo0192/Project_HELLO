# voice-livekit (SPIKE)

Isolated, throwaway LiveKit Agents worker to test whether migrating off Pipecat
(`app/voice/`) fixes turn-taking / latency. Does **not** touch `app/voice/` —
that remains the rollback path.

Stack: Sarvam STT (`saaras:v3`, en-IN) + Sarvam TTS (`bulbul:v3`, speaker `simran`)
+ DeepSeek/OpenAI-compatible LLM. Turn handling uses LiveKit Agents defaults.

The mature Diana screening prompt from the Pipecat implementation has been ported
into this worker: on-request AI disclosure, five-minute screening discipline, role-specific
question flow, mandatory-item coverage, resume cross-checks, indirect gap probes,
candidate Q&A wind-down, and final goodbye behavior.

## Setup (already done by this scaffold)

```powershell
python -m venv "D:\Claude projects\Screening bot for HR\app\voice-livekit\.venv"
& "D:\Claude projects\Screening bot for HR\app\voice-livekit\.venv\Scripts\Activate.ps1"
python -m pip install --upgrade pip
pip install livekit-agents livekit-plugins-sarvam livekit-plugins-openai python-dotenv supabase httpx
```

## Step 1 — voice test (PRIMARY spike path, no LiveKit Cloud account needed)

`console` mode talks to the agent through your local mic/speakers directly —
it does **not** open a LiveKit room, so LiveKit credentials (URL, API key, API secret) are NOT required for this step.

```powershell
cd "D:\Claude projects\Screening bot for HR\app\voice-livekit"
& ".venv\Scripts\Activate.ps1"
python agent.py console
```

For a stronger pitch/demo, fill these optional values in `.env` before running
console mode:

```powershell
GOPU_CANDIDATE_NAME=Taylor Example
GOPU_ROLE_TITLE=Customer Success Specialist
GOPU_ROLE_FOCUS=Communication clarity, customer handling, and structured problem solving.
GOPU_RESUME_FACTS=- Name: Taylor Example\n- Current role: Support Associate\n- Total experience: 2 years\n- Skills: communication, customer support\n- Summary: Synthetic local demo profile.
```

**Acceptance test:** Say out loud: *"So my name is Taylor ... [pause ~2.5s] ... and I
have been working in data."*
- Does Diana WAIT through the pause instead of cutting you off?
- Is end-of-turn -> response latency ≤ what you measured for Deepgram Flux on
  the current Pipecat stack?

If both are yes, the migration is worth pursuing further.

## Dashboard LiveKit Flow

This is now the dashboard path. The React dashboard asks the Node API to create a
`screening_v2.call_sessions` row, create a LiveKit room, and return a browser
join token. The LiveKit worker reads the room metadata, writes committed
conversation turns into `screening_v2.transcript_turns`, completes the session on
close, and triggers the existing `/api/assess/:session_id` DeepSeek scorecard.

Required environment variables (see `.env.example` in each directory):

- **`app/api/.env`:** LiveKit credentials (URL, API key, API secret)
- **`app/voice-livekit/.env`:** same LiveKit variables plus Supabase credentials (URL, service-role key, schema, recordings bucket) and API base URL

All values use `replace_me` placeholders in committed example files; real credentials are owner-supplied at deploy time.

Run the three processes:

```powershell
# 1) API
cd "D:\Claude projects\Screening bot for HR\app\api"
npm run dev

# 2) dashboard
cd "D:\Claude projects\Screening bot for HR\app\web"
npm run dev

# 3) LiveKit worker
cd "D:\Claude projects\Screening bot for HR\app\voice-livekit"
.\.venv\Scripts\python.exe agent.py dev
```

Then open the dashboard, go to a candidate, and click **Start Screening** in the
LiveKit card. Keep that tab open while the call runs.

What should happen:

- Live transcript appears in the dashboard from Supabase Realtime.
- Browser-side playback audio is uploaded to `recordings_v2` when the call ends.
- The worker marks the session completed and triggers the same DeepSeek scorecard
  route used by the old flow.

## Manual LiveKit Cloud Test

Use this only when you want to test through a raw LiveKit room without the
dashboard.

1. Go to https://cloud.livekit.io (free tier), create a project.
2. Copy the project's WebSocket URL, API Key, and API Secret into `.env`
   (see `.env.example` for the required variable names).
3. Run the worker:
   ```powershell
   python agent.py dev
   ```
4. Connect a client via the LiveKit Agents Playground (linked in the LiveKit
   Cloud dashboard) to talk to the agent over a real room.

The worker also accepts JSON context through LiveKit room, participant, or job
metadata. Supported keys:

```json
{
  "candidate_name": "Taylor Example",
  "role_title": "Customer Success Specialist",
  "role_focus": "Communication clarity, customer handling, structured problem solving",
  "resume_facts": "- Name: Taylor Example\n- Skills: communication, customer support",
  "screening_template": [
    { "question": "Total years of relevant experience", "mandatory": true },
    { "question": "Reason for leaving your current or previous organization", "mandatory": true },
    { "question": "Expected CTC and notice period", "mandatory": true }
  ]
}
```

## Turn handling

The worker does not configure a custom VAD, Silero model, or explicit endpointing
thresholds. Turn handling uses the LiveKit Agents `AgentSession` defaults.

## Notes

- `agent.py` is still a LiveKit migration spike, but it now uses the full Diana
  behavior prompt from the Pipecat prototype.
