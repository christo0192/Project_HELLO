"""
Local mic/speaker run of the screening bot (S02 acceptance harness).

  python run_local.py        # talk to Maya; Ctrl-C to stop

Proves the Sarvam STT + Anthropic Haiku + Sarvam TTS integration end-to-end before
we add the browser transport (S03). Needs ANTHROPIC_API_KEY + SARVAM_API_KEY in .env
and a working mic/speaker. (8 kHz TTS sounds telephony-muffled on speakers — expected.)
"""

import asyncio

from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.local.audio import (
    LocalAudioTransport,
    LocalAudioTransportParams,
)

from context import build_screening_context
from pipeline import build_task

load_dotenv()


async def main() -> None:
    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        )
    )

    # No candidate/role ids in local mode -> default flow (override via env if desired).
    system_text, opening_text, _ = await build_screening_context(role_param="the role")
    task = build_task(transport, system_text=system_text, opening_text=opening_text)

    runner = PipelineRunner(handle_sigint=True)
    logger.info("=== Screening bot (local audio) — talk now, Ctrl-C to stop ===")
    await task._greet()  # Maya speaks the AI-disclosure opener first
    await runner.run(task)


if __name__ == "__main__":
    asyncio.run(main())
