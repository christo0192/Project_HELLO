"""R1 turn taking and per-turn latency measurement (plan 5.15, "measure first").

Two independent, SDK-free pieces live here so both are unit-testable without a session:

* ``r1_turn_handling``: the endpointing, interruption and preemptive-generation options R1
  hands the ``AgentSession``.  The values are endpointing 0.8 / 3.0 s, interruption
  ``min_duration`` 0.8 s and ``min_words`` 3 (R1-Q: the owner's 4/10 session showed 0.3 s
  committing a turn on a breath and a two-word "Thank you" cutting a reply; the phone lane
  settled on the same 0.8 s / 3 words).  The SDK's own defaults are quicker to commit and
  quicker to cut in: its streaming turn detector (the session default) uses 0.3 / 2.5 s and
  its interruption defaults are 0.5 s and 0 words, which lets a "yeah" or a cough cut a reply.
  Each value is bounded and can be tuned from the environment during Stage A.  The
  transition phase, where the only thing the candidate says is "ready", runs a quicker pair
  (``r1_transition_endpointing``, 0.4 / 1.2 s, never above the session's own).  Preemptive
  generation stays OFF; ``r1_session`` explains why.

* ``LatencyTracker``: stamps the stages of one candidate turn and hands every segment to an
  ``emit`` callback.  ``r1_session`` turns each call into one structured ``r1`` log line
  (``r1_latency``), because the metric sink is a no-op (``observability.py``).  The tracker
  keeps no text and no identifier: stages, a turn index, a phase and a duration only.

The anchor of every ``eou_to_*`` segment is the candidate's end of speech as the SDK reports
it (``user_state_changed`` leaving ``speaking``).  That is the same anchor the phone lane's
headline uses (``voice_phone_headline_latency``), so the two lanes read the same way.  When
that event was missed the final transcript is used, and failing that the turn hook; the anchor
kind travels with the turn so a reader can tell them apart.

The tracker also keeps the headline values so the session can report one number to the API gate
(plan 6.4, ``session_facts.first_audio_p95_ms``): the nearest-rank p95 of the role-play turns,
in milliseconds, and ``None`` (unknown, which the gate fails closed on) when fewer than 8 role-play
turns were measured.  A turn whose reply was cancelled before any audio never gets a first audio,
so its wait so far is kept as a lower bound (``reply_lost``): the slowest turns are the ones that
are cancelled, and the p95 must not be able to leave them out.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
from collections import deque
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------------------- turn handling

ENDPOINT_MIN_DELAY_SEC = 0.8
ENDPOINT_MAX_DELAY_SEC = 3.0
INTERRUPT_MIN_DURATION_SEC = 0.8
INTERRUPT_MIN_WORDS = 3
# The transition phase waits for one word ("ready"), so a turn there commits quickly.  These are
# CEILINGS on the session's own numbers (``r1_transition_endpointing``), never a way to wait longer.
TRANSITION_ENDPOINT_MIN_DELAY_SEC = 0.4
TRANSITION_ENDPOINT_MAX_DELAY_SEC = 1.2


def _bounded_float(raw: str | None, default: float, low: float, high: float) -> float:
    """Parse a finite float and clamp it, so an environment typo cannot disable a bound."""
    try:
        value = float(raw) if raw is not None and raw.strip() != "" else default
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    return min(high, max(low, value))


def endpoint_min_delay_sec() -> float:
    """Silence after the last speech before the turn may end (SDK default 0.3 s streaming)."""
    return _bounded_float(
        os.getenv("R1_ENDPOINT_MIN_DELAY_SEC"), ENDPOINT_MIN_DELAY_SEC, 0.2, 2.0
    )


def endpoint_max_delay_sec() -> float:
    """The longest the agent waits for a turn to be declared (SDK default 2.5 s streaming)."""
    return _bounded_float(
        os.getenv("R1_ENDPOINT_MAX_DELAY_SEC"), ENDPOINT_MAX_DELAY_SEC, 1.0, 8.0
    )


def interrupt_min_duration_sec() -> float:
    """Speech length that counts as an interruption (SDK default 0.5 s)."""
    return _bounded_float(
        os.getenv("R1_INTERRUPT_MIN_DURATION_SEC"), INTERRUPT_MIN_DURATION_SEC, 0.3, 2.0
    )


def interrupt_min_words() -> int:
    """Words that must be heard before an interruption counts (SDK default 0)."""
    return int(
        _bounded_float(os.getenv("R1_INTERRUPT_MIN_WORDS"), float(INTERRUPT_MIN_WORDS), 0.0, 6.0)
    )


# Characters livekit-agents counts as a word each (CJK scripts and Thai), and the punctuation it
# strips before deciding whether a token is a word: ``tokenize.basic.split_words`` as 1.6.4 calls
# it for ``min_words`` (``split_character=True``).  ``tests/test_r1_sdk_contract.py`` compares the
# two, so a change in the SDK is noticed.
_CHARACTER_WORDS = re.compile("[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf\u0e00-\u0e7f]")
_SDK_PUNCTUATION = str.maketrans(
    "",
    "",
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    "\u00b1\u2014\u2018\u2019\u201c\u201d\u2026",
)


def count_words(text: str) -> int:
    """How many words the SDK counts in ``text`` when it applies ``min_words``."""
    words = 0
    for token in text.split():
        pieces = _CHARACTER_WORDS.split(token)
        words += len(pieces) - 1  # every character-based letter is a word of its own
        words += sum(1 for piece in pieces if piece.translate(_SDK_PUNCTUATION))
    return words


def r1_turn_handling() -> dict[str, Any]:
    """The ``TurnHandlingOptions`` R1 gives its ``AgentSession`` (a plain dict is accepted).

    ``turn_detection`` is deliberately absent: the browser lane's detector stays what the
    session selects, and only the timings around it are R1's.  Interruption options are read
    from the SESSION by livekit-agents 1.6.4 (an agent-level ``interruption`` carries only
    ``enabled`` and ``mode``), which is why these belong on the session and not on ``R1Agent``.
    """
    minimum = endpoint_min_delay_sec()
    return {
        "endpointing": {
            "min_delay": minimum,
            # The maximum may never undercut the minimum, whatever the environment says.
            "max_delay": max(endpoint_max_delay_sec(), minimum),
        },
        "interruption": {
            "min_duration": interrupt_min_duration_sec(),
            "min_words": interrupt_min_words(),
        },
        "preemptive_generation": {"enabled": False},
    }


def r1_transition_endpointing() -> dict[str, float]:
    """The endpointing pair for the TRANSITION phase: the session's, capped at 0.4 / 1.2 s.

    The candidate's only job there is to say "ready", so a short turn should commit quickly.
    The pair never exceeds the session's own (an operator who lowered
    ``R1_ENDPOINT_MIN_DELAY_SEC`` below 0.4 s keeps the lower value), and its maximum never
    undercuts its minimum.  Handed to ``AgentSession.update_options(endpointing_opts=...)`` on
    entering the phase; ``r1_turn_handling()["endpointing"]`` is what restores the session's.
    """
    session = r1_turn_handling()["endpointing"]
    minimum = min(session["min_delay"], TRANSITION_ENDPOINT_MIN_DELAY_SEC)
    maximum = max(min(session["max_delay"], TRANSITION_ENDPOINT_MAX_DELAY_SEC), minimum)
    return {"min_delay": minimum, "max_delay": maximum}


# ----------------------------------------------------------------------- latency tracker

# emit(schema, seconds, *, category, phase, turn_index)
Emit = Callable[..., None]

# A duration outside this range is a clock artefact (a stale anchor, a stepped clock), not a
# latency, and would poison a percentile.
_MAX_SEGMENT_SEC = 600.0
_MAX_PENDING_SAYS = 16
# The headline samples kept for the session's p95.  A whole interview is a few dozen turns;
# the bound only stops a runaway session from growing the list (the newest samples win).
_MAX_HEADLINE_SAMPLES = 512
# What the plan 6.4 gate reads (``session_facts.first_audio_p95_ms``): the learner's turns, i.e.
# the role-play phase, and at least as many of them as the gate's own ``MIN_QUALIFYING_TURNS``.
GATE_PHASE = "roleplay"
GATE_MIN_SAMPLES = 8


def _valid_segment(seconds: float) -> bool:
    return math.isfinite(seconds) and 0.0 <= seconds <= _MAX_SEGMENT_SEC


@dataclass
class _Turn:
    index: int | None
    phase: str
    anchor: float
    anchor_kind: str
    kind: str
    marks: dict[str, float] = field(default_factory=dict)
    seq: int = 0  # the tracker's own running number: how a lost reply finds its turn again
    lost: bool = False  # the reply was cancelled before any audio (``reply_lost``)


# How many recent turns ``reply_lost`` can still find.  A reply is cancelled within moments of
# its turn, so the next turn or two is as far back as it ever looks.
_RECENT_TURNS = 4


class LatencyTracker:
    """Stamp one candidate turn at a time and report every segment exactly once.

    Segments (``schema`` values), measured in seconds:

    ``eou_to_turn_hook``
        End of speech to ``on_user_turn_completed``: the SDK's endpointing and transcript
        wait.  This is the window a preemptive generation could overlap, so it is the number
        that prices the decision to leave preemptive generation off.
    ``eou_to_llm_first_token`` / ``llm_ttft``
        From end of speech, and from the start of the model call, to the first text delta.
    ``eou_to_guard_release`` / ``guard_hold``
        To the first vetted sentence leaving the output guard, and the time the guard held it
        after the first token (it releases a sentence only once the next one has begun).
    ``ack``
        The acknowledgement before an owed line: seconds from the model call to its end,
        with the outcome (``done``, ``cutoff`` or ``failed``) as the category.
    ``eou_to_tts_first_frame`` / ``tts_ttfb``
        To the first audio frame the TTS node produced, and its time from the first text.
    ``eou_to_first_audio``
        The headline: end of speech to the agent's audio starting.  Its category is the turn
        kind (``llm_reply``, ``ack_then_say``, ``say_only`` or ``reply``).  Every valid value
        is also kept, with its phase, for ``first_audio_p95_ms`` (see below).
    ``eou_to_reply_lost``
        A reply the SDK cancelled before the candidate heard any of it: end of speech to the
        moment it was cancelled.  The turn never reaches ``eou_to_first_audio``, and a turn
        that outlasts the candidate's patience is exactly the one that must not vanish from the
        p95, so this is kept as a LOWER BOUND of that turn's latency (the real wait is longer:
        the candidate was still waiting).  Its category is the turn kind.
    ``say_to_first_audio``
        A scripted line: from ``say`` to its audio starting, the line id as the category.
    """

    def __init__(self, clock: Callable[[], float], emit: Emit) -> None:
        self._clock = clock
        self._emit = emit
        self._speaking = False
        self._stop_at: float | None = None
        self._final_at: float | None = None
        self._turn: _Turn | None = None
        self._seq = 0
        self._recent: deque[_Turn] = deque(maxlen=_RECENT_TURNS)
        self._says: dict[str, tuple[float, str, str]] = {}
        # (phase, seconds) of every headline ``eou_to_first_audio`` that passed the same
        # validity test as a logged segment, plus the lower bound of every turn whose reply was
        # lost: the input of ``first_audio_p95_ms``.
        self._headline: deque[tuple[str, float]] = deque(maxlen=_MAX_HEADLINE_SAMPLES)
        self._lost: deque[str] = deque(maxlen=_MAX_HEADLINE_SAMPLES)  # the phase of each

    # ------------------------------------------------------------------ candidate side

    def note_user_state(self, state: str) -> None:
        """Track the candidate's speaking state; the last stop before a turn is its anchor."""
        if state == "speaking":
            self._speaking = True
            self._stop_at = None  # speech resumed: the earlier stop was a pause, not the end
        elif self._speaking:
            self._speaking = False
            self._stop_at = self._clock()

    def note_final(self) -> None:
        """A final transcript arrived: the fallback anchor when no speech stop was seen."""
        self._final_at = self._clock()

    def begin_turn(self, index: int | None, phase: str, kind: str = "reply") -> None:
        """The SDK handed the turn to the agent (``on_user_turn_completed``): open its record."""
        now = self._clock()
        if self._stop_at is not None:
            anchor, how = self._stop_at, "vad"
        elif self._final_at is not None:
            anchor, how = self._final_at, "final"
        else:
            anchor, how = now, "hook"
        self._stop_at = None
        self._final_at = None
        self._seq += 1
        turn = _Turn(
            index=index,
            phase=phase,
            anchor=min(anchor, now),
            anchor_kind=how,
            kind=kind,
            seq=self._seq,
        )
        turn.marks["hook"] = now
        self._turn = turn
        self._recent.append(turn)
        self._report("eou_to_turn_hook", now - turn.anchor, turn, category=how)

    def set_kind(self, kind: str) -> None:
        """Record what the turn turned out to be (the engine's mode), for the headline."""
        if self._turn is not None:
            self._turn.kind = kind

    def open_turn_id(self) -> int | None:
        """The running number of the open turn, for ``reply_lost`` to find it again later."""
        return None if self._turn is None else self._turn.seq

    def reply_lost(self, turn_id: int | None) -> None:
        """The reply to turn ``turn_id`` was cancelled before the candidate heard any of it.

        Without this the turn would simply never be measured: ``first_audio`` is the only thing
        that adds a headline sample, so the turns whose reply was cancelled while the candidate
        waited (the dead air of the owner's 4/10 session) would be missing from the p95 that the
        gate compares with 3 s, and a session in which the candidate sat through silence could
        pass.  The seconds from the end of speech to the cancellation are added as a sample and
        logged as ``eou_to_reply_lost``.  It is a lower bound (the wait went on after the
        cancellation, into the next reply), which is the safe side for a percentile.  A turn is
        counted once, and never together with a first audio of its own.
        """
        if turn_id is None:
            return
        turn = next((item for item in reversed(self._recent) if item.seq == turn_id), None)
        if turn is None or turn.lost or "first_audio" in turn.marks:
            return
        now = self._clock()
        turn.lost = True
        turn.marks["lost"] = now
        seconds = now - turn.anchor
        if _valid_segment(seconds):
            self._headline.append((turn.phase, seconds))
            self._lost.append(turn.phase)
            self._report("eou_to_reply_lost", seconds, turn)

    def replies_lost(self, phase: str | None = GATE_PHASE) -> int:
        """How many of the ``first_audio_samples`` of ``phase`` are lower bounds of a lost reply."""
        return sum(1 for ph in self._lost if phase is None or ph == phase)

    # --------------------------------------------------------------------- reply side

    def mark(self, stage: str, outcome: str | None = None) -> None:
        """Stamp ``stage`` for the open turn (the first stamp wins) and report its segments."""
        turn = self._turn
        if turn is None or stage in turn.marks:
            return
        if turn.lost and stage == "first_audio":
            return  # its reply was cancelled: whatever plays now is not that reply
        now = self._clock()
        turn.marks[stage] = now
        marks = turn.marks
        if stage == "llm_first_token":
            self._report("eou_to_llm_first_token", now - turn.anchor, turn)
            if "llm_start" in marks:
                self._report("llm_ttft", now - marks["llm_start"], turn)
        elif stage == "guard_release":
            self._report("eou_to_guard_release", now - turn.anchor, turn)
            if "llm_first_token" in marks:
                self._report("guard_hold", now - marks["llm_first_token"], turn)
        elif stage == "ack":
            start = marks.get("llm_start")
            if start is not None:
                self._report("ack", now - start, turn, category=outcome or "done")
        elif stage == "tts_first_frame":
            self._report("eou_to_tts_first_frame", now - turn.anchor, turn)
            if "tts_first_text" in marks:
                self._report("tts_ttfb", now - marks["tts_first_text"], turn)
        elif stage == "first_audio":
            seconds = now - turn.anchor
            self._report("eou_to_first_audio", seconds, turn)
            if _valid_segment(seconds):
                self._headline.append((turn.phase, seconds))

    def first_audio(self) -> None:
        """The agent's audio for the open turn started playing."""
        self.mark("first_audio")

    # ----------------------------------------------------------------- the session's p95

    def first_audio_samples(self, phase: str | None = GATE_PHASE) -> int:
        """How many turns the p95 of ``phase`` is built from (``None``: every phase).

        Turns that reached their first audio, and turns whose reply was cancelled before any
        audio (``reply_lost``: ``replies_lost`` says how many of them).
        """
        return sum(1 for ph, _ in self._headline if phase is None or ph == phase)

    def first_audio_p95_seconds(
        self, phase: str | None = GATE_PHASE, *, min_samples: int = GATE_MIN_SAMPLES
    ) -> float | None:
        """The nearest-rank p95 of end of speech to first audio, in seconds.

        ``None`` when fewer than ``min_samples`` turns of ``phase`` were measured (``None`` as
        ``phase`` takes every phase, for information).  An unknown stays unknown: a session
        that was barely measured must not be able to look fast.  A turn whose reply was
        cancelled before any audio counts with the seconds it had waited by then (a lower
        bound), so the slowest turns cannot drop out of the percentile by never being heard.
        """
        values = [seconds for ph, seconds in self._headline if phase is None or ph == phase]
        if len(values) < max(1, min_samples):
            return None
        return percentile(values, 95)

    def first_audio_p95_ms(
        self, phase: str | None = GATE_PHASE, *, min_samples: int = GATE_MIN_SAMPLES
    ) -> int | None:
        """``first_audio_p95_seconds`` in whole milliseconds: the unit of the API's gate.

        This is the number posted as ``session_facts.first_audio_p95_ms``.  The default is the
        gate's own reading: role-play turns only, at least 8 of them (``GATE_MIN_SAMPLES``).
        """
        seconds = self.first_audio_p95_seconds(phase, min_samples=min_samples)
        return None if seconds is None else int(round(seconds * 1000.0))

    # ------------------------------------------------------------------ scripted lines

    def say_created(self, speech_id: str, label: str, phase: str) -> None:
        """A scripted line was handed to ``say``; ``label`` is its reviewed line id."""
        self._says[speech_id] = (self._clock(), label, phase)
        while len(self._says) > _MAX_PENDING_SAYS:
            self._says.pop(next(iter(self._says)))

    def say_audio(self, speech_id: str) -> bool:
        """The scripted line's audio started.  False when ``speech_id`` is not a tracked line."""
        entry = self._says.pop(speech_id, None)
        if entry is None:
            return False
        created, label, phase = entry
        self._emit_checked(
            "say_to_first_audio", self._clock() - created, category=label, phase=phase, index=None
        )
        return True

    def say_done(self, speech_id: str) -> None:
        """Forget a line whose audio never started (it was interrupted or failed first)."""
        self._says.pop(speech_id, None)

    # ----------------------------------------------------------------------- internals

    def _report(
        self, schema: str, seconds: float, turn: _Turn, *, category: str | None = None
    ) -> None:
        self._emit_checked(
            schema,
            seconds,
            category=category or turn.kind,
            phase=turn.phase,
            index=turn.index,
        )

    def _emit_checked(
        self, schema: str, seconds: float, *, category: str, phase: str, index: int | None
    ) -> None:
        if not _valid_segment(seconds):
            return
        self._emit(schema, seconds, category=category, phase=phase, turn_index=index)


# ------------------------------------------------------------ Stage A targets (plan 5.15)

# "end-of-speech -> first audio p50 <= 1.8 s, p95 <= 3.0 s; scripted lines start within 0.5 s".
STAGE_A_HEADLINE_P50_SEC = 1.8
STAGE_A_HEADLINE_P95_SEC = 3.0
STAGE_A_SCRIPTED_START_SEC = 0.5
HEADLINE_SCHEMA = "eou_to_first_audio"
# A reply cancelled before any audio: a lower bound of that turn's wait, counted with the headline.
LOST_SCHEMA = "eou_to_reply_lost"
SCRIPTED_SCHEMA = "say_to_first_audio"


def _finite(values: Iterable[Any]) -> list[float]:
    return [
        float(v)
        for v in values
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    ]


def percentile(values: Iterable[Any], q: float) -> float | None:
    """The nearest-rank percentile ``q`` (0-100) of the finite numbers in ``values``."""
    ordered = sorted(_finite(values))
    if not ordered:
        return None
    rank = max(1, math.ceil(q / 100.0 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def latency_records(lines: Iterable[Any]) -> Iterator[Mapping[str, Any]]:
    """The ``r1_latency`` records in a log stream: JSON lines, or ``fly logs --json`` objects
    whose ``message`` is the JSON line.  Anything else is skipped."""
    for item in lines:
        record: Any = item
        if isinstance(item, (str, bytes)):
            try:
                record = json.loads(item)
            except ValueError:
                continue
        if isinstance(record, Mapping) and "error_type" not in record:
            message = record.get("message")
            if isinstance(message, str):
                try:
                    record = json.loads(message)
                except ValueError:
                    continue
        if (
            isinstance(record, Mapping)
            and record.get("component") == "r1"
            and record.get("error_type") == "r1_latency"
        ):
            yield record


def stage_a_report(lines: Iterable[Any]) -> dict[str, Any]:
    """Judge a smoke session's log lines against the Stage A targets (plan 5.15 item 6).

    ``passes`` is True or False once the session produced at least one headline turn, and None
    when it produced none (nothing was measured, which is not a pass).
    """
    headline_values: list[Any] = []
    lost_values: list[Any] = []
    scripted_values: list[Any] = []
    for record in latency_records(lines):
        schema = record.get("schema")
        if schema == HEADLINE_SCHEMA:
            headline_values.append(record.get("duration_sec"))
        elif schema == LOST_SCHEMA:
            lost_values.append(record.get("duration_sec"))
        elif schema == SCRIPTED_SCHEMA:
            scripted_values.append(record.get("duration_sec"))
    # A cancelled reply is a turn the candidate waited through, measured up to the cancellation:
    # it counts with the headline (as the session's own p95 does), never instead of it.
    lost = _finite(lost_values)
    headline = _finite(headline_values) + lost
    scripted = _finite(scripted_values)
    p50 = percentile(headline, 50)
    p95 = percentile(headline, 95)
    scripted_p95 = percentile(scripted, 95)
    report: dict[str, Any] = {
        "headline_turns": len(headline),
        "lost_replies": len(lost),
        "headline_p50_sec": p50,
        "headline_p95_sec": p95,
        "headline_p50_ok": None if p50 is None else p50 <= STAGE_A_HEADLINE_P50_SEC,
        "headline_p95_ok": None if p95 is None else p95 <= STAGE_A_HEADLINE_P95_SEC,
        "scripted_lines": len(scripted),
        "scripted_p95_sec": scripted_p95,
        "scripted_ok": None if scripted_p95 is None else scripted_p95 <= STAGE_A_SCRIPTED_START_SEC,
        "targets": {
            "headline_p50_sec": STAGE_A_HEADLINE_P50_SEC,
            "headline_p95_sec": STAGE_A_HEADLINE_P95_SEC,
            "scripted_start_sec": STAGE_A_SCRIPTED_START_SEC,
        },
    }
    checks = [report["headline_p50_ok"], report["headline_p95_ok"], report["scripted_ok"]]
    if p50 is None:
        report["passes"] = None
    else:
        # A session with no scripted line measured is judged on the headline alone.
        report["passes"] = all(check for check in checks if check is not None)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    """``fly logs --json | python r1_latency.py``: print the Stage A report; exit 0 pass,
    1 miss, 2 nothing measured."""
    del argv
    report = stage_a_report(sys.stdin)
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    passes = report["passes"]
    return 2 if passes is None else (0 if passes else 1)


if __name__ == "__main__":
    raise SystemExit(main())
