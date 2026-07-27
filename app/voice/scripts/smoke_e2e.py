"""
End-to-end integration smoke (no mic needed). Verifies every external piece the
live call depends on, with the real keys:
  1. Anthropic Haiku  (the brain)
  2. Sarvam TTS stream (new key + credits)
  3. Sarvam STT        (saaras:v3 on a real Indian-English clip)
  4. Supabase          (db.py round-trip into screening_v2, then cleanup)

Run: .\.venv\Scripts\python.exe scripts\smoke_e2e.py
"""

import asyncio
import base64
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

CLIP = ROOT.parent.parent / "_archive" / "v1-retell" / "spike" / "results" / "audio" / "sarvam-v2-anushka" / "13.wav"

results = {}


def check(name, ok, detail=""):
    results[name] = ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")


def test_anthropic():
    try:
        from anthropic import Anthropic
        c = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        m = c.messages.create(
            model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
            max_tokens=20,
            messages=[{"role": "user", "content": "Reply with exactly: ready"}],
        )
        txt = "".join(b.text for b in m.content if getattr(b, "type", "") == "text").strip()
        check("anthropic_haiku", bool(txt), f"reply={txt!r}")
    except Exception as e:  # noqa: BLE001
        check("anthropic_haiku", False, str(e)[:140])


def test_sarvam_tts():
    try:
        body = {
            "text": "Hello, this is a test from Maya.",
            "target_language_code": os.getenv("SARVAM_LANGUAGE", "en-IN"),
            "speaker": os.getenv("SARVAM_TTS_VOICE", "anushka"),
            "model": os.getenv("SARVAM_TTS_MODEL", "bulbul:v2"),
            "speech_sample_rate": 8000,
            "output_audio_codec": "mp3",
        }
        headers = {"api-subscription-key": os.environ["SARVAM_API_KEY"]}
        n = 0
        with httpx.Client(timeout=60) as cl:
            with cl.stream("POST", "https://api.sarvam.ai/text-to-speech/stream",
                           json=body, headers=headers) as r:
                r.raise_for_status()
                for chunk in r.iter_bytes():
                    n += len(chunk)
        check("sarvam_tts", n > 0, f"{n} audio bytes")
    except Exception as e:  # noqa: BLE001
        check("sarvam_tts", False, str(e)[:140])


async def test_sarvam_stt():
    try:
        if not CLIP.exists():
            check("sarvam_stt", False, f"no test clip at {CLIP}")
            return
        audio_b64 = base64.b64encode(CLIP.read_bytes()).decode()
        from sarvamai import AsyncSarvamAI
        client = AsyncSarvamAI(api_subscription_key=os.environ["SARVAM_API_KEY"])
        async with client.speech_to_text_streaming.connect(
            model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            mode="transcribe", language_code="en-IN", high_vad_sensitivity=True,
        ) as ws:
            await ws.transcribe(audio=audio_b64)
            resp = await ws.recv()
        text = getattr(resp, "transcript", None) or getattr(resp, "text", None) or str(resp)
        check("sarvam_stt", bool(text), f"transcript={str(text)[:60]!r}")
    except Exception as e:  # noqa: BLE001
        check("sarvam_stt", False, str(e)[:140])


def _wav_bytes(path: Path) -> bytes:
    return path.read_bytes()


def test_supabase():
    try:
        import db
        c = db._client()
        if not c:
            check("supabase", False, "no creds")
            return
        cand = c.schema(db.SCHEMA).table("candidates").insert({"name": "SMOKE TEST"}).execute()
        cid = cand.data[0]["id"]
        sid = db.create_session(cid, mode="browser")
        db.save_turns(sid, [{"turn_index": 0, "speaker": "bot", "text": "hello"}])
        db.complete_session(sid, 1)
        rows = c.schema(db.SCHEMA).table("transcript_turns").select("text").eq("session_id", sid).execute()
        ok = len(rows.data) == 1
        c.schema(db.SCHEMA).table("candidates").delete().eq("id", cid).execute()  # cascade cleanup
        check("supabase", ok, f"wrote+read+cleaned (turns={len(rows.data)})")
    except Exception as e:  # noqa: BLE001
        check("supabase", False, str(e)[:140])


async def main():
    print("E2E integration smoke\n")
    test_anthropic()
    test_sarvam_tts()
    await test_sarvam_stt()
    test_supabase()
    print(f"\n{sum(results.values())}/{len(results)} integrations live.")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    asyncio.run(main())
