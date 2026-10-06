"""Gate replay harness: drive the REAL gate readers with a recorded call timeline.

M013/S01 T01a. Tests only: nothing here is imported by the worker.

WHAT IT DOES. A fixture (``tests/fixtures/gate_replays/replay_<prefix>.json``)
holds one call's gate window as relative milliseconds after ``call.answered``:
the bot lines (ask, first audio, playout end), SDK-shaped VAD events, STT
finals, committed user turns with the SDK's ``started_speaking_at``, and the
recorded responses of any model the gate called. The harness replays that
timeline on a VIRTUAL CLOCK (a whole 15 s answer window runs in milliseconds)
and drives the production code that decides what the candidate said:

* ``agent._read_fresh_turn`` (identity reader),
* ``agent._queued_turn_is_stale`` and ``agent._turn_anchor_ms`` (the barrier),
* ``agent._classify_phone_answer`` (consent reader + legacy classifier),
* ``phone.phone_classify_identity`` with the recorded identity response.

Each is looked up on its module AT CALL TIME, so a later task that changes or
monkeypatches them is what the replay runs (``TestHarnessDrivesTheRealCode``
proves it by mutation).

WHAT IT MIRRORS, AND WHY. The producers that feed those readers live in
closures inside ``agent._run_phone_session`` and no test can reach them (the
session harness patches ``persistence`` with a MagicMock, which blinds the
barrier; see the ``_read_fresh_turn`` docstring). Since T01b the producer LOGIC
is module level (``agent._new_gate_turn_capture`` -> ``gate_judge``), and only
the forwarding glue is mirrored, in ``SessionGlue``, pinned by the source guard
``TestReplayGlueMatchesAgent``: if ``agent.py`` changes the glue, that guard
fails and the change must be carried here. The SDK behaviour the gate relies on
is modelled in ``GateReplay`` itself:

* a VAD segment starts at ``t - speech_duration - inference_duration`` (the
  SDK formula, audio_recognition.py) and ends at ``t - silence_duration``;
* ``user_state_changed`` carries ``created_at`` = the segment start;
* a turn that COMMITS while a non-interruptible ``say`` is playing is dropped
  by the SDK (agent_activity.py:2186-2192): it never reaches
  ``on_candidate_turn``; only its STT final survives;
* ``say`` raises the question anchor to its first audio (the
  ``agent_state_changed`` -> ``speaking`` handler) and returns at playout end.

T01b replaced the origin/main producer (committed turns stamped with the
SDK's speech start) with the per-final capture; T04/T05 add judge phases to
``judge_responses`` and a driver for the real ``run_phone_gate``. Extend this
module; do not fork it.

PRIVACY. Fixture files are named by session prefix only, hold a synthetic first
name, relative times and short non-identifying utterances. ``load_fixture``
enforces that; ``GateReplayResult.leaked_text_in_logs`` checks the code under
test logs no utterance text.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import selectors
import time as _real_time
import types
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable
from unittest.mock import patch

# The phone-gate test module installs the stub SDK that `agent` needs at import
# time (CI runs without livekit). Same bootstrap as test_phone_gate_turn_barrier.
from tests import test_phone_gate as _sdk_stub_bootstrap  # noqa: F401

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402

FIXTURE_DIR = pathlib.Path(__file__).resolve().parent / "fixtures" / "gate_replays"

#: The only first names a replay fixture may carry. Synthetic, common, and
#: deliberately unrelated to the calls they replay.
SYNTHETIC_FIRST_NAMES = frozenset({"Asha", "Ravi", "Meera", "Arjun", "Kiran", "Neha"})

#: Wall-clock origin for `call.answered` in a replay. Any fixed value in the
#: range `persistence.normalize_turn_anchor_ms` accepts works; a fixed one keeps
#: every run identical.
REPLAY_EPOCH_S = 1_800_000_000.0
_MONOTONIC_ORIGIN_S = 1_000.0

_FIXTURE_NAME_RE = re.compile(r"^replay_[0-9a-f]{8}(_shape)?\.json$")
_LONG_DIGIT_RUN_RE = re.compile(r"\d{5,}")
_TOP_LEVEL_KEYS = frozenset({
    "schema", "session_prefix", "provenance", "summary", "time_origin",
    "candidate_first_name", "bot_lines", "vad_events", "stt_finals",
    "committed_turns", "judge_responses", "observed_production", "notes",
})
_PROVENANCES = frozenset({"real_timing_anonymised", "synthetic_shape"})
_MAX_UTTERANCE_CHARS = 120

# Fake TTS for a line the recording does not have (a different branch than the
# call took): first audio after this delay, playout proportional to length.
_DEFAULT_FIRST_AUDIO_DELAY_MS = 250
_DEFAULT_PLAYOUT_MS_PER_CHAR = 55
_DEFAULT_MIN_PLAYOUT_MS = 800


class ReplayError(AssertionError):
    """The replay itself is wrong (bad fixture, exhausted recording, deadlock)."""


# ── fixture ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class BotLine:
    kind: str
    ask_ms: int
    first_audio_ms: int
    playout_end_ms: int


@dataclass(frozen=True)
class VadEvent:
    t_ms: int
    type: str
    speech_duration_ms: int
    silence_duration_ms: int
    inference_duration_ms: int


@dataclass(frozen=True)
class VadSegment:
    """One VAD speech segment, as the SDK's own formula reconstructs it."""

    start_ms: int
    end_ms: int | None
    speech_ms: int | None
    start_event_ms: int
    end_event_ms: int | None


@dataclass(frozen=True)
class SttFinal:
    t_ms: int
    text: str


@dataclass(frozen=True)
class CommittedTurn:
    t_ms: int
    text: str
    started_speaking_at_ms: int | None
    created_at_ms: int | None


@dataclass(frozen=True)
class JudgeResponse:
    raw: str
    latency_ms: int


@dataclass(frozen=True)
class GateReplayFixture:
    name: str
    session_prefix: str
    provenance: str
    candidate_first_name: str
    bot_lines: tuple[BotLine, ...]
    vad_events: tuple[VadEvent, ...]
    stt_finals: tuple[SttFinal, ...]
    committed_turns: tuple[CommittedTurn, ...]
    judge_responses: dict[str, tuple[JudgeResponse, ...]]
    raw: dict[str, Any] = field(compare=False, repr=False)

    # Derived views ------------------------------------------------------

    def lines_of(self, kind: str) -> tuple[BotLine, ...]:
        return tuple(line for line in self.bot_lines if line.kind == kind)

    def has_line(self, kind: str) -> bool:
        return bool(self.lines_of(kind))

    def segments(self) -> tuple[VadSegment, ...]:
        """Pair start/end events into segments with the SDK formulas."""
        segments: list[VadSegment] = []
        open_start: VadEvent | None = None
        for ev in sorted(self.vad_events, key=lambda e: e.t_ms):
            if ev.type == "start_of_speech":
                if open_start is not None:
                    raise ReplayError(f"{self.name}: two starts without an end at {ev.t_ms}")
                open_start = ev
            elif ev.type == "end_of_speech":
                if open_start is None:
                    raise ReplayError(f"{self.name}: end without a start at {ev.t_ms}")
                start = _segment_start_ms(open_start)
                end = ev.t_ms - ev.silence_duration_ms
                segments.append(VadSegment(
                    start_ms=start, end_ms=end, speech_ms=end - start,
                    start_event_ms=open_start.t_ms, end_event_ms=ev.t_ms,
                ))
                open_start = None
        if open_start is not None:
            segments.append(VadSegment(
                start_ms=_segment_start_ms(open_start), end_ms=None, speech_ms=None,
                start_event_ms=open_start.t_ms, end_event_ms=None,
            ))
        return tuple(segments)

    def utterance_texts(self) -> tuple[str, ...]:
        texts = {f.text for f in self.stt_finals} | {c.text for c in self.committed_turns}
        return tuple(sorted(t for t in texts if t.strip()))

    # Variants -----------------------------------------------------------

    def candidate_silent_after(self, cut_ms: int) -> "GateReplayFixture":
        """The same call, with the candidate saying nothing from ``cut_ms`` on.

        Bot timing is kept. A VAD segment still open at the cut is dropped
        whole, so no half-segment is left behind.
        """
        kept_events: list[VadEvent] = []
        pending_start: VadEvent | None = None
        for ev in sorted(self.vad_events, key=lambda e: e.t_ms):
            if ev.type == "start_of_speech":
                pending_start = ev
            elif ev.type == "end_of_speech" and pending_start is not None:
                if _segment_start_ms(pending_start) < cut_ms and ev.t_ms < cut_ms:
                    kept_events.extend((pending_start, ev))
                pending_start = None
        return replace(
            self,
            name=f"{self.name}[silent_after={cut_ms}]",
            vad_events=tuple(kept_events),
            stt_finals=tuple(f for f in self.stt_finals if f.t_ms < cut_ms),
            committed_turns=tuple(c for c in self.committed_turns if c.t_ms < cut_ms),
        )

    def candidate_shifted(self, from_ms: int, delta_ms: int) -> "GateReplayFixture":
        """Move every candidate event at or after ``from_ms`` by ``delta_ms``.

        For "what if the second utterance came earlier" variants (T05's
        in-flight re-judge). Bot timing is kept.
        """
        def shift(t: int | None) -> int | None:
            return None if t is None else (t + delta_ms if t >= from_ms else t)

        return replace(
            self,
            name=f"{self.name}[shift {from_ms}+{delta_ms}]",
            vad_events=tuple(
                replace(ev, t_ms=shift(ev.t_ms)) for ev in self.vad_events),
            stt_finals=tuple(
                replace(f, t_ms=shift(f.t_ms)) for f in self.stt_finals),
            committed_turns=tuple(
                replace(c, t_ms=shift(c.t_ms),
                        started_speaking_at_ms=shift(c.started_speaking_at_ms),
                        created_at_ms=shift(c.created_at_ms))
                for c in self.committed_turns),
        )


def _segment_start_ms(ev: VadEvent) -> int:
    # SDK: speech_start_time = time.time() - ev.speech_duration - ev.inference_duration
    return ev.t_ms - ev.speech_duration_ms - ev.inference_duration_ms


def fixture_paths() -> list[pathlib.Path]:
    return sorted(FIXTURE_DIR.glob("*.json"))


def _req_int(obj: dict, key: str, where: str, *, optional: bool = False) -> int | None:
    value = obj.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ReplayError(f"{where}: {key} must be integer milliseconds, got {value!r}")
    return value


def _check_text(text: Any, where: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise ReplayError(f"{where}: empty utterance text")
    if len(text) > _MAX_UTTERANCE_CHARS:
        raise ReplayError(f"{where}: utterance longer than {_MAX_UTTERANCE_CHARS} chars")
    if _LONG_DIGIT_RUN_RE.search(text):
        raise ReplayError(f"{where}: utterance carries a long digit run")
    return text


def load_fixture(name: str, *, directory: pathlib.Path | None = None) -> GateReplayFixture:
    """Load and VALIDATE one replay fixture by file name (or session prefix)."""
    file_name = name if name.endswith(".json") else f"replay_{name}.json"
    path = (directory or FIXTURE_DIR) / file_name
    if not _FIXTURE_NAME_RE.match(path.name):
        raise ReplayError(f"{path.name}: fixture names are replay_<8-hex prefix>[_shape].json")
    data = json.loads(path.read_text(encoding="utf-8"))
    where = path.name
    unknown = set(data) - _TOP_LEVEL_KEYS
    if unknown:
        raise ReplayError(f"{where}: unknown keys {sorted(unknown)}")
    if data.get("schema") != "gate_replay/v1":
        raise ReplayError(f"{where}: schema must be gate_replay/v1")
    prefix = data.get("session_prefix")
    if not isinstance(prefix, str) or not path.name.startswith(f"replay_{prefix}"):
        raise ReplayError(f"{where}: session_prefix does not match the file name")
    provenance = data.get("provenance")
    if provenance not in _PROVENANCES:
        raise ReplayError(f"{where}: provenance must be one of {sorted(_PROVENANCES)}")
    if path.name.endswith("_shape.json") != (provenance == "synthetic_shape"):
        raise ReplayError(f"{where}: _shape files and only they are synthetic_shape")
    if data.get("time_origin") != "call.answered":
        raise ReplayError(f"{where}: time_origin must be call.answered")
    first = data.get("candidate_first_name")
    if first not in SYNTHETIC_FIRST_NAMES:
        raise ReplayError(f"{where}: candidate_first_name must be a synthetic name")

    bot_lines = tuple(
        BotLine(
            kind=str(line["kind"]),
            ask_ms=_req_int(line, "ask_ms", where),
            first_audio_ms=_req_int(line, "first_audio_ms", where),
            playout_end_ms=_req_int(line, "playout_end_ms", where),
        )
        for line in data.get("bot_lines", [])
    )
    for line in bot_lines:
        if not line.ask_ms <= line.first_audio_ms <= line.playout_end_ms:
            raise ReplayError(f"{where}: bot line {line.kind} times out of order")
    vad_events = tuple(
        VadEvent(
            t_ms=_req_int(ev, "t_ms", where),
            type=str(ev["type"]),
            speech_duration_ms=_req_int(ev, "speech_duration_ms", where),
            silence_duration_ms=_req_int(ev, "silence_duration_ms", where),
            inference_duration_ms=_req_int(ev, "inference_duration_ms", where),
        )
        for ev in data.get("vad_events", [])
    )
    for ev in vad_events:
        if ev.type not in {"start_of_speech", "end_of_speech"}:
            raise ReplayError(f"{where}: VAD event type {ev.type!r}")
    stt_finals = tuple(
        SttFinal(t_ms=_req_int(f, "t_ms", where), text=_check_text(f.get("text"), where))
        for f in data.get("stt_finals", [])
    )
    committed = tuple(
        CommittedTurn(
            t_ms=_req_int(c, "t_ms", where),
            text=_check_text(c.get("text"), where),
            started_speaking_at_ms=_req_int(c, "started_speaking_at_ms", where, optional=True),
            created_at_ms=_req_int(c, "created_at_ms", where, optional=True),
        )
        for c in data.get("committed_turns", [])
    )
    judge: dict[str, tuple[JudgeResponse, ...]] = {}
    for phase, responses in (data.get("judge_responses") or {}).items():
        judge[str(phase)] = tuple(
            JudgeResponse(raw=str(r["raw"]), latency_ms=_req_int(r, "latency_ms", where))
            for r in responses
        )
    fixture = GateReplayFixture(
        name=path.name, session_prefix=prefix, provenance=provenance,
        candidate_first_name=first, bot_lines=bot_lines, vad_events=vad_events,
        stt_finals=stt_finals, committed_turns=committed, judge_responses=judge,
        raw=data,
    )
    for seg in fixture.segments():
        if seg.speech_ms is not None:
            end_ev = next(e for e in vad_events if e.t_ms == seg.end_event_ms)
            if abs(end_ev.speech_duration_ms - seg.speech_ms) > 2:
                raise ReplayError(
                    f"{where}: segment at {seg.start_ms} speech_duration disagrees "
                    f"with its start/end events")
    return fixture


# ── virtual clock and event loop ─────────────────────────────────────────


class VirtualClock:
    """Seconds since ``call.answered``; nothing else moves it."""

    def __init__(self) -> None:
        self.now_s = 0.0

    def advance(self, seconds: float) -> None:
        if seconds > 0:
            self.now_s += seconds

    @property
    def now_ms(self) -> int:
        return int(round(self.now_s * 1000))

    def monotonic(self) -> float:
        return _MONOTONIC_ORIGIN_S + self.now_s

    def wall(self) -> float:
        return REPLAY_EPOCH_S + self.now_s


class _TimeModuleProxy:
    """Stands in for the ``time`` module inside ``agent`` and ``phone``."""

    def __init__(self, clock: VirtualClock) -> None:
        self._clock = clock

    def time(self) -> float:
        return self._clock.wall()

    def monotonic(self) -> float:
        return self._clock.monotonic()

    def perf_counter(self) -> float:
        return self._clock.monotonic()

    def __getattr__(self, name: str) -> Any:
        return getattr(_real_time, name)


class _VirtualSelector(selectors.SelectSelector):
    """Never blocks: "waiting" for ``timeout`` seconds advances the clock."""

    def __init__(self, clock: VirtualClock) -> None:
        super().__init__()
        self._clock = clock

    def select(self, timeout: float | None = None):  # noqa: ANN201
        if timeout is None:
            raise ReplayError(
                "replay deadlock: the code under test is waiting with nothing "
                "scheduled (an unbounded wait on a real call)")
        self._clock.advance(timeout)
        return []


class _VirtualTimeLoop(asyncio.SelectorEventLoop):
    def __init__(self, clock: VirtualClock) -> None:
        super().__init__(selector=_VirtualSelector(clock))
        self._virtual_clock = clock
        # BaseEventLoop runs every timer due within `_clock_resolution` of now
        # WITHOUT advancing the clock. That is the host's monotonic resolution
        # (15.6 ms on Windows), which would fire replay events early by a
        # host-dependent amount. The virtual clock is exact.
        self._clock_resolution = 1e-9

    def time(self) -> float:  # noqa: D102
        return self._virtual_clock.monotonic()


# ── log capture ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LogRecord:
    component: str
    level: str
    event: str
    fields: dict[str, Any]
    t_ms: int

    @property
    def error_type(self) -> Any:
        return self.fields.get("error_type")

    @property
    def error_category(self) -> Any:
        return self.fields.get("error_category")


class _LogRecorder:
    """Duck-types ``observability.StructuredLogger`` and keeps every call."""

    def __init__(self, component: str, sink: list[LogRecord], clock: VirtualClock) -> None:
        self._component = component
        self._sink = sink
        self._clock = clock

    def _record(self, level: str, event: str, **fields: Any) -> None:
        self._sink.append(LogRecord(self._component, level, event, dict(fields), self._clock.now_ms))

    def debug(self, event: str, **fields: Any) -> None:
        self._record("debug", event, **fields)

    def info(self, event: str, **fields: Any) -> None:
        self._record("info", event, **fields)

    def warn(self, event: str, **fields: Any) -> None:
        self._record("warn", event, **fields)

    def error(self, event: str, **fields: Any) -> None:
        self._record("error", event, **fields)

    def counter(self, name: str, value: float, labels: Any = None) -> None:
        self._record("metric", name, value=value)

    def gauge(self, name: str, value: float, labels: Any = None) -> None:
        self._record("metric", name, value=value)

    def histogram(self, name: str, value: float, labels: Any = None) -> None:
        self._record("metric", name, value=value)


# ── the session glue agent.py runs ───────────────────────────────────────


class SessionGlue:
    """The `_run_phone_session` closure glue (agent.py), M013 S01 T01b.

    The logic lives in module-level seams the glue calls, so the replay runs
    the SAME code: ``agent._new_gate_turn_capture`` (the per-final capture and
    FIFO pairing in ``gate_judge``), ``agent._user_state_anchor_ms``,
    ``agent._gate_evidence_row`` and ``agent._gate_user_row_is_evidence_echo``.
    What remains here is the forwarding, pinned line by line by
    ``TestReplayGlueMatchesAgent``:

    * ``_emit_gate_turn``: ``user_turns.put_nowait(turn)``;
    * ``_on_phone_vad_event``: ``gate_capture.on_vad_event(event, time.time())``
      plus the ``candidate_speaking`` latch;
    * ``_on_phone_transcript_activity``: ``gate_capture.on_final(...)``;
    * ``on_candidate_turn``: ``gate_capture.on_commit(text, _turn_anchor_ms(message))``;
    * ``_mark_question_asked``: anchor = ``int(round(time.time() * 1000))``,
      then ``_clear_sdk_user_turn()`` (counted here; the SDK side is not
      modelled, see ``clear_user_turn_calls``);
    * ``_on_phone_agent_state_changed`` -> speaking: raise the anchor to first
      audio, one way only;
    * ``_on_phone_item`` (user, gate phase): a candidate row unless it repeats
      a grant-evidence row; ``_record_gate_grant_evidence`` for the grant.
    """

    def __init__(self, replay: "GateReplay") -> None:
        self.replay = replay
        self.user_turns: asyncio.Queue = asyncio.Queue()
        self.gate_question_anchor: list[int | None] = [None]
        self.candidate_speaking: dict[str, Any] = {"value": False}
        self.latest_candidate_anchor: list[int | None] = [None]
        self.gate_pending: list[tuple] = []
        self.gate_evidence_keys: set[str] = set()
        self.item_seq = 0
        # The SDK's clear is NOT modelled: the fixtures' committed turns are
        # the ones production recorded (no clear existed), and the gate no
        # longer reads the SDK's speech start when VAD timing exists.
        self.clear_user_turn_calls = 0
        self.capture = agent_mod._new_gate_turn_capture(self._emit_gate_turn)

    # agent.py `_emit_gate_turn`
    def _emit_gate_turn(self, turn: Any) -> None:
        if turn.closed_by == "settle" and phone.is_explicit_end_call_request(turn.text):
            self.replay.result.end_call_requested = True
        anchor = turn.anchor_ms
        self.replay.enqueued.append(
            (turn.text, None if anchor is None else anchor - self.replay.epoch_ms))
        self.replay.result.gate_turns.append(turn)
        self.user_turns.put_nowait(turn)

    # readers' view
    def question_anchor(self) -> int | None:
        return self.gate_question_anchor[0]

    def is_candidate_speaking(self) -> bool:
        return bool(self.candidate_speaking.get("value"))

    # agent.py `_mark_question_asked`
    def mark_question_asked(self) -> None:
        self.gate_question_anchor[0] = int(round(agent_mod.time.time() * 1000))
        self.clear_user_turn_calls += 1

    # agent.py `_clear_question_anchor`
    def clear_question_anchor(self) -> None:
        self.gate_question_anchor[0] = None
        self.capture.stop()

    # agent.py `_on_phone_agent_state_changed`, new_state == "speaking"
    def on_agent_speaking(self) -> None:
        if self.gate_question_anchor[0] is not None:
            first_audio_ms = int(round(agent_mod.time.time() * 1000))
            if first_audio_ms > self.gate_question_anchor[0]:
                self.gate_question_anchor[0] = first_audio_ms

    # agent.py `_on_phone_vad_event`
    def on_vad_event(self, event: Any) -> None:
        self.capture.on_vad_event(event, agent_mod.time.time())
        if event.type == "start_of_speech":
            self.candidate_speaking["value"] = True
        elif event.type == "end_of_speech":
            self.candidate_speaking["value"] = False

    # agent.py `_on_phone_user_state_changed`
    def on_user_state_changed(self, event: Any) -> None:
        if event.new_state == "speaking":
            self.candidate_speaking["value"] = True
            self.latest_candidate_anchor[0] = agent_mod._user_state_anchor_ms(
                event, agent_mod.time.time())
        elif event.old_state == "speaking" and event.new_state in {"listening", "idle"}:
            self.candidate_speaking["value"] = False

    # agent.py `_on_phone_transcript_activity`
    def on_stt_final(self, event: Any) -> None:
        if str(getattr(event, "transcript", "") or "").strip() and bool(
                getattr(event, "is_final", False)):
            self.capture.on_final(str(event.transcript))

    # agent.py `on_candidate_turn` (reached only for turns the SDK did not drop)
    def on_candidate_turn(self, text: str, message: Any) -> None:
        self.capture.on_commit(text, agent_mod._turn_anchor_ms(message))

    # agent.py `_on_phone_item`, role user, gate phase (a commit the SDK kept)
    def on_user_item(self, text: str, message: Any) -> None:
        if not agent_mod._gate_user_row_is_evidence_echo(
                text, self.capture, self.gate_evidence_keys):
            self.item_seq += 1
            self.gate_pending.append(
                ("candidate", text, agent_mod._turn_anchor_ms(message), self.item_seq))

    # agent.py `_record_gate_grant_evidence`
    def on_grant_evidence(self, item: Any) -> None:
        row = agent_mod._gate_evidence_row(item, self.gate_evidence_keys, self.capture)
        if row is not None:
            self.gate_pending.append(row)

    def candidate_rows(self) -> list[tuple]:
        return [row for row in self.gate_pending if row[0] == "candidate"]


# ── result ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SpokenLine:
    kind: str
    text: str
    start_ms: int
    first_audio_ms: int
    playout_end_ms: int


@dataclass
class GateReplayResult:
    fixture: GateReplayFixture
    identity_reply: str | None = None
    identity_verdict: str | None = None
    identity_prompts: list[str] = field(default_factory=list)
    identity_decided_at_ms: int | None = None
    decision: str | None = None
    decision_at_ms: int | None = None
    consumed: list[str] = field(default_factory=list)
    spoken: list[SpokenLine] = field(default_factory=list)
    logs: list[LogRecord] = field(default_factory=list)
    enqueued: list[tuple[str, int | None]] = field(default_factory=list)
    dropped_commits: list[str] = field(default_factory=list)
    gate_turns: list[Any] = field(default_factory=list)
    end_call_requested: bool = False
    glue: Any = None

    def candidate_rows(self) -> list[tuple]:
        """The candidate `gate_pending` rows the session would have buffered."""
        return [] if self.glue is None else self.glue.candidate_rows()

    def spoken_kinds(self) -> list[str]:
        return [line.kind for line in self.spoken]

    def logs_of(self, error_type: str, error_category: str | None = None) -> list[LogRecord]:
        return [
            r for r in self.logs
            if r.error_type == error_type
            and (error_category is None or r.error_category == error_category)
        ]

    def leaked_text_in_logs(self) -> list[tuple[str, str]]:
        """(log field, utterance) pairs where a log carried candidate words."""
        leaks: list[tuple[str, str]] = []
        texts = [t.casefold() for t in self.fixture.utterance_texts() if len(t.strip()) >= 4]
        for record in self.logs:
            for key, value in record.fields.items():
                if not isinstance(value, str):
                    continue
                folded = value.casefold()
                for text in texts:
                    if text in folded:
                        leaks.append((f"{record.event}.{key}", text))
        return leaks


# ── the replay runtime ───────────────────────────────────────────────────


class GateReplay:
    """One replay of one fixture on a virtual clock."""

    def __init__(
        self,
        fixture: GateReplayFixture,
        *,
        glue_factory: Callable[["GateReplay"], Any] = SessionGlue,
    ) -> None:
        self.fixture = fixture
        self.clock = VirtualClock()
        self.epoch_ms = int(round(REPLAY_EPOCH_S * 1000))
        self.result = GateReplayResult(fixture=fixture)
        self.enqueued = self.result.enqueued
        self._glue_factory = glue_factory
        self.glue: Any = None
        self._bot_playing_until_ms: int | None = None
        self._line_cursor: dict[str, int] = {}
        self._judge_cursor: dict[str, int] = {}
        self._replay_errors: list[ReplayError] = []

    # time helpers ---------------------------------------------------------

    @property
    def now_ms(self) -> int:
        return self.clock.now_ms

    def wall_s(self, rel_ms: int | None) -> float | None:
        return None if rel_ms is None else REPLAY_EPOCH_S + rel_ms / 1000.0

    def rel_ms(self, epoch_ms: int | None) -> int | None:
        return None if epoch_ms is None else epoch_ms - self.epoch_ms

    async def wait_until(self, rel_ms: int) -> None:
        delay = (rel_ms - self.clock.now_ms) / 1000.0
        if delay > 0:
            await asyncio.sleep(delay)

    # fake TTS --------------------------------------------------------------

    def bot_is_playing(self) -> bool:
        return self._bot_playing_until_ms is not None and self.now_ms < self._bot_playing_until_ms

    async def say(self, text: str, *, kind: str) -> None:
        """A non-interruptible gate ``say``: first audio, then playout end.

        Uses the recorded timing for the n-th line of ``kind`` (never earlier
        than recorded: the candidate's audio is fixed, so the bot cannot be
        moved ahead of it); a line the call never spoke gets the defaults.
        """
        index = self._line_cursor.get(kind, 0)
        self._line_cursor[kind] = index + 1
        recorded = self.fixture.lines_of(kind)
        start = self.now_ms
        if index < len(recorded):
            line = recorded[index]
            start = max(start, line.ask_ms)
            first_audio = start + (line.first_audio_ms - line.ask_ms)
            end = start + (line.playout_end_ms - line.ask_ms)
        else:
            first_audio = start + _DEFAULT_FIRST_AUDIO_DELAY_MS
            end = first_audio + max(_DEFAULT_MIN_PLAYOUT_MS, _DEFAULT_PLAYOUT_MS_PER_CHAR * len(text))
        await self.wait_until(start)
        self._bot_playing_until_ms = end
        await self.wait_until(first_audio)
        self.glue.on_agent_speaking()
        await self.wait_until(end)
        self._bot_playing_until_ms = None
        self.result.spoken.append(SpokenLine(kind, text, start, first_audio, end))

    # recorded model responses ----------------------------------------------

    def recorded_infer(self, phase: str) -> Callable[[str], Awaitable[str]]:
        """An ``infer`` that returns the next recorded response for ``phase``.

        Runs out loudly: a replay asking a model more often than the call did
        is a different call, and must not be silently answered.
        """
        async def _infer(prompt: str) -> str:
            responses = self.fixture.judge_responses.get(phase, ())
            index = self._judge_cursor.get(phase, 0)
            if index >= len(responses):
                # Raised here AND re-raised by `run`: the code under test fails
                # open on a model error (identity -> "unclear"), which would
                # otherwise swallow this and replay a different call silently.
                error = ReplayError(
                    f"{self.fixture.name}: no recorded {phase} response #{index + 1}")
                self._replay_errors.append(error)
                raise error
            self._judge_cursor[phase] = index + 1
            if phase == "identity":
                self.result.identity_prompts.append(prompt)
            response = responses[index]
            await asyncio.sleep(response.latency_ms / 1000.0)
            return response.raw

        return _infer

    # the candidate's side, as the SDK delivers it ---------------------------

    def _schedule_candidate_events(self, loop: asyncio.AbstractEventLoop) -> list[asyncio.TimerHandle]:
        handles: list[asyncio.TimerHandle] = []

        def at(rel_ms: int, fn: Callable[[], None]) -> None:
            handles.append(loop.call_at(_MONOTONIC_ORIGIN_S + rel_ms / 1000.0, fn))

        # Sort key keeps simultaneous events in a stable, causal order.
        for ev in self.fixture.vad_events:
            sdk_event = types.SimpleNamespace(
                type=ev.type,
                speech_duration=ev.speech_duration_ms / 1000.0,
                silence_duration=ev.silence_duration_ms / 1000.0,
                inference_duration=ev.inference_duration_ms / 1000.0,
            )
            if ev.type == "start_of_speech":
                state = types.SimpleNamespace(
                    old_state="listening", new_state="speaking",
                    created_at=self.wall_s(_segment_start_ms(ev)))
            else:
                state = types.SimpleNamespace(
                    old_state="speaking", new_state="listening",
                    created_at=self.wall_s(ev.t_ms))

            def _vad(sdk_event=sdk_event, state=state) -> None:
                self.glue.on_vad_event(sdk_event)
                self.glue.on_user_state_changed(state)

            at(ev.t_ms, _vad)
        for final in self.fixture.stt_finals:
            event = types.SimpleNamespace(transcript=final.text, is_final=True)
            at(final.t_ms, lambda event=event: self.glue.on_stt_final(event))
        for turn in self.fixture.committed_turns:
            at(turn.t_ms, lambda turn=turn: self._commit(turn))
        return handles

    def _commit(self, turn: CommittedTurn) -> None:
        # SDK agent_activity.py:2186-2192: a turn that commits while a
        # non-interruptible speech is current is dropped before
        # `on_user_turn_completed`, so `on_candidate_turn` never sees it.
        if self.bot_is_playing():
            self.result.dropped_commits.append(turn.text)
            return
        metrics = {}
        if turn.started_speaking_at_ms is not None:
            metrics["started_speaking_at"] = self.wall_s(turn.started_speaking_at_ms)
        message = types.SimpleNamespace(
            metrics=metrics, created_at=self.wall_s(turn.created_at_ms))
        self.glue.on_candidate_turn(turn.text, message)
        # A kept commit is then added to the chat context, which fires
        # `conversation_item_added` (the gate transcript row).
        on_user_item = getattr(self.glue, "on_user_item", None)
        if callable(on_user_item):
            on_user_item(turn.text, message)

    # running ------------------------------------------------------------------

    def run(self, driver: Callable[["GateReplay"], Awaitable[Any]]) -> GateReplayResult:
        loop = _VirtualTimeLoop(self.clock)
        env_overrides = {
            # Production defaults, whatever the developer's shell exports.
            "PHONE_CLASSIFY_ANSWER_TIMEOUT_SEC": None,
            "PHONE_IDENTITY_ANSWER_TIMEOUT_SEC": None,
            # The silence close of a dropped turn waits on this ceiling.
            "PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC": None,
        }
        saved_env = {k: os.environ.get(k) for k in env_overrides}
        handles: list[asyncio.TimerHandle] = []
        proxy = _TimeModuleProxy(self.clock)
        try:
            for key in env_overrides:
                os.environ.pop(key, None)
            with patch.object(agent_mod, "time", proxy), \
                    patch.object(phone, "time_module", proxy), \
                    patch.object(agent_mod, "_log", _LogRecorder("agent", self.result.logs, self.clock)), \
                    patch.object(phone, "_log", _LogRecorder("phone", self.result.logs, self.clock)):
                async def _main() -> Any:
                    self.glue = self._glue_factory(self)
                    self.result.glue = self.glue
                    handles.extend(self._schedule_candidate_events(asyncio.get_running_loop()))
                    return await driver(self)

                loop.run_until_complete(_main())
        finally:
            for handle in handles:
                handle.cancel()
            pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()
            for key, value in saved_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        if self._replay_errors:
            raise self._replay_errors[0]
        return self.result


# ── drivers ──────────────────────────────────────────────────────────────


async def drive_identity_then_consent(rt: GateReplay) -> GateReplayResult:
    """The conversational gate's two reads, through the real readers.

    Identity (when the fixture has an identity line): anchor, speak, read with
    the identity reader on the production budgets, classify with the recorded
    response. Consent: anchor, speak, then `_classify_phone_answer` with its
    production defaults (two attempts, one re-ask) on the same shared queue.
    Bot lines start at their recorded ask time unless the replay runs later.
    """
    result = rt.result
    first_name = rt.fixture.candidate_first_name
    glue = rt.glue
    if rt.fixture.has_line("identity"):
        await rt.wait_until(rt.fixture.lines_of("identity")[0].ask_ms)
        glue.mark_question_asked()
        await rt.say(phone.phone_identity_text(first_name), kind="identity")
        reply = await agent_mod._read_fresh_turn(
            glue.user_turns,
            glue.question_anchor,
            phone.phone_identity_answer_timeout_sec(),
            speaking=glue.is_candidate_speaking,
            hard_timeout_sec=phone.phone_classify_answer_timeout_sec(),
        )
        result.identity_reply = reply
        result.identity_verdict = await phone.phone_classify_identity(
            reply, first_name, infer=rt.recorded_infer("identity"))
        result.identity_decided_at_ms = rt.now_ms
        consent_text = phone.PHONE_DISCLOSURE_CONTINUATION_TEXT
    else:
        consent_text = phone.PHONE_DISCLOSURE_TEXT
    await rt.wait_until(rt.fixture.lines_of("consent")[0].ask_ms)
    glue.mark_question_asked()
    await rt.say(consent_text, kind="consent")

    async def _reader_say(text: str) -> None:
        await rt.say(text, kind="reask")

    result.decision = await agent_mod._classify_phone_answer(
        glue.user_turns, _reader_say,
        consumed=result.consumed,
        question_anchor=glue.question_anchor,
        on_grant_evidence=getattr(glue, "on_grant_evidence", None),
    )
    result.decision_at_ms = rt.now_ms
    return result


def replay(
    fixture: GateReplayFixture | str,
    *,
    driver: Callable[[GateReplay], Awaitable[Any]] = drive_identity_then_consent,
    glue_factory: Callable[[GateReplay], Any] = SessionGlue,
) -> GateReplayResult:
    """Load (if needed) and replay one fixture; returns the result."""
    if isinstance(fixture, str):
        fixture = load_fixture(fixture)
    return GateReplay(fixture, glue_factory=glue_factory).run(driver)
