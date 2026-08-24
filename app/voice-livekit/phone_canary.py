"""Canary-1 — the owner's own-number test call, and nothing else.

This module is the WORKER half of a mechanism whose whole purpose is to place
exactly one call, to the system owner's own handset, and prove that transport,
audio, STT, TTS and the LLM work end to end over a real carrier — WITHOUT a
candidate row, without an admission, and without weakening any gate that
protects a real candidate.

It is reached only when all three of these hold:

  1. ``PHONE_CANARY_ENABLED=true`` in this worker's environment (a Fly app
     SECRET, absent from ``fly.phone.toml`` and from version control);
  2. the DISPATCH metadata says ``mode == "canary"``;
  3. the ROOM metadata says ``canary is true``.

Two independent metadata signals, both parsed by ``phone._canary_blob``'s
closed-key and digit-run guard, and both from key sets the PRODUCTION builders
structurally cannot emit. A mismatch is a refusal, not a fallback.

── WHAT THIS MODULE STRUCTURALLY CANNOT DO ──────────────────────────────

It does not import ``PhoneEventClient`` and names none of the five worker API
paths, so it posts no events, starts no assessment, commits no boundary and
renews no lease. It imports no persistence, so it writes no row. It never
constructs ``phone.phone_agent_class`` — whose constructor requires a client
and an attempt id — so it has no function tools and cannot schedule a callback.
It never enumerates a participant attribute map, because ``sip.phoneNumber`` is
auto-populated by LiveKit and enumerating that map is precisely how a phone
number reaches a log line. A source-level test asserts each of these with a
seeded positive control.

── AND WHAT IT SHARES WITH PRODUCTION, DELIBERATELY ─────────────────────

The provider pipeline, and only that. The ``AgentSession`` is built by
``agent._build_phone_provider_session`` — passed in rather than imported, so
this module has no cycle back into ``agent`` — which is the SAME single
construction site ``_run_phone_session`` uses. A canary running its own copy of
the model wiring would go green while a drifted ``SARVAM_TTS_VOICE`` or
``GEMINI_MODEL`` left production broken.

What it does NOT share is the screening AGENT: it drives a bare ``Agent`` with
fixed instructions. ``phone_agent_class``, its tools, the human/machine
classifier and ``run_phone_gate``'s ordering are unexercised. Read
``docs/runbooks/phone-canary1.md`` §"What a green run does not prove" before
treating a green canary as coverage.

── RECORDING ────────────────────────────────────────────────────────────

``session.start`` receives ``record=dict(phone.PHONE_NO_RECORDING)`` — the SAME
imported object the production phone session uses, never a second literal. The
canary's spoken disclosure says "this call is not being recorded", so a dropped
or drifted kwarg here is not a bug, it is the system telling a person something
untrue while recording them.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import phone
from observability import StructuredLogger

_log = StructuredLogger("phone_canary")


# ── Fixed spoken copy ─────────────────────────────────────────────────
# Constants, not model output, and pinned BYTE-FOR-BYTE against the TypeScript
# copies in `app/api/src/lib/phone-canary1/plan.ts` by
# `phone-canary1-cross-language.test.ts`. They are deliberately NOT sent over
# the dispatch metadata: metadata is a channel other readers can see, and it is
# parsed by a guard that refuses digit runs. Fixed copy belongs in source,
# where a reviewer reads it and a diff shows a change.
#
# The company name is a literal here rather than `phone._COMPANY`, because a
# two-sided pin cannot compare against a value that varies by environment — and
# because this copy is going to TEL-04 for approval exactly as written.

#: NOT `phone.PHONE_DISCLOSURE_TEXT`. That copy says the call IS recorded,
#: because a production screening is; reusing it here would make the system say
#: something false. This copy needs its own TEL-04 approval, and that approval
#: is ordered AFTER the `record=` control above is in place — approving copy the
#: system does not honour is worse than approving none.
CANARY_DISCLOSURE_TEXT = (
    "This is an automated test call from Interview Kickstart's screening system, "
    "placed by the system owner to their own number. No candidate is involved, "
    "this call is not being recorded, and nothing you say is stored. "
    "I'll ask a few short questions to check the audio and then hang up."
)

#: Open enough to produce a real answer — the point is turn-taking, barge-in,
#: latency and the model responding to something it did not script — and closed
#: enough to be safe to speak to a handset.
CANARY_QUESTIONS: tuple[str, ...] = (
    "First, can you hear me clearly, and is there any echo or delay on the line?",
    "Second, please say todays day of the week and describe the weather where you are.",
    "Third, please count slowly from one to five so I can check the audio end to end.",
)

#: Claims nothing about a recording, because there is none.
CANARY_CLOSING_TEXT = (
    "That is everything I needed. Thanks for taking the test call. Goodbye."
)

#: The bare agent's instructions. It is told what it is, and told not to
#: improvise a screening — a model that started interviewing the owner would be
#: a conversation nobody scripted going out over a real carrier.
CANARY_AGENT_INSTRUCTIONS = (
    "You are running a short automated audio test call. Acknowledge what the "
    "person says in one brief sentence and nothing more. Do not ask questions "
    "of your own, do not interview anyone, do not offer help, and do not "
    "discuss any job, role or application."
)

#: Bound on ONE answer. A bound, not a target: without it a handset left on a
#: table holds the leg until the outer ceiling.
CANARY_ANSWER_TIMEOUT_SEC = 30.0

#: The stable refusal codes this module may log. Never a sentence, never a value.
CANARY_REFUSALS = (
    "canary_already_run",
    "canary_no_participant",
    "canary_deadline_exceeded",
)


# ── The one-shot latch ────────────────────────────────────────────────
# PER PROCESS, and module-level on purpose. Without it an armed worker is a
# STANDING CONVERSATIONAL ENDPOINT: every canary-shaped dispatch it ever
# receives would be answered with a live conversation, indefinitely, and the
# only thing stopping a second call would be nobody sending a second dispatch.
#
# Combined with the CLI's own single-shot latch and the operator's scale-down,
# arming this worker buys exactly one conversation.
_canary_ran = False


def reset_canary_latch() -> None:
    """Reset the one-shot latch. TEST-ONLY.

    Named so it is greppable and obvious. Production has no caller: the latch's
    whole value is that nothing in the running program can clear it.
    """
    global _canary_ran
    _canary_ran = False


def canary_has_run() -> bool:
    """Whether this process has already conducted its one canary call."""
    return _canary_ran


async def _say(session: Any, text: str) -> None:
    """Speak a fixed line and wait for it to actually play out.

    Mirrors the production `say` helper. Waiting matters: without it the next
    line is queued before the previous one has been heard, and a two-question
    audio test that talks over itself proves nothing about audio.
    """
    speech = session.say(text, allow_interruptions=False)
    wait_for_playout = getattr(speech, "wait_for_playout", None)
    if callable(wait_for_playout):
        await wait_for_playout()


async def run_phone_canary(
    ctx: Any,
    room_name: str,
    canary_id: str,
    *,
    session_factory: Callable[[], Any],
    agent_factory: Callable[..., Any],
    close_room: Callable[[str], Awaitable[Any]],
    wait_for_participant: Callable[[], Awaitable[Any]],
) -> str:
    """Conduct the canary call, once, bounded, and tear the room down.

    Returns a stable outcome code. Every dependency is injected rather than
    imported, which is what keeps this module free of a cycle back into
    ``agent`` and free of any path to the event client.
    """
    global _canary_ran
    if _canary_ran:
        # Refused WITHOUT connecting. A second canary job must not produce a
        # second conversation, and must not produce a room this worker has
        # joined and then abandoned.
        _log.warn("unknown_event", error_type="phone_canary_refused",
                  error_category="canary_already_run")
        return "canary_already_run"
    _canary_ran = True

    _log.info("unknown_event", error_type="phone_canary_start", schema=canary_id)
    await ctx.connect()

    session = session_factory()
    turns: "asyncio.Queue[str]" = asyncio.Queue()

    @session.on("conversation_item_added")
    def _on_item(event):  # noqa: ANN001
        item = getattr(event, "item", None)
        if getattr(item, "role", None) != "user":
            return
        text = _item_text(item)
        if text:
            turns.put_nowait(text)

    outcome = "canary_completed"
    try:
        # ── ORDER IS LOAD-BEARING: WAIT, THEN START ───────────────────
        # The session is opened only AFTER something has answered, exactly as
        # the production path does it. With the start on the other side of this
        # wait there is a code path on which the agent speaks, runs a turn or
        # starts a timer into a RINGING line — measuring the network rather
        # than the person.
        participant = await wait_for_participant()
        if participant is None:
            _log.warn("unknown_event", error_type="phone_canary_refused",
                      error_category="canary_no_participant")
            return "canary_no_participant"

        await session.start(
            agent=agent_factory(CANARY_AGENT_INSTRUCTIONS),
            room=ctx.room,
            # THE SAME IMPORTED OBJECT as the production phone session. Never a
            # second literal — see the module docstring.
            record=dict(phone.PHONE_NO_RECORDING),
        )

        await asyncio.wait_for(
            _converse(session, turns), timeout=phone.canary_max_call_sec(),
        )
    except asyncio.TimeoutError:
        # The ceiling fired. The call ENDS; it is never extended, and the
        # timeout is not retried.
        outcome = "canary_deadline_exceeded"
        _log.warn("unknown_event", error_type="phone_canary_refused",
                  error_category="canary_deadline_exceeded")
    finally:
        # The worker's own deleter, independent of the CLI's. Two deleters plus
        # the room's `emptyTimeout` means no single point of failure, and a
        # room whose processes both died still reaps itself.
        await close_room(room_name)

    _log.info("unknown_event", error_type="phone_canary_outcome", error_category=outcome)
    return outcome


async def _converse(session: Any, turns: "asyncio.Queue[str]") -> None:
    """Disclosure, N fixed questions with a bounded wait each, closing line."""
    await _say(session, CANARY_DISCLOSURE_TEXT)

    asked = min(phone.canary_questions(), len(CANARY_QUESTIONS))
    for index in range(asked):
        await _say(session, CANARY_QUESTIONS[index])
        answered = await _await_answer(turns)
        if not answered:
            # A silent answer is not a failure of the call — it is one datum
            # about this leg. The sequence continues so the operator still
            # hears the remaining questions and the closing line, and the
            # bounded wait has already stopped the leg hanging.
            continue
        reply = session.generate_reply(instructions=CANARY_AGENT_INSTRUCTIONS)
        wait_for_playout = getattr(reply, "wait_for_playout", None)
        if callable(wait_for_playout):
            await wait_for_playout()

    await _say(session, CANARY_CLOSING_TEXT)


async def _await_answer(turns: "asyncio.Queue[str]") -> bool:
    """Wait, bounded, for one candidate turn. True when something was said."""
    try:
        await asyncio.wait_for(turns.get(), timeout=CANARY_ANSWER_TIMEOUT_SEC)
        return True
    except asyncio.TimeoutError:
        return False


def _item_text(item: Any) -> str:
    """Flatten a conversation item's content to text, defensively.

    Never logged, never queued anywhere durable, and never inspected for
    anything but emptiness by the caller.
    """
    content = getattr(item, "content", None)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, (list, tuple)):
        parts = []
        for chunk in content:
            text = getattr(chunk, "text", None)
            if isinstance(text, str):
                parts.append(text)
            elif isinstance(chunk, str):
                parts.append(chunk)
        return " ".join(parts).strip()
    text = getattr(item, "text_content", None)
    return text.strip() if isinstance(text, str) else ""
