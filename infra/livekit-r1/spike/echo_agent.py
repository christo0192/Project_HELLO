#!/usr/bin/env python3
"""Minimal disposable S0-F media/dispatch worker; never use in production."""

import asyncio
import logging
import os
from urllib.parse import urlparse

from livekit import agents, rtc

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("r1-spike")


def assert_spike_url() -> None:
    """Refuse Cloud, production, and any endpoint outside this disposable app."""
    value = os.environ.get("LIVEKIT_URL", "")
    host = (urlparse(value).hostname or "").lower()
    allowed = os.environ.get("R1_SPIKE_ALLOWED_HOST", "").lower()
    suffix = "-r1-rtc-spike.fly.dev"
    is_fly_spike = host.endswith(suffix) and host[:-len(suffix)].replace("-", "").isalnum()
    if not host or host.endswith(".livekit.cloud") or host == "project-hello-r1-rtc.fly.dev" or (not is_fly_spike and host != allowed):
        raise RuntimeError(f"LIVEKIT_URL is not an approved disposable spike host: {host or '<missing>'}")


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

    echo_tasks: set[asyncio.Task[None]] = set()
    echoed_track_sids: set[str] = set()
    candidate_identity: str | None = None
    candidate_left = asyncio.get_running_loop().create_future()

    def start_echo(track: rtc.Track, participant) -> None:
        if candidate_identity is None or participant.identity != candidate_identity or track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if track.sid in echoed_track_sids:
            return
        echoed_track_sids.add(track.sid)
        logger.info("echoing audio from %s", participant.identity)
        task = asyncio.create_task(echo_track(track, source))
        echo_tasks.add(task)
        task.add_done_callback(echo_tasks.discard)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, publication, participant) -> None:
        start_echo(track, participant)

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant) -> None:
        if candidate_identity == participant.identity and not candidate_left.done():
            candidate_left.set_result(None)

    # A dispatched job remains present until the S0-F candidate leaves.
    candidate = await ctx.wait_for_participant()
    candidate_identity = candidate.identity
    for publication in candidate.track_publications.values():
        if publication.track is not None:
            start_echo(publication.track, candidate)
    logger.info("candidate %s joined; waiting for disconnect", candidate_identity)
    try:
        await candidate_left
    finally:
        pending_tasks = tuple(echo_tasks)
        for task in pending_tasks:
            task.cancel()
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)
        await source.aclose()


if __name__ == "__main__":
    assert_spike_url()
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint, agent_name="r1-spike"))
