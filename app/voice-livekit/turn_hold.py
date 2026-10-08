"""M014 S02: hold the reply while candidate speech is still un-finalized, and a
per-phase minimum endpointing delay.

WHY THIS EXISTS (2026-10-08 interruption RCA).  Sarvam STT is finals-only: a
final reaches the worker ~0.9-1.0 s after the candidate stops.  The SDK decides
when to reply from the local VAD + endpointing, long before those words exist:

* a ready reply needs only ``min_delay / 2`` of quiet before it starts, and a
  reply paused because the candidate spoke resumes ~0.25 s after VAD
  end-of-speech, so the bot lands in the candidate's breath gaps;
* on a VAD end-of-speech the SDK commits whatever OLDER final is waiting, and
  the newest speech's final lands after that commit and cuts the reply.

Two cooperating seams use ONE fact, "the VAD heard speech that no STT final has
covered yet" (a *pending final*):

``TurnHold.before_turn``       hook time (``on_user_turn_completed``)
``TurnHold.before_first_audio`` the first TTS frame of every spoken line

plus ``TurnHold.on_speech_created`` / ``first_audio_released``, which apply the
per-phase minimum when the reply that asks the question starts PLAYING (the
SDK's ``agent_state_changed`` -> ``speaking``; not when it is created, and not
when its first TTS frame is merely synthesized: the SDK is still deciding when
to START that reply, using the minimum of the answer it follows).  The first
planned question is a ``say()`` line, so ``note_spoken_question`` applies its
class when that line has been heard.

A closed VAD segment that no non-empty final covers stops counting as pending
``PENDING_CLOSED_EXPIRY_SEC`` after it ended: the SDK never delivers an empty
final, so a cough or breath would otherwise hold every reply to the cap.

Every hold has an ABSOLUTE ceiling (``HOLD_ABSOLUTE_CEILING_SEC``), so recurring
wordless VAD noise can never hold a reply, a hook or the first-audio watchdog
indefinitely.  A line that cannot be interrupted (the fixed closing goodbye) is
never held at all.

PURE PYTHON.  No ``livekit`` import at module scope (``StopResponse`` is
resolved lazily at the one place it is raised), so this unit-tests without the
SDK.  Nothing here ever logs candidate text: only ``error_category``,
``schema``, ``phase`` and ``duration_sec`` (all allowlisted in observability).

GATE ISOLATION.  Everything is inert until ``active()`` is True.  ``agent.py``
wires ``active`` to ``assessment_persist_active[0]``, which becomes True only
right before the native screening coordinator starts, so identity and consent
turns are never held, merged or re-timed here.
"""

from __future__ import annotations

import asyncio
import inspect
import math
import re
import time
from collections import deque
from collections.abc import Mapping
from typing import Any, Awaitable, Callable, Optional

#: A VAD segment shorter than this is a blip or a breath, never "pending".
PENDING_MIN_SPEECH_SEC = 0.3
#: Sarvam cannot close a segment in under ~0.70 s of silence (22 x 32 ms
#: frames, fly.phone.toml), so a final arriving less than this long after a
#: segment ended cannot be that segment's final.
FINAL_COVER_MARGIN_SEC = 0.4
SEGMENT_HISTORY = 8
#: A CLOSED segment no non-empty final has covered stops counting as pending
#: this long after it ended.  Sarvam closes a segment ~0.7 s after speech stops
#: and delivers ~0.9-1.0 s after; an EMPTY final (cough, breath, line noise)
#: never reaches the session (livekit-agents 1.6.4 drops it in
#: ``audio_recognition._on_stt_event``), so without this expiry a wordless
#: segment would hold every later reply to the cap.  Absolute (end + this), so
#: the hook-time hold and the first-audio hold share ONE deadline per segment.
PENDING_CLOSED_EXPIRY_SEC = 1.5
#: Time for the SDK to commit a late final after it lands (on top of the
#: endpointing max delay).
POST_FINAL_GRACE_EXTRA_SEC = 0.3
#: Words the SDK needs in the banked transcript before it will commit a turn
#: over a reply that is the current interruptible speech
#: (``PHONE_MIN_INTERRUPTION_WORDS``); only the default, ``TurnHold`` is given
#: the live reader.
DEFAULT_COMMIT_MIN_WORDS = 3
#: While the candidate is mid-speech a hold keeps waiting (the bot must not start
#: talking over them), but wakes at least this often to re-arm the first-audio
#: watchdog so its fallback cannot fire into the candidate's speech.
SPEAKING_REARM_SEC = 1.0
#: ABSOLUTE ceiling of one hold, wall clock from when the hold starts.  The
#: quiet-time extension (a hold keeps waiting while a VAD segment is open) is
#: bounded by it, so recurring wordless VAD activity (line or background noise)
#: can never hold a reply, a hook or the first-audio watchdog indefinitely.
#: The effective ceiling is ``min(cap + commit grace, this)``, never below the
#: cap itself (see ``TurnHold._ceiling_sec``).
HOLD_ABSOLUTE_CEILING_SEC = 4.0
#: Orphan-carry backstop bound, on top of the endpointing max delay.
ORPHAN_EXTRA_SEC = 2.0
#: Padding on a wake-up aimed at a segment's expiry, so the re-check lands just
#: after it.
_EXPIRY_WAKE_PAD_SEC = 0.02
#: Two start events this close are one segment seen by two feeds.
_SAME_SEGMENT_TOLERANCE_SEC = 1.0
#: An open segment this old lost its end event (a stuck "speaking" signal): it
#: is ignored rather than holding every later reply to the cap.
OPEN_SEGMENT_STALE_SEC = 120.0

ERROR_TYPE_HOLD = "phone_turn_hold"
ERROR_TYPE_PHASE = "phone_endpointing_phase"

OPEN = "open"
SHORT = "short"

#: Reply phases whose next answer is open-ended.  Everything else (name
#: confirm, callback, withdrawal/revocation confirm, opt-out, end, closing,
#: close_scheduled, drop_or_timeout, exception, teardown, None/unknown) is a
#: short answer and keeps the static minimum.
OPEN_PHASES = frozenset({
    "screening",
    "resume_conflict",
    "wind_down",
    "candidate_qna",
    "patience",
    "post_interrupt_ack",
})

_OPEN_MARKERS_RE = re.compile(
    r"\b(what|how|why|which|where|when|who|tell me|walk me|describe|explain|"
    r"share|talk me|take me through)\b"
)
# A yes/no clause starts the text, or a clause after a sentence/clause break
# (optionally led by and/or/so), with an auxiliary + a pronoun subject.
_YES_NO_CLAUSE_RE = re.compile(
    r"(^|[.?!:,;]\s*(and|or|so)?\s*)"
    r"(are|is|do|does|did|have|has|can|could|would|will|were|was|should|may)"
    r"\s+(you|we|there|it|that|this)\b"
)


def is_yes_no_question(text: Any) -> bool:
    """True when ``text`` reads as a closed yes/no question."""
    if not isinstance(text, str):
        return False
    normalised = " ".join(text.lower().split())
    if not normalised:
        return False
    if _OPEN_MARKERS_RE.search(normalised):
        return False
    return bool(_YES_NO_CLAUSE_RE.search(normalised))


def classify_answer_endpointing(phase: Any, objective: Any) -> str:
    """``"open"`` or ``"short"``: what kind of answer the bot is waiting for."""
    if phase not in OPEN_PHASES:
        return SHORT
    if phase == "screening" and is_yes_no_question(objective):
        return SHORT
    return OPEN


def _valid_anchor(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and float(value) > 0
    )


def _message_text(message: Any) -> str:
    """The text of a ChatMessage-shaped object (``text_content`` or str parts)."""
    text = getattr(message, "text_content", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    parts: list[str] = []
    for part in getattr(message, "content", None) or []:
        if isinstance(part, str):
            parts.append(part)
        else:
            value = getattr(part, "text", None)
            if isinstance(value, str):
                parts.append(value)
    return "".join(parts).strip()


def _read_anchor(message: Any) -> Any:
    metrics = getattr(message, "metrics", None)
    if isinstance(metrics, Mapping):
        value = metrics.get("started_speaking_at")
        if _valid_anchor(value):
            return value
    return None


def _stop_response_class() -> type:
    """``livekit.agents.StopResponse``, imported where it is raised."""
    from livekit.agents import StopResponse  # noqa: PLC0415

    return StopResponse


async def _maybe_await(value: Any) -> None:
    if inspect.isawaitable(value):
        await value


_SPLIT_WORDS: Any = None


def count_words(text: Any) -> int:
    """Words in ``text`` the way the SDK counts them for its barge-in word gate
    (``split_words(..., split_character=True)``), falling back to whitespace
    splitting when the SDK tokenizer cannot be imported (unit tests)."""
    global _SPLIT_WORDS  # noqa: PLW0603
    if not isinstance(text, str) or not text.strip():
        return 0
    if _SPLIT_WORDS is None:
        try:
            from livekit.agents.tokenize.basic import split_words  # noqa: PLC0415

            _SPLIT_WORDS = split_words
        except Exception:  # noqa: BLE001 — no SDK here: whitespace words
            _SPLIT_WORDS = False
    if _SPLIT_WORDS:
        try:
            words = _SPLIT_WORDS(text, split_character=True)
            if isinstance(words, (list, tuple)):
                return len(words)
        except Exception:  # noqa: BLE001
            pass
    return len(text.split())


class PendingFinalTracker:
    """Wall-clock bookkeeping of VAD speech segments versus STT finals.

    Fed by the handlers ``agent.py`` already registers (never by its own
    ``session.on``).  Holds times only, never text.
    """

    def __init__(
        self,
        active: Callable[[], bool],
        *,
        clock: Callable[[], float] = time.time,
        min_speech_sec: float = PENDING_MIN_SPEECH_SEC,
        cover_margin_sec: float = FINAL_COVER_MARGIN_SEC,
        history: int = SEGMENT_HISTORY,
        closed_expiry_sec: float = PENDING_CLOSED_EXPIRY_SEC,
    ) -> None:
        self._active = active
        self.clock = clock
        self.min_speech_sec = float(min_speech_sec)
        self.cover_margin_sec = float(cover_margin_sec)
        self.closed_expiry_sec = float(closed_expiry_sec)
        # [start, end | None]; mutable lists so a refinement edits in place.
        self._segments: deque[list[Any]] = deque(maxlen=max(1, int(history)))
        self.armed_at: Optional[float] = None
        self.last_final_wall: Optional[float] = None
        self.final_count = 0
        # Words in the finals since the last committed turn: the SDK banks a
        # refused (too short) fragment and appends the next one to it.  Counts
        # only, never text.
        self._uncommitted_words = 0
        self._waiters: list[asyncio.Future] = []

    # ── arming ────────────────────────────────────────────────────────────

    def active(self) -> bool:
        try:
            return bool(self._active())
        except Exception:  # noqa: BLE001 — a broken predicate means inert
            return False

    def _arm(self, wall: float) -> bool:
        """True when events are being recorded (the screening phase)."""
        if not self.active():
            return False
        if self.armed_at is None:
            self.armed_at = wall
        return True

    # ── feeds ─────────────────────────────────────────────────────────────

    def on_speech_start(self, wall: float) -> None:
        if not _finite(wall) or not self._arm(float(wall)):
            return
        wall = float(wall)
        open_segment = self._open_segment()
        if open_segment is not None:
            if abs(wall - open_segment[0]) <= _SAME_SEGMENT_TOLERANCE_SEC:
                # The same segment seen by the VAD stream and by the
                # user-state fallback: keep the earlier (more accurate) start.
                # Never earlier than the arming time (gate-phase isolation).
                open_segment[0] = max(
                    self.armed_at if self.armed_at is not None else wall,
                    min(open_segment[0], wall),
                )
                self._notify()
                return
            open_segment[1] = max(open_segment[0], wall)
        self._segments.append([wall, None])
        self._notify()

    def on_speech_end(self, wall: float) -> None:
        if not _finite(wall) or not self.active():
            return
        wall = float(wall)
        open_segment = self._open_segment()
        if open_segment is not None:
            open_segment[1] = max(open_segment[0], wall)
            self._notify()
            return
        # No open start: ignored.  A duplicate end from the second feed may
        # only REFINE the end of the segment that just closed.
        if self._segments:
            last = self._segments[-1]
            if last[1] is not None and abs(wall - last[1]) <= _SAME_SEGMENT_TOLERANCE_SEC:
                last[1] = max(last[0], min(last[1], wall))

    def on_final(self, wall: float, text: Any) -> None:
        """One STT final.  Only non-empty text counts: the SDK never delivers an
        empty final to the session, so a wordless segment is released by
        ``closed_expiry_sec`` instead, not by an empty final."""
        if not _finite(wall) or not self._arm(float(wall)):
            return
        if isinstance(text, str) and text.strip():
            self.last_final_wall = float(wall)
            self.final_count += 1
            self._uncommitted_words += count_words(text)
            self._notify()

    def note_commit(self) -> None:
        """A turn was committed (the hook runs): the banked words are consumed."""
        self._uncommitted_words = 0

    # ── queries ───────────────────────────────────────────────────────────

    def uncommitted_words(self) -> int:
        """Words in the non-empty finals since the last committed turn."""
        return self._uncommitted_words

    def _open_segment(self) -> Optional[list[Any]]:
        if self._segments and self._segments[-1][1] is None:
            return self._segments[-1]
        return None

    def candidate_speaking(self) -> bool:
        """True while a VAD segment is open (active phase only)."""
        if not self.active():
            return False
        segment = self._open_segment()
        return segment is not None and self.clock() - segment[0] < OPEN_SEGMENT_STALE_SEC

    def _closed_pending(self, start: float, end: float, now: float) -> bool:
        covered = self.last_final_wall
        return (
            end - start >= self.min_speech_sec
            and now <= end + self.closed_expiry_sec
            and (covered is None or covered < end + self.cover_margin_sec)
        )

    def pending(self, now: Optional[float] = None) -> bool:
        """True when speech was heard that no STT final has covered yet."""
        if self.armed_at is None or not self.active():
            return False
        if now is None:
            now = self.clock()
        for start, end in self._segments:
            if start < self.armed_at:
                continue
            if end is None:
                if self.min_speech_sec <= now - start < OPEN_SEGMENT_STALE_SEC:
                    return True
            elif self._closed_pending(start, end, now):
                return True
        return False

    def seconds_until_release(self, now: Optional[float] = None) -> Optional[float]:
        """Seconds until the nearest pending CLOSED segment expires on its own
        (nothing else wakes a waiter then), or ``None`` when none will."""
        if self.armed_at is None or not self.active():
            return None
        if now is None:
            now = self.clock()
        soonest: Optional[float] = None
        for start, end in self._segments:
            if start < self.armed_at or end is None:
                continue
            if self._closed_pending(start, end, now):
                left = end + self.closed_expiry_sec - now
                if soonest is None or left < soonest:
                    soonest = left
        return soonest

    # ── change notification ──────────────────────────────────────────────

    def _notify(self) -> None:
        waiters, self._waiters = self._waiters, []
        for fut in waiters:
            if not fut.done():
                fut.set_result(None)

    async def wait_change(self, timeout: float) -> bool:
        """Wake on any tracker event or on ``timeout``.  True when an event woke
        us.  Cancellation propagates."""
        if not timeout or timeout <= 0:
            return False
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._waiters.append(fut)
        try:
            await asyncio.wait_for(fut, timeout)
            return True
        except asyncio.TimeoutError:
            return False
        finally:
            try:
                self._waiters.remove(fut)
            except ValueError:
                pass


def _finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


class TurnHold:
    """The hold, the merge and the per-phase minimum.  See the module docstring.

    ``carry`` is ``(text, started_speaking_at | None)`` of a turn this object
    yielded to a newer final; it is merged into the NEXT turn's message.
    """

    def __init__(
        self,
        tracker: PendingFinalTracker,
        *,
        hold_max_sec: Callable[[], float],
        log: Callable[..., Any],
        endpoint_max_sec: Callable[[], float] = lambda: 2.0,
        open_min_sec: Callable[[], float] = lambda: 0.8,
        short_min_sec: Callable[[], float] = lambda: 0.3,
        on_orphan: Optional[Callable[[], Any]] = None,
        rearm: Optional[Callable[[], Any]] = None,
        suspend: Optional[Callable[[], Any]] = None,
        min_words: Callable[[], int] = lambda: DEFAULT_COMMIT_MIN_WORDS,
        stop_response: Optional[type] = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._tracker = tracker
        self._hold_max = hold_max_sec
        self._log = log
        self._endpoint_max = endpoint_max_sec
        self._open_min = open_min_sec
        self._short_min = short_min_sec
        self._on_orphan = on_orphan
        self._rearm = rearm
        self._suspend = suspend
        self._min_words = min_words
        self._phase_apply: Optional[Callable[[float], Any]] = None
        self._stop_response = stop_response
        self._mono = monotonic
        self.carry: Optional[tuple[str, Any]] = None
        self._orphan_task: Optional[asyncio.Task] = None
        # The minimum in force: construction uses the static (short) value.
        self._min_class = SHORT
        self._applied_min: Optional[float] = None
        # (wanted class, phase, apply_min) of the newest generated reply, applied
        # when that reply's first audio is released (see `first_audio_released`).
        self._deferred_min: Optional[tuple[str, Any, Callable[[float], Any]]] = None

    # ── logging ───────────────────────────────────────────────────────────

    def _emit(self, error_type: str, category: str, **extra: Any) -> None:
        try:
            self._log("unknown_event", error_type=error_type,
                      error_category=category, **extra)
        except Exception:  # noqa: BLE001 — a log failure never perturbs a call
            pass

    def _cap(self) -> float:
        try:
            value = float(self._hold_max())
        except (TypeError, ValueError):
            return 0.0
        return value if math.isfinite(value) and value > 0 else 0.0

    def _wall(self) -> float:
        return self._tracker.clock()

    def _ceiling_sec(self, cap: float) -> float:
        """Absolute length of one hold: the cap plus at most the commit grace,
        never more than ``HOLD_ABSOLUTE_CEILING_SEC``, never less than the cap."""
        return max(cap, min(cap + self._grace_sec(), HOLD_ABSOLUTE_CEILING_SEC))

    async def _wait(self, remaining: float) -> None:
        """Wake on any tracker event, on ``remaining`` or, if sooner, just after
        a pending closed segment expires (nothing else signals that)."""
        release = self._tracker.seconds_until_release(self._wall())
        if release is not None:
            remaining = min(remaining, max(0.0, release) + _EXPIRY_WAKE_PAD_SEC)
        await self._tracker.wait_change(remaining)

    # ── (a) hook time ─────────────────────────────────────────────────────

    async def before_turn(self, message: Any) -> None:
        """First statement of ``on_user_turn_completed`` (native turns only).

        Merges a carried turn into ``message``; then, only while speech is
        pending, holds for the late final and yields to it (``StopResponse``).
        Bounded by the cap (quiet time only: it restarts while the candidate is
        still talking) and by the absolute ceiling (``_ceiling_sec``, wall clock
        from the start of the hold); a no-op when nothing is pending.  May raise
        ``StopResponse``.
        """
        tracker = self._tracker
        if not tracker.active():
            return
        # The SDK committed: the words it had banked belong to this turn.
        tracker.note_commit()
        cap = self._cap()
        if cap <= 0 and self.carry is None:
            return
        own_text = _message_text(message)
        if not own_text:
            return
        own_anchor = _read_anchor(message)
        if self.carry is not None:
            own_text, own_anchor = self._merge_carry(message, own_text, own_anchor)
        if cap <= 0 or not tracker.pending(self._wall()):
            return

        finals0 = tracker.final_count
        started = self._mono()
        deadline = started + cap
        # Absolute ceiling: the quiet-time restarts below can never push the
        # hold past it, however much wordless VAD activity keeps arriving.
        ceiling = started + self._ceiling_sec(cap)
        # The previous reply's first-audio watchdog is still counting (this
        # turn's own is armed only after the hook returns): restart it once so
        # it cannot speak its fallback over the candidate while we hold.
        await self._call_rearm()
        speaking = False
        extended = False
        while True:
            # The cap counts QUIET time only: while the candidate is still
            # talking the hold keeps waiting (a hold costs no dead air then) and
            # the cap restarts from the moment they stop, up to the ceiling.
            if tracker.candidate_speaking():
                speaking = True
                extended = True
                deadline = self._mono() + cap
                if self._mono() < ceiling:
                    await self._call_rearm()
            elif speaking:
                speaking = False
                deadline = self._mono() + cap
            remaining = min(deadline, ceiling) - self._mono()
            if speaking:
                remaining = min(remaining, SPEAKING_REARM_SEC)
            if remaining <= 0:
                self._emit(
                    ERROR_TYPE_HOLD,
                    "held_ceiling_reached" if extended else "held_cap_reached",
                    duration_sec=round(self._mono() - started, 3))
                return
            await self._wait(remaining)
            if tracker.final_count > finals0:
                self.carry = (own_text, own_anchor)
                self._emit(ERROR_TYPE_HOLD, "held_yield",
                           duration_sec=round(self._mono() - started, 3))
                self._start_orphan_watch()
                # The yielded turn now owns recovery: the previous reply's
                # watchdog must not speak a stale fallback into the gap while
                # the candidate keeps talking (the successor's coordinator, or
                # the orphan backstop, arms the next one).
                await self._call_suspend()
                raise (self._stop_response or _stop_response_class())()
            if not tracker.pending(self._wall()):
                self._emit(ERROR_TYPE_HOLD, "held_cleared",
                           duration_sec=round(self._mono() - started, 3))
                return

    async def _call_suspend(self) -> None:
        if self._suspend is None:
            return
        try:
            await _maybe_await(self._suspend())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never breaks a turn
            pass

    async def _call_rearm(self) -> None:
        if self._rearm is None:
            return
        try:
            await _maybe_await(self._rearm())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a re-arm failure never breaks a turn
            pass

    def _merge_carry(
        self, message: Any, own_text: str, own_anchor: Any,
    ) -> tuple[str, Any]:
        carry_text, carry_anchor = self.carry  # type: ignore[misc]
        self._clear_carry()
        merged = (carry_text + " " + own_text).strip()
        # The merged turn keeps the NEWER start (this message's own), never the
        # carried one: `_native_turn_predates_question` drops any turn that began
        # before the current bot line, so inheriting the older start would throw
        # the whole merged answer away on a build that still has that check.
        anchor = own_anchor if _valid_anchor(own_anchor) else (
            carry_anchor if _valid_anchor(carry_anchor) else own_anchor)
        try:
            message.content = [merged]
        except Exception:  # noqa: BLE001
            pass
        # A plain-attribute `text_content` (test doubles) is not derived from
        # `content`; the SDK's is a read-only property and is never touched.
        try:
            if isinstance(vars(message).get("text_content"), str):
                message.text_content = merged
        except Exception:  # noqa: BLE001
            pass
        metrics = getattr(message, "metrics", None)
        if (
            isinstance(metrics, Mapping)
            and not _valid_anchor(own_anchor)
            and _valid_anchor(carry_anchor)
        ):
            try:
                metrics["started_speaking_at"] = carry_anchor  # type: ignore[index]
            except Exception:  # noqa: BLE001
                pass
        self._emit(ERROR_TYPE_HOLD, "carry_merged")
        return merged, anchor

    def _clear_carry(self) -> None:
        self.carry = None
        task, self._orphan_task = self._orphan_task, None
        if task is not None and not task.done():
            task.cancel()

    # ── orphaned-carry backstop ───────────────────────────────────────────

    def _start_orphan_watch(self) -> None:
        old, self._orphan_task = self._orphan_task, None
        if old is not None and not old.done():
            old.cancel()
        try:
            self._orphan_task = asyncio.get_running_loop().create_task(
                self._watch_orphan(),
            )
        except RuntimeError:  # no running loop: nothing can be scheduled
            self._orphan_task = None

    def _orphan_bound(self) -> float:
        try:
            return max(0.0, float(self._endpoint_max())) + ORPHAN_EXTRA_SEC
        except (TypeError, ValueError):
            return 2.0 + ORPHAN_EXTRA_SEC

    async def _watch_orphan(self) -> None:
        """If the yielded turn's successor never reaches the hook, speak.

        The bound runs only while the candidate is NOT speaking: a long
        resumed answer can take as long as it takes to commit.
        """
        tracker = self._tracker
        quiet_deadline: Optional[float] = None
        try:
            while self.carry is not None:
                if tracker.candidate_speaking():
                    quiet_deadline = None
                    await tracker.wait_change(1.0)
                    continue
                if quiet_deadline is None:
                    quiet_deadline = self._mono() + self._orphan_bound()
                remaining = quiet_deadline - self._mono()
                if remaining <= 0:
                    break
                await tracker.wait_change(remaining)
            else:
                return
            if self.carry is None:
                return
            self.carry = None
            self._emit(ERROR_TYPE_HOLD, "carry_orphaned")
            if self._on_orphan is not None:
                await _maybe_await(self._on_orphan())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the backstop never raises
            pass

    def on_close(self) -> None:
        """The call ended: log an unconsumed carry and stop the watch."""
        if self.carry is not None:
            self._emit(ERROR_TYPE_HOLD, "carry_unmerged_at_close")
        self._clear_carry()

    # ── (b) first audio ───────────────────────────────────────────────────

    def _grace_sec(self) -> float:
        try:
            return max(0.0, float(self._endpoint_max())) + POST_FINAL_GRACE_EXTRA_SEC
        except (TypeError, ValueError):
            return 2.0 + POST_FINAL_GRACE_EXTRA_SEC

    def _commit_expected(self) -> bool:
        """True when the SDK will commit the finals banked so far.

        livekit-agents 1.6.4 ``on_end_of_turn`` refuses to commit (returns
        False) while the current interruptible speech, here the HELD reply, is
        playing or pending and the banked transcript has fewer than
        ``min_words`` words.  Waiting for a commit that cannot come would only
        add dead air.
        """
        try:
            needed = int(self._min_words())
        except (TypeError, ValueError):
            needed = DEFAULT_COMMIT_MIN_WORDS
        return self._tracker.uncommitted_words() >= needed

    async def before_first_audio(
        self,
        *,
        rearm: Optional[Callable[[], Any]] = None,
        interruptible: bool = True,
    ) -> None:
        """Called before the first TTS frame of a line is yielded.

        Holds while speech is pending; re-arms the first-audio watchdog so it
        cannot fire a fallback mid-hold.  Bounded by the cap, which counts QUIET
        time only: while a VAD segment is open the hold keeps waiting (the SDK
        never re-checks that the candidate is silent once a reply is
        authorized) and the cap restarts when they stop, BUT never past the
        absolute ceiling (``_ceiling_sec``: cap + commit grace, at most
        ``HOLD_ABSOLUTE_CEILING_SEC``, wall clock from the start of this hold),
        so recurring wordless VAD noise cannot hold a line, or keep the
        watchdog suppressed, indefinitely.  When a late final arrives that the
        SDK WILL commit (enough words), keeps holding for that commit (which
        cancels this reply before any audio) and then releases; a final too
        short to commit (a backchannel) does not extend the hold.

        A line that cannot be interrupted (``interruptible=False``: the fixed
        closing goodbye, any ``say(..., allow_interruptions=False)``) is never
        held: the SDK plays it over the candidate on purpose and no commit can
        cancel it, so holding (or waiting a commit grace) would only push the
        farewell past its playout bound.  Cancellation propagates.
        """
        tracker = self._tracker
        if not tracker.active():
            return
        if not interruptible:
            if tracker.pending(self._wall()):
                self._emit(ERROR_TYPE_HOLD, "audio_hold_skipped",
                           schema="non_interruptible")
            return
        cap = self._cap()
        if cap <= 0 or not tracker.pending(self._wall()):
            return
        started = self._mono()
        deadline = started + cap
        # Absolute ceiling: later finals and quiet-time restarts can never push
        # the hold past it.
        ceiling = started + self._ceiling_sec(cap)
        hard_deadline = min(deadline + self._grace_sec(), ceiling)
        # Read BEFORE the first await so a final landing during the re-arm is
        # still seen.
        finals_seen = tracker.final_count
        await self._call_first_audio_rearm(rearm)
        grace_deadline: Optional[float] = None
        schema = "pending"
        speaking = False
        extended = False
        while True:
            now = self._mono()
            # The cap counts QUIET time only.  livekit-agents 1.6.4 authorizes a
            # reply once, right after it is scheduled, and never re-checks that
            # the candidate is silent before forwarding its audio: this hold is
            # the only thing keeping a ready reply from playing over a
            # continuing answer.  So while a VAD segment is open the hold keeps
            # waiting (no dead air: they are talking) and the deadlines restart
            # from the moment they stop, all bounded by ``ceiling``.  An open
            # segment older than ``OPEN_SEGMENT_STALE_SEC`` (a stuck VAD) stops
            # counting as speech.
            if tracker.candidate_speaking():
                speaking = True
                extended = True
                deadline = now + cap
                hard_deadline = min(deadline + self._grace_sec(), ceiling)
                # The banked commit (if any) was cancelled by the VAD start; a
                # new final after this segment re-opens the grace.
                grace_deadline = None
                schema = "pending"
                # Keep the first-audio watchdog from speaking its fallback into
                # the candidate's speech (stops at the ceiling: from then on the
                # hold is released and the watchdog runs free).
                if now < ceiling:
                    await self._call_first_audio_rearm(rearm)
                now = self._mono()
            elif speaking:
                speaking = False
                deadline = now + cap
                hard_deadline = min(deadline + self._grace_sec(), ceiling)
                # The SDK re-runs end-of-turn detection on the words it still
                # has banked when this segment ends and commits (cancelling this
                # reply) up to the endpoint max later: keep waiting for that
                # commit instead of releasing when the wordless segment expires.
                if self._commit_expected():
                    grace_deadline = now + self._grace_sec()
                    schema = "after_final"
            # Once a committable final has landed the SDK's commit is due within
            # the grace (final arrival + endpoint max): that window is NOT cut
            # short by the overall cap, or a reply could start and then be cut
            # by the commit.  Only the absolute ceiling bounds it.
            limit = deadline if grace_deadline is None else min(grace_deadline, hard_deadline)
            limit = min(limit, ceiling)
            remaining = limit - now
            if speaking:
                remaining = min(remaining, SPEAKING_REARM_SEC)
            if remaining <= 0:
                if grace_deadline is None or grace_deadline > hard_deadline:
                    self._emit(
                        ERROR_TYPE_HOLD,
                        "audio_hold_ceiling_reached" if extended
                        else "audio_hold_cap_reached",
                        schema=schema)
                break
            await self._wait(remaining)
            if tracker.final_count > finals_seen:
                finals_seen = tracker.final_count
                if self._commit_expected() and not tracker.candidate_speaking():
                    final_wall = tracker.last_final_wall
                    age = max(0.0, self._wall() - final_wall) if final_wall is not None else 0.0
                    grace_deadline = self._mono() + max(0.0, self._grace_sec() - age)
                    schema = "after_final"
                    # The commit is now awaited: restart the watchdog so its
                    # fallback cannot replace this reply inside the grace.
                    if self._mono() < ceiling:
                        await self._call_first_audio_rearm(rearm)
            if grace_deadline is None and not tracker.pending(self._wall()):
                break
        self._emit(ERROR_TYPE_HOLD, "audio_hold",
                   duration_sec=round(self._mono() - started, 3))

    @staticmethod
    async def _call_first_audio_rearm(rearm: Optional[Callable[[], Any]]) -> None:
        if rearm is None:
            return
        try:
            await _maybe_await(rearm())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a re-arm failure never breaks a line
            pass

    # ── per-phase minimum ─────────────────────────────────────────────────

    def set_phase_apply(self, apply_min: Optional[Callable[[float], Any]]) -> None:
        """The live minimum setter ``note_spoken_question`` uses (the first
        planned question is a ``say()`` line, so no ``speech_created`` carries
        one for it)."""
        self._phase_apply = apply_min

    def on_speech_created(
        self,
        *,
        source: Any,
        phase: Any,
        objective: Any,
        apply_min: Optional[Callable[[float], Any]],
    ) -> None:
        """Note the minimum for the answer the bot will wait for once this reply
        has been spoken.

        Generated replies only (``say`` lines keep the current class) and only
        in the screening phase.  Nothing is applied here: the SDK is still
        deciding when to START this reply, using the minimum in force (that of
        the answer it follows), so the change waits until the reply is playing
        (``first_audio_released``).  Never raises.
        """
        if apply_min is None or source != "generate_reply":
            return
        if not self._tracker.active():
            return
        self._deferred_min = (classify_answer_endpointing(phase, objective), phase, apply_min)

    def note_spoken_question(self, *, phase: Any, objective: Any) -> None:
        """A planned question was just SPOKEN through ``say()`` (the first one):
        apply the class of the answer it asks for now.  Never raises."""
        apply_min = self._phase_apply
        if apply_min is None or not self._tracker.active():
            return
        self._apply_class(classify_answer_endpointing(phase, objective), phase, apply_min)

    def first_audio_released(self) -> None:
        """A generated reply started PLAYING (``agent_state_changed`` ->
        ``speaking``): apply the minimum noted by ``on_speech_created`` (only
        when its class changes).  Never raises."""
        deferred, self._deferred_min = self._deferred_min, None
        if deferred is None:
            return
        wanted, phase, apply_min = deferred
        self._apply_class(wanted, phase, apply_min)

    def _apply_class(
        self, wanted: str, phase: Any, apply_min: Callable[[float], Any],
    ) -> None:
        try:
            if wanted == self._min_class:
                return
            value = float(self._open_min() if wanted == OPEN else self._short_min())
            previous = (
                self._applied_min if self._applied_min is not None
                else float(self._short_min())
            )
            if value != previous:
                apply_min(value)
            self._min_class = wanted
            self._applied_min = value
            self._emit(
                ERROR_TYPE_PHASE, wanted,
                duration_sec=round(value, 3),
                phase=_safe_phase(phase),
            )
        except Exception:  # noqa: BLE001 — logged below, never into the SDK handler
            self._emit(ERROR_TYPE_PHASE, "apply_failed", phase=_safe_phase(phase))


def _safe_phase(phase: Any) -> str:
    if isinstance(phase, str) and re.fullmatch(r"[a-zA-Z0-9_]{1,64}", phase):
        return phase
    return "unknown"
