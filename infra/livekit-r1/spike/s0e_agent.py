#!/usr/bin/env python3
"""Disposable S0-E SDK-behaviour probe.  It is fenced to the spike host."""
import asyncio
import logging
import os

from livekit import agents, rtc
from spike_host import assert_spike_url

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("r1-s0e")


def request_low_video_quality(publication: rtc.RemoteTrackPublication) -> None:
    """Request low simulcast, or record the documented single-layer behaviour."""
    try:
        publication.set_video_quality(rtc.VideoQuality.VIDEO_QUALITY_LOW)
    except ValueError as exc:
        # 1.6.4 explicitly rejects the call for a non-simulcast publication.
        # The probe deliberately publishes one 640x360 layer, so this is the
        # expected observable result rather than a job-fatal error.
        logger.info("S0E_VIDEO_QUALITY_SIMULCAST_REQUIRED sid=%s detail=%s", publication.sid, exc)
    else:
        logger.info("S0E_VIDEO_QUALITY_LOW_REQUESTED sid=%s", publication.sid)


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect(auto_subscribe=agents.AutoSubscribe.SUBSCRIBE_ALL)
    logger.info("S0E_AGENT_CONNECTED room=%s", ctx.room.name)

    @ctx.room.on("data_received")
    def unexpected_data(payload, participant, kind, topic):
        # The candidate token forbids data publishing and AgentSession text input
        # is disabled below.  Keep a raw-room marker so the live probe can prove
        # neither delivery path reached this process.
        logger.error("S0E_DATA_RECEIVED_UNEXPECTED identity=%s topic=%s bytes=%s",
                     participant.identity if participant else "<server>", topic, len(payload))

    # 1.6.4 calls this RoomInputOptions.text_enabled, rather than text_input.
    session = agents.AgentSession()
    await session.start(agent=agents.Agent(instructions="S0-E probe"), room=ctx.room,
                        room_input_options=agents.RoomInputOptions(text_enabled=False), record=False)
    logger.info("S0E_SESSION_STARTED text_enabled=false record=false")
    await ctx.room.local_participant.set_attributes({"phase": "ended", "r1_phase": "roleplay"})
    logger.info("S0E_ATTRIBUTES_SET phase=ended r1_phase=roleplay")

    @ctx.room.on("track_muted")
    def muted(participant, publication):
        logger.info("S0E_TRACK_MUTED identity=%s sid=%s", participant.identity, publication.sid)

    @ctx.room.on("track_unmuted")
    def unmuted(participant, publication):
        logger.info("S0E_TRACK_UNMUTED identity=%s sid=%s", participant.identity, publication.sid)

    @ctx.room.on("track_published")
    def published(publication, participant):
        logger.info("S0E_TRACK_PUBLISHED identity=%s kind=%s sid=%s", participant.identity, publication.kind, publication.sid)
        if publication.kind == rtc.TrackKind.KIND_VIDEO:
            request_low_video_quality(publication)

    @ctx.room.on("track_subscribed")
    def subscribed(track, publication, participant):
        logger.info("S0E_TRACK_SUBSCRIBED identity=%s kind=%s sid=%s",
                    participant.identity, track.kind, publication.sid)

    @ctx.room.on("track_unpublished")
    def unpublished(publication, participant):
        logger.info("S0E_TRACK_UNPUBLISHED identity=%s kind=%s sid=%s", participant.identity, publication.kind, publication.sid)

    candidate = await ctx.wait_for_participant()
    for publication in candidate.track_publications.values():
        if publication.kind == rtc.TrackKind.KIND_VIDEO:
            request_low_video_quality(publication)
    await asyncio.get_running_loop().create_future()


async def accept_job(request: agents.JobRequest) -> None:
    """Expose the same worker-side availability boundary used by the echo probe."""
    logger.info("S0E_DISPATCH_RECEIVED room=%s", request.room.name)
    await request.accept()
    logger.info("S0E_AVAILABILITY_ACCEPTED room=%s", request.room.name)


def worker_options() -> agents.WorkerOptions:
    """Build the disposable worker with the same explicit diagnostic override as S0-F."""
    assert_spike_url(os.environ.get("LIVEKIT_URL", ""))
    options: dict[str, object] = {
        "entrypoint_fnc": entrypoint,
        "request_fnc": accept_job,
        "agent_name": "r1-spike",
        "log_level": "DEBUG",
    }
    load_threshold = os.environ.get("R1_SPIKE_LOAD_THRESHOLD")
    if load_threshold is not None:
        if load_threshold.strip().lower() != "inf":
            raise RuntimeError("R1_SPIKE_LOAD_THRESHOLD only supports the diagnostic value 'inf'")
        # In livekit-agents 1.6.4 an infinite threshold retains ordinary load
        # measurement while preventing the busy laptop from withdrawing this
        # disposable worker before dispatch.
        options["load_threshold"] = float("inf")
        logger.info("S0E_LOAD_OVERRIDE threshold=inf")
    else:
        logger.info("S0E_LOAD_OVERRIDE threshold=default")
    return agents.WorkerOptions(**options)


if __name__ == "__main__":
    agents.cli.run_app(worker_options())
