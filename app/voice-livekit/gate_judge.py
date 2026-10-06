"""Gate utterance capture for the phone consent gate (M013 S01).

T01b creates this module with the PURE utterance types and the per-call
capture that feeds the gate readers; T04 extends it with the DeepSeek gate
judge. It must import cleanly without ``livekit`` installed (the CI unittest
step runs bare python with the SDK stubbed) and imports nothing from
``phone`` or ``agent`` at module import time, so ``phone`` can import this
module later without a cycle. Any later need for a phone helper is a lazy
import inside a function.

WHY THE GATE CAPTURES STT FINALS, NOT ONLY COMMITTED TURNS. Two SDK
behaviours (livekit-agents 1.6.4) lost or mis-timed real answers:

* The SDK reports a committed turn's ``started_speaking_at`` as the FIRST VAD
  start of the uncommitted run, and resets it only when a turn commits. A VAD
  blip that never yields a final (a cough during the identity line) leaves
  that start in place, and the next real answer inherits it. On session
  9f60523d "Yes, we can continue." began ~9 s after the consent question was
  heard but was stamped before it, skipped as a stale turn, and the
  candidate was re-asked after 15 s of silence.
* A turn that COMMITS while a non-interruptible ``say`` is playing is dropped
  before ``on_user_turn_completed`` (agent_activity.py:2186-2192). Only its
  STT final survives.

So the gate keeps its own record: every VAD segment (from the observed VAD
stream, with the SDK's own start formula), every STT final, and a FIFO
pairing between them. Readers receive CLOSED turns (``GateTurn``) whose anchor
is the start of the speech that produced them.

PAIRING IS FIFO, NOT "LATEST START". Each final consumes the OLDEST unpaired
closed VAD segments that ended before it arrived (one final may cover several
segments). Pairing a final with "the last segment that started before it
arrived" would let a noise segment that starts after a question lend its
post-question start to a late final of an earlier answer, which would turn a
reply to an earlier question into consent. Unpaired segments with no final
expire ``GATE_STT_PAIRING_WINDOW_MS`` after they end, so a blip never shifts
later pairings. A final with no pairable segment has ``segment_start_ms =
None`` and is never grant evidence.

DECIDE ON CLOSED TURNS, NOT ON RAW FINALS. A group of finals is closed when the
SDK commits the turn, or, only for turns the SDK drops, when the VAD has been
silent for the endpointing ceiling after the last final. "Yes" followed by
"but I'm busy right now" 0.5 s later is therefore read as one reply, never
granted on the first fragment.

PRIVACY. Utterance text lives only in memory, in a bounded per-call log. Every
log line this module emits carries categories, counts and durations only.
"""

from __future__ import annotations

import asyncio
import math
import unicodedata
from collections import deque
from dataclasses import dataclass, replace
from typing import Any, Callable, Iterable, Optional

__all__ = [
    "GATE_SETTLE_MARGIN_MS",
    "GATE_STT_PAIRING_WINDOW_MS",
    "GateTurn",
    "GateTurnCapture",
    "GateUtterance",
    "GateUtteranceLog",
    "TAG_DURING_QUESTION",
    "TAG_NO_SEGMENT",
    "TAG_POST_QUESTION",
    "TAG_PRE_QUESTION",
    "delta_schema",
    "normalize_gate_text",
    "question_tag",
    "turn_is_grant_evidence",
]

#: The utterance began before the question was heard and ended before it.
TAG_PRE_QUESTION = "pre_question"
#: The utterance began before the question was heard and was still going on.
TAG_DURING_QUESTION = "during_question"
#: The utterance began at or after the question was heard.
TAG_POST_QUESTION = "post_question"
#: Logging category only: no VAD segment could be paired with the final.
TAG_NO_SEGMENT = "no_segment"

#: How long after a VAD segment ends its STT final may still arrive and pair
#: with it. Beyond this the segment is treated as a blip that never produced a
#: final, so it can never lend its start to a later, unrelated final.
GATE_STT_PAIRING_WINDOW_MS = 3000

#: Added to the endpointing ceiling before a group of finals the SDK never
#: committed is closed by silence. The SDK commits a normal turn at or before
#: the ceiling, so the margin keeps the commit (the authoritative close) ahead
#: of the silence close whenever the SDK did not drop the turn.
GATE_SETTLE_MARGIN_MS = 250

#: Per-call bounds. A gate lasts a couple of minutes at most; these are far
#: above any real gate and only stop a pathological line from growing memory.
GATE_UTTERANCE_LOG_MAX = 64
_GATE_SEGMENT_MAX = 64
_GATE_RECENT_TURNS_MAX = 16

#: A wall-clock sanity window for VAD-derived millisecond stamps. A value that
#: is not a plausible current time (a test double's Mock, a wrong clock) is
#: dropped rather than allowed to time a turn.
_MAX_VAD_FIELD_SEC = 3600.0


# ── pure helpers ──────────────────────────────────────────────────────────


def normalize_gate_text(text: Any) -> str:
    """Normalise utterance text for containment checks.

    NFKC, casefold, Unicode punctuation (category ``P*``) replaced by a space,
    whitespace collapsed. Combining marks (``M*``) are KEPT, so Devanagari
    matras survive ("हाँ" stays "हाँ").
    """
    if not isinstance(text, str):
        return ""
    folded = unicodedata.normalize("NFKC", text).casefold()
    chars = [
        " " if unicodedata.category(ch).startswith("P") else ch
        for ch in folded
    ]
    return " ".join("".join(chars).split())


def question_tag(
    segment_start_ms: Optional[int],
    segment_end_ms: Optional[int],
    question_anchor_ms: Optional[int],
) -> Optional[str]:
    """Where an utterance sits relative to the question now reading it.

    ``segment_end_ms`` is the end of the segment the speech STARTED in (a
    final may cover several segments; a later one does not make the first
    overlap the question). ``None`` means that segment is still open.

    ``None`` when either the speech start or the question anchor is unknown.
    A tie counts as post-question, matching the staleness rule (a barge-in
    that starts the instant the question is heard is an answer to it).
    """
    if segment_start_ms is None or question_anchor_ms is None:
        return None
    if segment_start_ms >= question_anchor_ms:
        return TAG_POST_QUESTION
    if segment_end_ms is None or segment_end_ms > question_anchor_ms:
        return TAG_DURING_QUESTION
    return TAG_PRE_QUESTION


def delta_schema(
    *,
    anchor_ms: Optional[int],
    final_ms: Optional[int],
    segment_ms: Optional[int],
) -> str:
    """Pack three signed millisecond deltas into one log-safe identifier.

    The structured logger allowlists its metadata keys (they mirror the API's
    logger) and its only numeric duration key rejects negative values, so the
    signed deltas a skip log needs travel as one bounded identifier string:
    ``anchor_ms:<d>_final_ms:<d>_segment_ms:<d>``, with ``na`` for unknown.
    Deltas only; never a wall-clock time and never text.
    """
    def _fmt(value: Optional[int]) -> str:
        if value is None:
            return "na"
        bounded = max(-9_999_999, min(9_999_999, int(value)))
        return str(bounded)

    return (
        f"anchor_ms:{_fmt(anchor_ms)}_final_ms:{_fmt(final_ms)}"
        f"_segment_ms:{_fmt(segment_ms)}"
    )


def _as_ms(value: Any) -> Optional[int]:
    """A millisecond stamp, or None for anything that is not a plain number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)):
        return None
    return int(round(value))


def _vad_seconds(event: Any, name: str) -> float:
    """A bounded, non-negative VAD duration field in seconds (0.0 if absent)."""
    raw = getattr(event, name, 0.0)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0.0
    value = float(raw)
    if not math.isfinite(value) or value < 0.0 or value > _MAX_VAD_FIELD_SEC:
        return 0.0
    return value


# ── the types ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GateUtterance:
    """One STT final, paired with the VAD speech that produced it.

    ``tag`` is ``None`` in the raw log: where an utterance sits depends on WHICH
    question reads it. ``GateUtteranceLog.tagged`` returns copies tagged
    against a given question anchor (T04 hands those to the judge).
    """

    idx: int
    text: str
    final_arrival_ms: int
    segment_start_ms: Optional[int]
    segment_end_ms: Optional[int]
    segment_speech_ms: Optional[int]
    committed: bool = False
    tag: Optional[str] = None
    #: End of the segment the speech started in (``segment_end_ms`` is the end
    #: of the LAST paired segment). Drives the pre/during tag.
    segment_first_end_ms: Optional[int] = None


class GateUtteranceLog:
    """Bounded per-call log of every STT final the gate heard, in order."""

    def __init__(self, max_items: int = GATE_UTTERANCE_LOG_MAX) -> None:
        self._items: deque[GateUtterance] = deque(maxlen=max(1, int(max_items)))
        self._next_idx = 0

    def __len__(self) -> int:
        return len(self._items)

    def next_idx(self) -> int:
        idx = self._next_idx
        self._next_idx += 1
        return idx

    def append(self, utterance: GateUtterance) -> None:
        self._items.append(utterance)

    def get(self, idx: int) -> Optional[GateUtterance]:
        for item in self._items:
            if item.idx == idx:
                return item
        return None

    def all(self) -> tuple[GateUtterance, ...]:
        return tuple(self._items)

    def mark_committed(self, idxs: Iterable[int]) -> None:
        wanted = set(idxs)
        if not wanted:
            return
        self._items = deque(
            (replace(item, committed=True) if item.idx in wanted else item
             for item in self._items),
            maxlen=self._items.maxlen,
        )

    def tagged(self, question_anchor_ms: Optional[int]) -> tuple[GateUtterance, ...]:
        """Copies of every utterance, tagged against ``question_anchor_ms``."""
        return tuple(
            replace(item, tag=question_tag(
                item.segment_start_ms, item.segment_first_end_ms, question_anchor_ms))
            for item in self._items
        )


@dataclass(frozen=True)
class GateTurn:
    """A CLOSED reply, as the gate readers receive it.

    ``anchor_ms`` is what the staleness barrier compares with the question:
    the start of the paired VAD speech. Only when the call never delivered a
    single VAD event (a test double, an SDK without the observed VAD stream)
    does a committed turn fall back to the SDK's own speech start, which is
    today's behaviour. A turn the SDK never committed and that has no VAD
    timing has no anchor and is never grant evidence.

    ``closed_by``: ``commit`` (the SDK committed it), ``settle`` (the SDK
    dropped it and the line went quiet) or ``commit_only`` (a commit with no
    STT final the gate had seen).
    """

    text: str
    utterance_idxs: tuple[int, ...]
    segment_start_ms: Optional[int]
    segment_end_ms: Optional[int]
    segment_speech_ms: Optional[int]
    final_arrival_ms: Optional[int]
    committed: bool
    closed_by: str
    sdk_anchor_ms: Optional[int] = None
    vad_observed: bool = True
    segment_first_end_ms: Optional[int] = None

    @property
    def anchor_ms(self) -> Optional[int]:
        if self.segment_start_ms is not None:
            return self.segment_start_ms
        if not self.vad_observed and self.committed:
            return self.sdk_anchor_ms
        return None

    @property
    def grant_eligible(self) -> bool:
        """May this turn be the evidence a consent grant rests on?"""
        if self.segment_start_ms is not None:
            return True
        # No VAD timing at all on this call: keep today's behaviour for a turn
        # the SDK committed. Never for one it dropped (no timing whatsoever).
        return (not self.vad_observed) and self.committed

    def tag_for(self, question_anchor_ms: Optional[int]) -> str:
        """The skip-log tag of this turn against one question."""
        if self.segment_start_ms is not None:
            tag = question_tag(
                self.segment_start_ms, self.segment_first_end_ms, question_anchor_ms)
        elif self.anchor_ms is not None:
            # The SDK's speech start only (no VAD on this call): judged by its
            # start alone, as the staleness rule does.
            tag = question_tag(self.anchor_ms, self.anchor_ms, question_anchor_ms)
        else:
            tag = None
        return tag or TAG_NO_SEGMENT


def turn_is_grant_evidence(item: Any) -> bool:
    """True unless ``item`` is a ``GateTurn`` that may not ground a grant.

    Anything that is not a ``GateTurn`` (a bare string, an ``(text, anchor)``
    pair from an older producer or a direct test) keeps today's behaviour.
    """
    if isinstance(item, GateTurn):
        return item.grant_eligible
    return True


@dataclass
class _Segment:
    start_ms: int
    end_ms: Optional[int] = None
    speech_ms: Optional[int] = None
    consumed: bool = False


# ── the capture ──────────────────────────────────────────────────────────


class GateTurnCapture:
    """Per-call record of VAD segments and STT finals, emitting closed turns.

    Fed by the session glue in ``agent._run_phone_session``:

    * ``on_vad_event(event, now_s)``: every observed local VAD event;
    * ``on_final(text)``: every ``user_input_transcribed`` final;
    * ``on_commit(text, sdk_anchor_ms)``: every committed gate turn
      (``on_candidate_turn``).

    Emits each closed turn exactly once through ``emit``. Pure bookkeeping
    except for one timer (``call_later``), used to close a group of finals
    the SDK dropped.
    """

    def __init__(
        self,
        *,
        emit: Callable[[GateTurn], None],
        now_ms: Callable[[], int],
        settle_ms: Callable[[], int],
        log: Optional[Callable[..., None]] = None,
        call_later: Optional[Callable[[float, Callable[[], None]], Any]] = None,
        pairing_window_ms: Optional[int] = None,
    ) -> None:
        self._emit = emit
        self._now_ms = now_ms
        self._settle_ms = settle_ms
        self._log_fn = log
        self._call_later = call_later
        if pairing_window_ms is None:
            pairing_window_ms = GATE_STT_PAIRING_WINDOW_MS
        self._window_ms = max(0, int(pairing_window_ms))
        self.utterances = GateUtteranceLog()
        self._segments: deque[_Segment] = deque(maxlen=_GATE_SEGMENT_MAX)
        self._open_segment: Optional[_Segment] = None
        # (start, first_end, end, speech_ms) of the last paired speech.
        self._last_consumed: Optional[
            tuple[int, Optional[int], Optional[int], Optional[int]]] = None
        self._open_idxs: list[int] = []
        self._recent_turns: deque[GateTurn] = deque(maxlen=_GATE_RECENT_TURNS_MAX)
        # Late commits of turns already closed by silence, (normalised text,
        # utterance idxs), until the session's transcript writer takes them.
        self._duplicate_commits: deque[tuple[str, tuple[int, ...]]] = deque(
            maxlen=_GATE_RECENT_TURNS_MAX)
        self._last_vad_end_ms: Optional[int] = None
        self._settle_handle: Any = None
        self.vad_observed = False
        self.active = True

    # ── logging ──────────────────────────────────────────────────────────

    def _log(self, **fields: Any) -> None:
        if self._log_fn is None:
            return
        try:
            self._log_fn(**fields)
        except Exception:  # noqa: BLE001 — observability never fails the gate
            pass

    # ── VAD ──────────────────────────────────────────────────────────────

    def on_vad_event(self, event: Any, now_s: float) -> None:
        """One local VAD event, timed with the SDK's own formulas.

        Start of speech: ``now - speech_duration - inference_duration`` (the
        formula audio_recognition.py uses for its own speech start). End of
        speech: ``now - silence_duration``.
        """
        if not self.active:
            return
        raw_type = getattr(event, "type", None)
        event_type = getattr(raw_type, "value", raw_type)
        if event_type not in ("start_of_speech", "end_of_speech"):
            return
        if isinstance(now_s, bool) or not isinstance(now_s, (int, float)):
            return
        if not math.isfinite(float(now_s)):
            return
        self.vad_observed = True
        if event_type == "start_of_speech":
            start_ms = int(round((
                float(now_s) - _vad_seconds(event, "speech_duration")
                - _vad_seconds(event, "inference_duration")) * 1000))
            self._on_segment_start(start_ms)
            return
        end_ms = int(round((float(now_s) - _vad_seconds(event, "silence_duration")) * 1000))
        speech_s = _vad_seconds(event, "speech_duration")
        self._on_segment_end(end_ms, int(round(speech_s * 1000)) if speech_s > 0 else None)

    def _on_segment_start(self, start_ms: int) -> None:
        if self._open_segment is not None:
            # Two starts without an end: close the first at the new start, so
            # its speech still counts and never stays open for ever.
            prior = self._open_segment
            prior.end_ms = max(prior.start_ms, start_ms)
            prior.speech_ms = prior.end_ms - prior.start_ms
            self._open_segment = None
        segment = _Segment(start_ms=start_ms)
        self._segments.append(segment)
        self._open_segment = segment

    def _on_segment_end(self, end_ms: int, speech_ms: Optional[int]) -> None:
        segment = self._open_segment
        if segment is None:
            # An end with no observed start: reconstruct the start from the
            # speech duration, or fall back to a zero-length segment.
            start = end_ms - (speech_ms or 0)
            segment = _Segment(start_ms=start)
            self._segments.append(segment)
        segment.end_ms = max(segment.start_ms, end_ms)
        segment.speech_ms = (
            speech_ms if speech_ms is not None else segment.end_ms - segment.start_ms
        )
        self._open_segment = None
        self._last_vad_end_ms = segment.end_ms
        self._schedule_settle()

    # ── finals ───────────────────────────────────────────────────────────

    def _pair(self, arrival_ms: int) -> tuple[
            Optional[int], Optional[int], Optional[int], Optional[int], str, int]:
        """FIFO-pair a final arriving at ``arrival_ms`` with VAD speech.

        Returns ``(start, first_end, end, speech_ms, category, n_segments)``;
        ``first_end`` is the end of the segment the speech started in.
        """
        candidates: list[_Segment] = []
        for segment in self._segments:
            if segment.consumed or segment.end_ms is None:
                continue
            if segment.end_ms > arrival_ms:
                continue
            if arrival_ms - segment.end_ms > self._window_ms:
                # Expired: a blip whose final never came. Consumed so it can
                # never lend its start to a later final.
                segment.consumed = True
                continue
            candidates.append(segment)
        if candidates:
            for segment in candidates:
                segment.consumed = True
            first = min(candidates, key=lambda s: s.start_ms)
            end = max(s.end_ms for s in candidates if s.end_ms is not None)
            speech = sum(int(s.speech_ms or 0) for s in candidates)
            self._last_consumed = (first.start_ms, first.end_ms, end, speech)
            return first.start_ms, first.end_ms, end, speech, "paired", len(candidates)
        opened = self._open_segment
        if opened is not None and opened.start_ms <= arrival_ms:
            # STT finalised mid-segment: the speech is still going on. Share
            # its start; the segment itself is consumed by a later final.
            return opened.start_ms, None, None, None, "open_segment", 1
        last = self._last_consumed
        if last is not None and last[2] is not None and arrival_ms - last[2] <= self._window_ms:
            # A second final from speech an earlier final already consumed.
            return last[0], last[1], last[2], last[3], "shared_segment", 1
        return None, None, None, None, TAG_NO_SEGMENT, 0

    def on_final(self, text: Any) -> Optional[GateUtterance]:
        """Record one STT final (``user_input_transcribed`` with is_final)."""
        if not self.active or not isinstance(text, str) or not text.strip():
            return None
        arrival = self._now_ms()
        start, first_end, end, speech, category, n_segments = self._pair(arrival)
        utterance = GateUtterance(
            idx=self.utterances.next_idx(), text=text.strip(),
            final_arrival_ms=arrival, segment_start_ms=start,
            segment_end_ms=end, segment_speech_ms=speech,
            segment_first_end_ms=first_end,
        )
        self.utterances.append(utterance)
        self._open_idxs.append(utterance.idx)
        # One line per final, no text: the acoustic guard (T04) is calibrated
        # from these speech durations on live calls (T14).
        self._log(
            error_type="phone_gate_final", error_category=category,
            duration_sec=(round(speech / 1000.0, 3) if speech is not None else None),
            option_count=n_segments, turn_index=utterance.idx,
        )
        self._schedule_settle()
        return utterance

    # ── closing ──────────────────────────────────────────────────────────

    def _close(self, idxs: list[int], *, committed: bool, closed_by: str,
               sdk_anchor_ms: Optional[int]) -> Optional[GateTurn]:
        utterances = [u for u in (self.utterances.get(i) for i in idxs) if u is not None]
        if not utterances:
            return None
        closing = set(idxs)
        self._open_idxs = [i for i in self._open_idxs if i not in closing]
        timed = [u for u in utterances if u.segment_start_ms is not None]
        start = min((u.segment_start_ms for u in timed), default=None)
        # The segment the turn's speech started in: a closed one if any final
        # saw it closed (an open-segment final shares the same start).
        first_ends = [
            u.segment_first_end_ms for u in timed
            if u.segment_start_ms == start and u.segment_first_end_ms is not None
        ]
        ends = [u.segment_end_ms for u in timed if u.segment_end_ms is not None]
        spans = {
            (u.segment_start_ms, u.segment_end_ms): u.segment_speech_ms
            for u in timed
        }
        speech_values = [v for v in spans.values() if v is not None]
        turn = GateTurn(
            text=" ".join(u.text for u in utterances).strip(),
            utterance_idxs=tuple(u.idx for u in utterances),
            segment_start_ms=start,
            segment_end_ms=max(ends) if ends else None,
            segment_speech_ms=sum(speech_values) if speech_values else None,
            final_arrival_ms=max(u.final_arrival_ms for u in utterances),
            committed=committed,
            closed_by=closed_by,
            sdk_anchor_ms=sdk_anchor_ms,
            vad_observed=self.vad_observed,
            segment_first_end_ms=first_ends[0] if first_ends else None,
        )
        if committed:
            self.utterances.mark_committed(turn.utterance_idxs)
        self._recent_turns.append(turn)
        if not self._open_idxs:
            self._cancel_settle()
        self._emit(turn)
        return turn

    def on_commit(self, text: Any, sdk_anchor_ms: Any = None) -> Optional[GateTurn]:
        """The SDK committed a gate turn. Emits it at most once.

        Reconciliation: the oldest open finals whose concatenation is contained
        in the committed text are closed as that turn. A commit that only
        repeats a turn already closed by silence is NOT re-emitted (a re-ask
        must never be answered by the echo of the reply that caused it). A
        commit with no final the gate had seen is emitted on its own, timed by
        the same pairing (or, on a call with no VAD at all, by the SDK).
        """
        if not isinstance(text, str) or not text.strip():
            return None
        anchor = _as_ms(sdk_anchor_ms) if isinstance(sdk_anchor_ms, int) else None
        norm_commit = normalize_gate_text(text)
        if self.active and self._open_idxs:
            open_texts = [
                (i, self.utterances.get(i)) for i in self._open_idxs
            ]
            open_texts = [(i, u) for i, u in open_texts if u is not None]
            matched = 0
            for k in range(len(open_texts), 0, -1):
                joined = normalize_gate_text(" ".join(u.text for _, u in open_texts[:k]))
                if joined and joined in norm_commit:
                    matched = k
                    break
            if matched:
                return self._close(
                    [i for i, _ in open_texts[:matched]], committed=True,
                    closed_by="commit", sdk_anchor_ms=anchor)
        if self.active:
            for turn in reversed(self._recent_turns):
                if turn.committed:
                    continue
                norm_turn = normalize_gate_text(turn.text)
                if norm_commit and norm_turn and (
                        norm_commit in norm_turn or norm_turn in norm_commit):
                    # The SDK committed a turn the gate already closed by
                    # silence. Record that it committed; never read it twice.
                    self.utterances.mark_committed(turn.utterance_idxs)
                    self._recent_turns = deque(
                        (replace(t, committed=True) if t is turn else t
                         for t in self._recent_turns),
                        maxlen=self._recent_turns.maxlen,
                    )
                    self._duplicate_commits.append((norm_commit, turn.utterance_idxs))
                    self._log(
                        error_type="phone_gate_turn_barrier",
                        error_category="commit_duplicate",
                        option_count=len(turn.utterance_idxs),
                    )
                    return None
        if not self.active:
            # After the gate: today's producer, untouched.
            turn = GateTurn(
                text=text.strip(), utterance_idxs=(), segment_start_ms=None,
                segment_end_ms=None, segment_speech_ms=None, final_arrival_ms=None,
                committed=True, closed_by="commit_only", sdk_anchor_ms=anchor,
                vad_observed=False,
            )
            self._emit(turn)
            return turn
        utterance = self.on_final(text)
        if utterance is None:
            return None
        return self._close(
            [utterance.idx], committed=True, closed_by="commit_only",
            sdk_anchor_ms=anchor)

    def take_duplicate_commit(self, text: Any) -> Optional[tuple[int, ...]]:
        """The utterance idxs of a late commit of ``text``, consumed once.

        The SDK adds a kept commit to the chat context right after
        ``on_user_turn_completed``; the transcript writer asks here whether
        that item merely repeats a turn the gate had already closed by silence.
        """
        norm = normalize_gate_text(text)
        for position, (seen, idxs) in enumerate(self._duplicate_commits):
            if seen == norm:
                del self._duplicate_commits[position]
                return idxs
        return None

    def is_committed(self, idxs: Iterable[int]) -> bool:
        """True when every utterance in ``idxs`` has since been committed by the SDK."""
        items = [self.utterances.get(i) for i in idxs]
        return bool(items) and all(u is not None and u.committed for u in items)

    # ── the silence close (turns the SDK dropped) ─────────────────────────

    def _cancel_settle(self) -> None:
        handle = self._settle_handle
        self._settle_handle = None
        cancel = getattr(handle, "cancel", None)
        if callable(cancel):
            try:
                cancel()
            except Exception:  # noqa: BLE001
                pass

    def _schedule_settle(self, delay_ms: Optional[int] = None) -> None:
        if not self.active or not self._open_idxs:
            return
        if delay_ms is None:
            delay_ms = self._safe_settle_ms()
        self._cancel_settle()
        call_later = self._call_later
        if call_later is None:
            try:
                call_later = asyncio.get_running_loop().call_later
            except RuntimeError:
                return
        try:
            self._settle_handle = call_later(max(0.0, delay_ms / 1000.0), self.settle)
        except Exception:  # noqa: BLE001
            self._settle_handle = None

    def _safe_settle_ms(self) -> int:
        try:
            value = int(self._settle_ms())
        except Exception:  # noqa: BLE001
            value = 1000 + GATE_SETTLE_MARGIN_MS
        return max(100, value)

    def settle(self) -> Optional[GateTurn]:
        """Close the open finals if the line has been quiet long enough.

        Quiet means: no VAD segment open, and the endpointing ceiling (plus
        margin) has passed since the later of the last final and the last VAD
        end. Otherwise re-arms for the remaining time; a VAD end re-arms too.
        """
        self._settle_handle = None
        if not self.active or not self._open_idxs:
            return None
        if self._open_segment is not None:
            return None
        last_final = max(
            (u.final_arrival_ms for u in (self.utterances.get(i) for i in self._open_idxs)
             if u is not None),
            default=None,
        )
        marks = [m for m in (last_final, self._last_vad_end_ms) if m is not None]
        last_activity = max(marks) if marks else self._now_ms()
        quiet_for = self._now_ms() - last_activity
        settle = self._safe_settle_ms()
        if quiet_for < settle:
            self._schedule_settle(settle - quiet_for)
            return None
        return self._close(
            list(self._open_idxs), committed=False, closed_by="settle",
            sdk_anchor_ms=None)

    def stop(self) -> None:
        """The gate is over: stop capturing. Later commits pass straight through."""
        self.active = False
        self._cancel_settle()
