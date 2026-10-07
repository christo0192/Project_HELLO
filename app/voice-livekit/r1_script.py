"""R1 scripted lines (plan 5.2): the text the worker speaks without asking an LLM.

This is the reviewed, SHA-pinned replacement for the provisional line table that the
worker core ships (``r1_lines``).  The ids, texts and the ``{first_name}`` /
``{lead_name}`` / ``{lead_city}`` placeholders are the plan's; ``line`` has the same
call shape, so the follow-up integration swaps the import and nothing else.

Invariants:

* ``{first_name}`` is the candidate's sanitised first name and the ONLY candidate PII in
  any line (``safe_first_name``: letters, space, hyphen, apostrophe, at most 24
  characters, else "there").  Lines without it are candidate-free, so they can be
  synthesised once per machine and cached by SHA and voice (plan 5.2).
* ``L-PICKUP`` and ``L-ASIDE-COACH`` are persona lines; their values come from the
  rendered persona (``RenderedPersona.line_values``), never from the candidate.
* The learner's objection lines, the commitment lines and the WEAK stall live with the
  scheduler and ``r1_commitment``; they are part of the same content pin
  (``r1_content``).
"""
from __future__ import annotations

import hashlib
import re
import string
from typing import Any

INTERVIEWER_NAME = "Christy"

LINES: dict[str, str] = {
    "L-OPEN": (
        "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart, and "
        "I'll be running your first-round interview for the Sales Program Advisor role. "
        "It takes about twenty minutes. We'll spend a few minutes getting to know you, "
        "then I'll switch into a short sales role-play where I play a prospective learner, "
        "and we'll finish with a couple of minutes for your questions. Let's start: could "
        "you walk me through your background, especially any sales or customer-facing work "
        "you've done?"
    ),
    "L-TRANSITION": (
        "Thank you, {first_name}. We'll now move to the role-play. I'll play a prospective "
        "learner so we can evaluate how you handle a real sales call. The learner is "
        "{lead_name} from {lead_city}, who filled in a form on our website about the Data "
        "Science course a few days ago. You're the Program Advisor calling her back. Your "
        "goal is to understand her needs and help her reach a decision, as you would on a "
        "real call, using the course details from your preparation guide. It will run for "
        "about twelve to fourteen minutes, and I'll stay in character until I say, 'Let's "
        "pause the role-play here.' When you're ready, just say 'ready' and she'll pick up."
    ),
    "L-TRANSITION-NUDGE": "Whenever you're ready, just say ready.",
    "L-PICKUP": "Hello? Yes, this is {lead_first_name} speaking.",
    "L-TIME-CUE": "Just so you know, I've only got a couple of minutes before my next call.",
    "L-EXIT": (
        "Let's pause the role-play here. I'm stepping out of the learner's role now; this "
        "is Christy, your interviewer, again. Thank you, that's the end of the role-play."
    ),
    "L-WRAP": "Before we finish, do you have any questions about the role or the next steps?",
    "L-NO-FEEDBACK": (
        "I'm not able to share how it went. The hiring team will review the full interview "
        "and get back to you."
    ),
    "L-FAQ-DEFER": "That's a good question for the hiring team; they'll follow up with you on it.",
    "L-CLOSE": (
        "Thank you for your time today, {first_name}. The hiring team will review your "
        "interview and get back to you. You can close this window now. Goodbye."
    ),
    "L-ASIDE-COACH": (
        "Quick note from Christy, your interviewer: in this role-play you're the Program "
        "Advisor and I'm the learner, {lead_name}. She enquired about the Data Science "
        "course and you're calling her back. Please carry on as you would on a real call."
    ),
    "L-MUTE": (
        "This is Christy. It looks like your microphone may be muted. Please unmute when "
        "you're ready."
    ),
    "L-SIL-IB": "Are you still with me, {first_name}?",
    "L-SIL-RP1": "Hello? Are you still there?",
    "L-SIL-RP2": (
        "This is Christy, your interviewer. It sounds like we may have lost you. I'll wait "
        "a few more seconds."
    ),
    "L-SIL-END": (
        "I'm going to end the interview here as we seem to have lost the connection. The "
        "hiring team will be in touch. Goodbye."
    ),
    "L-REJOIN": "Welcome back, {first_name}. Let's pick up where we left off.",
    "L-REJOIN-RP": "The learner is back on the line.",
    "L-SYSTEM-STOP": (
        "I'm sorry, {first_name}, we need to stop here because of a technical problem on "
        "our side. This won't count against you, and the hiring team will send you a new "
        "link. Goodbye."
    ),
    "L-FILLER": "Let me think about that for a second.",
    "L-FILLER-INTERVIEWER": "Let me think about that for a second.",
    "L-FILLER-LEARNER": "Hmm, one second...",
}

# The exit line's first sentence is the cue the LLM must never imitate (``r1_guard``).
EXIT_CUE = "Let's pause the role-play here."
_NAME = re.compile(r"^[A-Za-z '-]{1,24}$")
_FORMATTER = string.Formatter()


def safe_first_name(value: object) -> str:
    """A short display-safe first name, or the neutral greeting "there"."""
    name = str(value or "").strip()
    return name if _NAME.fullmatch(name) else "there"


def placeholders(line_id: str) -> frozenset[str]:
    """The placeholder names a line uses."""
    return frozenset(
        field for _, field, _, _ in _FORMATTER.parse(LINES[line_id]) if field
    )


def is_candidate_free(line_id: str) -> bool:
    """True when the line carries no candidate PII, so it may be cached across sessions."""
    return "first_name" not in placeholders(line_id)


NAME_FREE_LINES = tuple(line_id for line_id in LINES if not placeholders(line_id))
CANDIDATE_FREE_LINES = tuple(line_id for line_id in LINES if is_candidate_free(line_id))


def line(line_id: str, **values: Any) -> str:
    """Render a reviewed line.  ``first_name`` is sanitised; unknown ids raise KeyError.

    Persona placeholders must be supplied (``**persona.line_values``); a missing one is a
    programming error and raises KeyError rather than speaking a literal ``{lead_name}``.
    """
    text = LINES[line_id]
    needed = placeholders(line_id)
    fields: dict[str, str] = {}
    if "first_name" in needed:
        fields["first_name"] = safe_first_name(values.get("first_name"))
    for name in needed - {"first_name"}:
        fields[name] = str(values[name])
    return text.format(**fields)


def filler_line(voice: str) -> str:
    """The thinking filler for the interviewer or the learner voice."""
    return LINES["L-FILLER-LEARNER" if voice == "learner" else "L-FILLER-INTERVIEWER"]


def line_sha256(text: str) -> str:
    """Cache key for a synthesised line: the digest of its exact rendered text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
