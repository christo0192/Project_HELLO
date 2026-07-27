"""
Browser (WebRTC) screening server — S03.

Serves a minimal browser client and runs the SAME pipeline (pipeline.build_task)
over Pipecat's SmallWebRTCTransport — no Daily/LiveKit account needed.

  python server.py                 # then open http://localhost:7860

NEEDS LIVE VERIFY: SmallWebRTC APIs are version-sensitive across pipecat releases.
If imports/signatures differ, align with the installed pipecat's small_webrtc example.
Query params ?candidate_id=&role_id=&name=&role= personalize + enable persistence.
"""

import asyncio
import os

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

import realtime_broadcast
import recording
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection

import db
from context import build_screening_context
from pipeline import build_task
from transcript import TranscriptRecorder

load_dotenv()

app = FastAPI()
_connections: dict[str, SmallWebRTCConnection] = {}
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
API_BASE = os.getenv("API_BASE", "http://localhost:8787")


async def _trigger_scoring(session_id: str) -> None:
    """Fire the Node API's claude -p scoring for this session (best-effort)."""
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"{API_BASE}/api/assess/{session_id}")
            logger.info(f"[bot] scoring triggered for {session_id}: HTTP {r.status_code}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[bot] scoring trigger failed (score it from the dashboard): {e}")


async def _run_bot(conn: SmallWebRTCConnection, ctx: dict):
    # NOTE: FastAPI BackgroundTasks swallow exceptions, so we log everything here.
    logger.info(f"[bot] starting | candidate={ctx.get('candidate_id')} role={ctx.get('role')}")
    recorder = None
    session_id = None
    audiobuffer = None
    rec_holder: dict = {"wav": None}
    try:
        # WebRTC output rate: browser/Opus-friendly. Sarvam still SYNTHESIZES at
        # TTS_SAMPLE_RATE (8k telephony); pipecat resamples up to this for the browser.
        out_rate = int(os.getenv("WEBRTC_OUT_SAMPLE_RATE", "24000"))
        transport = SmallWebRTCTransport(
            webrtc_connection=conn,
            params=TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                # input rate MUST match DeepgramFluxSTTService.sample_rate.
                audio_in_sample_rate=int(os.getenv("STT_SAMPLE_RATE", "16000")),
                audio_out_sample_rate=out_rate,
            ),
        )

        recorder = TranscriptRecorder()

        # Records mixed user+bot audio → WAV on stop.
        audiobuffer = AudioBufferProcessor(num_channels=1)

        @audiobuffer.event_handler("on_audio_data")
        async def _on_audio_data(_buf, audio, sample_rate, num_channels):  # noqa: ANN001
            rec_holder["wav"] = recording.pcm_to_wav(audio, sample_rate, num_channels)

        system_text, opening_text, _ = await build_screening_context(
            candidate_id=ctx.get("candidate_id"), role_id=ctx.get("role_id"),
            name_param=ctx.get("name"), role_param=ctx.get("role"),
        )
        task = build_task(
            transport,
            system_text=system_text,
            opening_text=opening_text,
            transcript_processors=recorder.pipeline_processors(),
            audio_buffer=audiobuffer,
        )

        session_id = await db.create_session(ctx.get("candidate_id"), ctx.get("role_id"), mode="browser")
        recorder.set_session(session_id)  # turns now write LIVE to this session

        # Wire up Flux interim-transcript events → Realtime broadcast so the
        # dashboard can show a live "typing" bubble while the candidate speaks.
        if getattr(task, "_stt", None):
            @task._stt.event_handler("on_update")
            async def _on_interim(_service, transcript):  # noqa: ANN001
                await realtime_broadcast.broadcast_interim(session_id, transcript)

            @task._stt.event_handler("on_end_of_turn")
            async def _on_eot(_service, *a):  # noqa: ANN001
                await realtime_broadcast.clear_interim(session_id)

        @transport.event_handler("on_client_connected")
        async def _connected(_t, _c):  # noqa: ANN001
            logger.info("[bot] client connected -> Maya greeting")
            try:
                await audiobuffer.start_recording()  # begin capturing the call
                await task._greet()  # AI-disclosure opener
            except Exception:  # noqa: BLE001
                logger.exception("[bot] greet/record-start failed")

        @transport.event_handler("on_client_disconnected")
        async def _disconnected(_t, _c):  # noqa: ANN001
            logger.info("[bot] client disconnected")
            await task.cancel()

        runner = PipelineRunner(handle_sigint=False)
        logger.info("[bot] runner starting")

        async def _watchdog():  # safety: hard cap on call length
            await asyncio.sleep(int(os.getenv("MAX_CALL_SECS", "600")))
            logger.info("[bot] max call duration reached — ending")
            await task.cancel()

        wd = asyncio.create_task(_watchdog())
        try:
            await runner.run(task)
        finally:
            wd.cancel()
        logger.info("[bot] runner finished")
    except Exception:  # noqa: BLE001
        logger.exception("[bot] _run_bot CRASHED")
    finally:
        try:
            # Stop recording -> on_audio_data fires with the full mixed WAV -> upload.
            if audiobuffer is not None:
                try:
                    await audiobuffer.stop_recording()
                    if rec_holder["wav"] and session_id:
                        url = await recording.upload_recording(session_id, rec_holder["wav"])
                        await db.set_recording_url(session_id, url)
                except Exception:  # noqa: BLE001
                    logger.exception("[bot] recording upload failed")
            await db.complete_session(session_id)  # turns already saved live
            if session_id:
                await _trigger_scoring(session_id)  # transcript -> scorecard
        except Exception:  # noqa: BLE001
            logger.exception("[bot] cleanup failed")
        try:
            await conn.disconnect()  # close the WebRTC peer so the browser call ends
        except Exception:  # noqa: BLE001
            pass


@app.post("/api/offer")
async def offer(request: Request, background_tasks: BackgroundTasks):
    body = await request.json()
    pc_id = body.get("pc_id")

    if pc_id and pc_id in _connections:
        conn = _connections[pc_id]
        await conn.renegotiate(sdp=body["sdp"], type=body["type"])
        return conn.get_answer()

    conn = SmallWebRTCConnection(
        ice_servers=[IceServer(urls="stun:stun.l.google.com:19302")]
    )
    await conn.initialize(sdp=body["sdp"], type=body["type"])

    @conn.event_handler("closed")
    async def _closed(c: SmallWebRTCConnection):  # noqa: ANN001
        _connections.pop(c.pc_id, None)

    _connections[conn.pc_id] = conn
    ctx = {k: body.get(k) for k in ("candidate_id", "role_id", "name", "role")}
    background_tasks.add_task(_run_bot, conn, ctx)
    return conn.get_answer()


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    logger.info("=== Screening WebRTC server on http://localhost:7860 ===")
    uvicorn.run(app, host="0.0.0.0", port=7860)
