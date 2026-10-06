#!/usr/bin/env python3
"""Minimal disposable S0-F media/dispatch worker; never use in production."""

import asyncio
import logging

from livekit import agents, rtc

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("r1-spike")


async def echo_track(track: rtc.Track, source: rtc.AudioSource) -> None:
    """Return subscribed candidate audio to prove inbound and outbound media."""
    stream = rtc.AudioStream(track)
    try:
        async for event in stream:
            await source.capture_frame(event.frame)
    except Exception:
        logger.exception("spike audio echo stopped")


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect(auto_subscribe=agents.AutoSubscribe.AUDIO_ONLY)
    source = rtc.AudioSource(sample_rate=48_000, num_channels=1)
    local_track = rtc.LocalAudioTrack.create_audio_track("r1-spike-echo", source)
    await ctx.room.local_participant.publish_track(local_track)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, publication, participant) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        logger.info("echoing audio from %s", participant.identity)
        asyncio.create_task(echo_track(track, source))

    # A dispatched job remains present until the S0-F candidate leaves.
    await ctx.wait_for_participant()


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint, agent_name="r1-spike"))
