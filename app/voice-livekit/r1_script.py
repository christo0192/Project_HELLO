"""R1 scripted lines (plan 5.2): the text the worker speaks without asking an LLM.

This is the reviewed, SHA-pinned replacement for the provisional line table that the
worker core ships (``r1_lines``).  The ids, texts and the ``{first_name}`` /
``{lead_name}`` / ``{lead_city}`` placeholders are the plan's; ``line`` has the same
call shape, so the follow-up integration swaps the import and nothing else.

Invariants:

* ``{first_name}`` is the candidate's sanitised first name and the ONLY candidate PII in
  any line (``known_first_name``: letters, space, hyphen, apostrophe, at most 24
  characters).  An empty name or the API's placeholder "there" is UNKNOWN: ``line`` then
  deletes the slot with its comma ("Thank you, {first_name}. We'll" -> "Thank you. We'll"),
  so the candidate never hears "Thank you, there.".  Lines without the slot are
  candidate-free, so they can be synthesised once per machine and cached by SHA and
  voice (plan 5.2).
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
    # No "hiring team" here: L-CLOSE carries the one mention of who reviews the interview, so a
    # candidate who asks for feedback hears it once, not twice a few seconds apart.
    "L-NO-FEEDBACK": "I'm sorry, I can't share any feedback on how it went.",
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
# The placeholder the API sends for a name it could not use (``r1.ts``: "there").
PLACEHOLDER_NAME = "there"
# The ``{first_name}`` slot with the comma that leads into it: ", {first_name}" or " {first_name}".
_NAME_SLOT = re.compile(r",? \{first_name\}")
_FORMATTER = string.Formatter()


def safe_first_name(value: object) -> str:
    """A short display-safe first name, or the neutral greeting "there"."""
    name = str(value or "").strip()
    return name if _NAME.fullmatch(name) else PLACEHOLDER_NAME


def known_first_name(value: object) -> str:
    """The candidate's display-safe first name, or "" when the name is UNKNOWN.

    Unknown is an empty value, a value ``safe_first_name`` rejects, the API's placeholder
    "there" (any case), and a name with fewer than two letters (an initial is not a name to
    greet someone by).  ``line`` renders an unknown name by dropping the slot, never by
    speaking "there" into it.
    """
    name = str(value or "").strip()
    if not _NAME.fullmatch(name) or name.lower() == PLACEHOLDER_NAME:
        return ""
    return name if sum(char.isalpha() for char in name) >= 2 else ""


# A spoken self-introduction: "my name is X" and "my name's X" anywhere, "myself X" as the opener of
# a sentence ("I taught myself Python" is not one) and "this is X" as the opener of the turn
# ("this is Salesforce" mid-answer is not one), each after an optional greeting.  The name must
# start with a capital letter as the speech-to-text wrote it ("my name is not on it" and "this is
# great" are not names) and is letters only.
_HELLO = r"hi|hello|hey|christy|good (?:morning|afternoon|evening)"
_FILLER = r"yeah|yes|yep|so|um|uh|well|okay|ok|sure|alright"
_NAME_TAIL = r"\s+([A-Z][A-Za-z]{1,23})(?![A-Za-z0-9'-])"
_SPOKEN_NAME = (
    re.compile(r"(?i:\bmy name(?: is|'s|\u2019s))" + _NAME_TAIL),
    re.compile(
        r"(?:^|[.!?]\s+)(?i:(?:(?:" + _HELLO + "|" + _FILLER + r")[\s,.!-]*)*myself)" + _NAME_TAIL
    ),
    re.compile(r"^(?i:(?:(?:" + _HELLO + r")[\s,.!-]*)*this is)" + _NAME_TAIL),
)
# Capitalised words that follow those openers without being a name.
_NOT_A_NAME = frozenset(
    {
        "a", "an", "the", "and", "but", "or", "so", "um", "uh", "from", "not", "very", "really",
        "basically", "currently", "working", "just", "also", "actually", "honestly", "quite",
        "pretty", "sort", "kind", "one", "first", "new", "good", "great", "nice", "fine", "okay",
        "interesting", "important", "awesome", "amazing", "yes", "no", "sir", "madam", "maam",
        "my", "our", "your", "his", "her", "it", "its", "in", "on", "at", "to", "for", "with",
        "what", "why", "how", "when", "who", "which", "where", "that", "this", "there", "here",
        "christy", "interviewer", "interview", "kickstart",
    }
)
SPOKEN_NAME_MIN_LETTERS = 2
SPOKEN_NAME_MAX_LETTERS = 24


def spoken_first_name(text: object) -> str:
    """The first name a candidate introduced themselves with in ``text``, or "".

    Narrow on purpose: a wrong name spoken back to the candidate is worse than none.  Only the
    forms in ``_SPOKEN_NAME`` count, the first match wins, and a word from ``_NOT_A_NAME`` is
    skipped.  The result is letters only, 2 to 24 of them, in capital-then-lower case.
    """
    raw = str(text or "")
    for pattern in _SPOKEN_NAME:
        for match in pattern.finditer(raw):
            word = match.group(1)
            if word.lower() in _NOT_A_NAME:
                continue
            if not SPOKEN_NAME_MIN_LETTERS <= len(word) <= SPOKEN_NAME_MAX_LETTERS:
                continue
            name = word[:1].upper() + word[1:].lower()
            if known_first_name(name):
                return name
    return ""


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

    An unknown first name (``known_first_name`` is "": empty, rejected, or the placeholder
    "there") is not spoken: the slot is deleted with its comma, so "Thank you, {first_name}.
    We'll" reads "Thank you. We'll" and "Are you still with me, {first_name}?" reads "Are you
    still with me?".

    Persona placeholders must be supplied (``**persona.line_values``); a missing one is a
    programming error and raises KeyError rather than speaking a literal ``{lead_name}``.
    """
    text = LINES[line_id]
    needed = placeholders(line_id)
    fields: dict[str, str] = {}
    if "first_name" in needed:
        first_name = known_first_name(values.get("first_name"))
        if first_name:
            fields["first_name"] = first_name
        else:
            text = _NAME_SLOT.sub("", text)
    for name in needed - {"first_name"}:
        fields[name] = str(values[name])
    return text.format(**fields)


def filler_line(voice: str) -> str:
    """The thinking filler for the interviewer or the learner voice."""
    return LINES["L-FILLER-LEARNER" if voice == "learner" else "L-FILLER-INTERVIEWER"]


def line_sha256(text: str) -> str:
    """Cache key for a synthesised line: the digest of its exact rendered text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
