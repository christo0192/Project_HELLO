#!/usr/bin/env python3
"""Minimal disposable S0-F media/dispatch worker; never use in production."""

import asyncio
import logging
import os

from livekit import agents, rtc
from spike_host import assert_spike_url

logging.basicConfig(level=logging.DEBUG)
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
    # Per-room markers are intentionally limited to the disposable test room name.
    # They let the laptop diagnostic distinguish dispatch delivery from a later
    # connection or publication failure without logging credentials or media.
    room_name = ctx.job.room.name
    logger.info("S0F_DISPATCH_RECEIVED room=%s", room_name)
    await ctx.connect(auto_subscribe=agents.AutoSubscribe.AUDIO_ONLY)
    logger.info("S0F_AGENT_CONNECTED room=%s", room_name)
    source = rtc.AudioSource(sample_rate=48_000, num_channels=1)
    local_track = rtc.LocalAudioTrack.create_audio_track("r1-spike-echo", source)
    await ctx.room.local_participant.publish_track(local_track)
    logger.info("S0F_AUDIO_PUBLISHED room=%s", room_name)

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


async def accept_job(request: agents.JobRequest) -> None:
    """Log the worker-side acceptance boundary for the disposable diagnosis."""
    room_name = request.room.name
    logger.info("S0F_AVAILABILITY_ACCEPTING room=%s", room_name)
    await request.accept()
    # `accept()` only returns after the SFU has sent an assignment, so this is
    # stronger evidence than the request-received marker alone.
    logger.info("S0F_AVAILABILITY_ACCEPTED room=%s", room_name)


def worker_options() -> agents.WorkerOptions:
    """Build disposable-worker options, including the explicit load experiment."""
    assert_spike_url(os.environ.get("LIVEKIT_URL", ""))
    options: dict[str, object] = {
        "entrypoint_fnc": entrypoint,
        "request_fnc": accept_job,
        "agent_name": "r1-spike",
        # 1.6.4 supports this WorkerOptions argument; retain protocol debug
        # output for availability, assignment, and reconnect diagnosis.
        "log_level": "DEBUG",
    }
    load_threshold = os.environ.get("R1_SPIKE_LOAD_THRESHOLD")
    if load_threshold is not None:
        if load_threshold.strip().lower() != "inf":
            raise RuntimeError("R1_SPIKE_LOAD_THRESHOLD only supports the diagnostic value 'inf'")
        # In livekit-agents 1.6.4 an infinite threshold makes `_is_available`
        # return True, while retaining the SDK's ordinary load measurements.
        options["load_threshold"] = float("inf")
        logger.info("S0F_LOAD_OVERRIDE threshold=inf")
    else:
        logger.info("S0F_LOAD_OVERRIDE threshold=default")
    return agents.WorkerOptions(**options)


if __name__ == "__main__":
    agents.cli.run_app(worker_options())
