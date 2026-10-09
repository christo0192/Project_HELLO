"""M014 PR-B: per-question minimum endpointing for the phone screening phase.

The bot waits for two kinds of answer. An OPEN one ("tell me about ...", "what /
how / when ...") is where a candidate pauses to think, so the SDK should wait a
little longer before it starts the reply: the SDK's reply-start silence gate is
``min_delay / 2`` of quiet, capped in practice by the deployed Silero VAD, which
ends speech after 0.25 s of silence (so the gate moves from 0.15 s to about
0.25 s; a longer gate needs a longer VAD ``min_silence_duration``, an owner
decision outside this module). A SHORT one (yes/no, name confirmation, callback,
closing) keeps the static minimum.

``PhoneEndpointingPhase`` notes that a generated reply was created, and applies
the minimum for the answer THAT reply asks for once the reply is PLAYING (the
SDK is still deciding when to START the reply, using the minimum of the answer it
follows, so the change must not land earlier). The class is read from the reply
snapshot at that moment (every reply path sets it; with preemptive generation the
reply is created before the turn is authorized, so reading at creation would lag
one question). The deferral is bound to the speech handle: a different line
(a ``say()``) that plays first does not consume it. An unknown phase keeps the
current class. It applies a value only on a class change, only while the
screening phase is active, and a failure is logged and swallowed. Identity,
pickup and consent turns are never touched (``active`` is False until the
screening phase is armed).

Known trade-off (owner-accepted, simplest rule): the class switches when the NEXT
reply starts playing. If that reply is a yes/no question and the candidate keeps
talking over it, the continuation runs at the static minimum again, not the open
one. Dropping back only after the yes/no line finished playing would need
playout-end tracking; deliberately not done here.

No hold, no carry, no yield: this module never delays or drops a reply.
Content-free logging: a class, a duration and a bounded phase identifier only.
"""

from __future__ import annotations

import math
import re
from typing import Any, Callable, Optional

ERROR_TYPE_PHASE = "phone_endpointing_phase"

OPEN = "open"
SHORT = "short"

#: Reply phases whose next answer is open-ended. Every other NAMED phase (name
#: confirm, callback, withdrawal/revocation confirm, opt-out, end, closing,
#: close_scheduled, drop_or_timeout, exception, teardown) is a short answer and
#: keeps the static minimum. A reply with NO phase (None) keeps the current
#: class (see `PhoneEndpointingPhase.reply_playing`). ``wind_down`` ("any
#: questions?") is deliberately OPEN: the candidate may ask a real question, and
#: a bare "no" costs at most the open minimum.
OPEN_PHASES = frozenset({
    "screening",
    "resume_conflict",
    "wind_down",
    "candidate_qna",
    "patience",
    "post_interrupt_ack",
})

# Open markers include the action verbs of a polite request ("Could you
# introduce yourself and summarize your current work?" is the production Q1),
# so "could/can you <action>" is not read as a yes/no question.
_OPEN_MARKERS_RE = re.compile(
    r"\b(what|how|why|which|where|when|who|tell me|walk me|describe|explain|"
    r"share|talk me|take me through|introduce|summari[sz]e|give|list|"
    r"elaborate|talk about|outline|run me through|brief|provide|detail|"
    r"discuss|go over|go through|walk through|walk us|take us through|expand|"
    r"break down|example|recall|highlight|mention|compare|speak about)\b"
)
# A yes/no clause starts the text, or a clause after a sentence/clause break
# (optionally led by and/or/so), with an auxiliary + a pronoun subject. So
# "Great. Do you have a laptop?" is a yes/no question.
_YES_NO_CLAUSE_RE = re.compile(
    r"(^|[.?!:,;]\s*(and|or|so)?\s*)"
    r"(are|is|do|does|did|have|has|can|could|would|will|were|was|should|may)"
    r"\s+(you|we|there|it|that|this|your|the|a|an|my|our|their)\b"
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


def _safe_phase(phase: Any) -> str:
    if isinstance(phase, str) and re.fullmatch(r"[a-zA-Z0-9_]{1,64}", phase):
        return phase
    return "unknown"


class PhoneEndpointingPhase:
    """Applies the per-question minimum endpointing delay. Never raises."""

    def __init__(
        self,
        *,
        active: Callable[[], bool],
        open_min_sec: Callable[[], float],
        short_min_sec: Callable[[], float],
        log: Optional[Callable[..., Any]] = None,
        apply_min: Optional[Callable[[float], Any]] = None,
    ) -> None:
        self._active = active
        self._open_min = open_min_sec
        self._short_min = short_min_sec
        self._log = log
        self._phase_apply = apply_min
        self._min_class = SHORT
        self._applied_min: Optional[float] = None
        self._pending: Optional[tuple[Any, Callable[[float], Any]]] = None

    def _is_active(self) -> bool:
        try:
            return bool(self._active())
        except Exception:  # noqa: BLE001
            return False

    def _emit(self, category: str, **extra: Any) -> None:
        if self._log is None:
            return
        try:
            self._log(
                "unknown_event", error_type=ERROR_TYPE_PHASE,
                error_category=category, **extra)
        except Exception:  # noqa: BLE001 — logging never breaks a call
            pass

    def set_phase_apply(self, apply_min: Optional[Callable[[float], Any]]) -> None:
        """The live minimum setter ``note_spoken_question`` uses (the first
        planned question is a ``say()`` line, so no ``speech_created`` carries
        one for it)."""
        self._phase_apply = apply_min

    def on_speech_created(
        self,
        *,
        source: Any,
        handle: Any,
        apply_min: Optional[Callable[[float], Any]],
    ) -> None:
        """Note that a generated reply was created; the minimum for its answer is
        applied when THAT reply plays (see ``reply_playing``). Generated replies
        only (``say`` lines keep the current class) and only while the screening
        phase is active. Nothing is applied here. Never raises."""
        try:
            if apply_min is None or source != "generate_reply":
                return
            if not self._is_active():
                return
            self._pending = (handle, apply_min)
        except Exception:  # noqa: BLE001
            pass

    def note_spoken_question(self, *, phase: Any, objective: Any) -> None:
        """A planned question was just SPOKEN through ``say()`` (the first one):
        apply the class of the answer it asks for now. Never raises."""
        try:
            apply_min = self._phase_apply
            if apply_min is None or not self._is_active():
                return
            self._apply_class(
                classify_answer_endpointing(phase, objective), phase, apply_min)
        except Exception:  # noqa: BLE001
            pass

    def reply_playing(
        self, *, playing_handle: Any = None, phase: Any = None, objective: Any = None,
    ) -> None:
        """A reply started PLAYING (``agent_state_changed`` -> ``speaking``):
        apply the minimum for the answer it asks for, read from the reply
        snapshot's ``phase`` / ``objective`` NOW (only when the class changes).

        ``playing_handle`` is the speech now playing. When it is known and is not
        the generated reply noted by ``on_speech_created`` (a ``say()`` line, a
        watchdog recovery line), the deferral is kept for that reply, or dropped
        when that reply has already finished without playing. A reply with no
        phase keeps the current class. Never raises."""
        try:
            pending = self._pending
            if pending is None:
                return
            handle, apply_min = pending
            if (
                handle is not None and playing_handle is not None
                and playing_handle is not handle
            ):
                if self._handle_done(handle):
                    self._pending = None
                return
            self._pending = None
            if not self._is_active():
                return
            if not isinstance(phase, str) or not phase.strip():
                return
            self._apply_class(
                classify_answer_endpointing(phase, objective), phase, apply_min)
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def _handle_done(handle: Any) -> bool:
        try:
            done = getattr(handle, "done", None)
            return bool(done()) if callable(done) else False
        except Exception:  # noqa: BLE001
            return False

    def _apply_class(
        self, wanted: str, phase: Any, apply_min: Callable[[float], Any],
    ) -> None:
        try:
            if wanted == self._min_class:
                return
            value = float(self._open_min() if wanted == OPEN else self._short_min())
            if not math.isfinite(value):
                raise ValueError("non-finite minimum")
            previous = (
                self._applied_min if self._applied_min is not None
                else float(self._short_min())
            )
            if value != previous:
                apply_min(value)
            self._min_class = wanted
            self._applied_min = value
            self._emit(wanted, duration_sec=round(value, 3), phase=_safe_phase(phase))
        except Exception:  # noqa: BLE001 — logged, never into the SDK handler
            self._emit("apply_failed", phase=_safe_phase(phase))
