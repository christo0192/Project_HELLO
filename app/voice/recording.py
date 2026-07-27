"""
Call recording → Supabase Storage.

Pipecat's AudioBufferProcessor mixes the user + bot audio into one track; on call
end we wrap it as WAV, upload to the private `recordings_v2` bucket, and return a
long-lived signed URL to store on call_sessions.recording_url (shown in the UI).

Uses the Storage REST API with the service_role key (Storage isn't Postgres, so
asyncpg can't do this). Best-effort: failures are logged, never crash the call.
"""

import io
import os
import wave

import httpx
from loguru import logger

BUCKET = os.getenv("RECORDINGS_BUCKET", "recordings_v2")
SIGNED_URL_TTL = int(os.getenv("RECORDING_URL_TTL", str(60 * 60 * 24 * 365)))  # 1 year


def pcm_to_wav(pcm: bytes, sample_rate: int, num_channels: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(num_channels or 1)
        w.setsampwidth(2)  # s16le
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def upload_recording(session_id: str, wav_bytes: bytes) -> str | None:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key and session_id and wav_bytes):
        logger.warning("[rec] missing creds/data — skipping upload")
        return None
    url = url.rstrip("/")
    path = f"{session_id}.wav"
    auth = {"Authorization": f"Bearer {key}", "apikey": key}
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            up = await c.put(
                f"{url}/storage/v1/object/{BUCKET}/{path}",
                headers={**auth, "Content-Type": "audio/wav", "x-upsert": "true"},
                content=wav_bytes,
            )
            up.raise_for_status()
            sign = await c.post(
                f"{url}/storage/v1/object/sign/{BUCKET}/{path}",
                headers={**auth, "Content-Type": "application/json"},
                json={"expiresIn": SIGNED_URL_TTL},
            )
            sign.raise_for_status()
            signed = sign.json()["signedURL"]  # like /object/sign/recordings_v2/..?token=..
            full = f"{url}/storage/v1{signed}"
            logger.info(f"[rec] uploaded recording ({len(wav_bytes)} bytes) for {session_id}")
            return full
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[rec] upload failed: {e}")
        return None
