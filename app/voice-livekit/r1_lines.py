"""R1 deterministic spoken content and safe candidate-name formatting.

The phase driver uses these stable IDs, not free-form closing text.  PR-4b will
replace this provisional content with the reviewed, SHA-pinned content package.
"""
from __future__ import annotations

import re

R1_CONTENT_VERSION = "r1-pr4a-unpinned"
INTERVIEWER_NAME = "Christy"

LINES = {
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
    "L-PICKUP": "Hello? Yes, this is Meera speaking.",
    "L-TRANSITION-NUDGE": "Whenever you're ready, just say ready.",
    "L-TIME-CUE": "Just so you know, I've only got a couple of minutes before my next call.",
    "L-EXIT": (
        "Let's pause the role-play here. I'm stepping out of the learner's role now; this "
        "is Christy, your interviewer, again. Thank you, that's the end of the role-play."
    ),
    "L-WRAP": "Before we finish, do you have any questions about the role or the next steps?",
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
    "L-SYSTEM-STOP": (
        "I'm sorry, {first_name}, we need to stop here because of a technical problem on "
        "our side. This won't count against you, and the hiring team will send you a new "
        "link. Goodbye."
    ),
    "L-FILLER": "Let me think about that for a second.",
    "L-FILLER-INTERVIEWER": "Let me think about that for a second.",
    "L-FILLER-LEARNER": "Hmm, one second...",
}

_NAME = re.compile(r"^[A-Za-z '-]{1,24}$")
# The ``{first_name}`` slot with the comma that leads into it (mirrors ``r1_script``).
_NAME_SLOT = re.compile(r",? \{first_name\}")


def safe_first_name(value: object) -> str:
    """Return a short display-safe first name or a neutral greeting fallback."""
    name = str(value or "").strip()
    return name if _NAME.fullmatch(name) else "there"


def known_first_name(value: object) -> str:
    """The display-safe first name, or "" when it is unknown (empty, rejected, or "there")."""
    name = str(value or "").strip()
    if not _NAME.fullmatch(name) or name.lower() == "there":
        return ""
    return name if sum(char.isalpha() for char in name) >= 2 else ""


def line(line_id: str, **values: object) -> str:
    """Render a reviewed line while sanitising the only candidate-derived field.

    An unknown first name is not spoken: the slot is deleted with its comma ("Thank you,
    {first_name}. We'll" -> "Thank you. We'll"), exactly as ``r1_script.line`` does.
    """
    text = LINES[line_id]
    first_name = known_first_name(values.get("first_name"))
    if not first_name:
        text = _NAME_SLOT.sub("", text)
    return text.format(
        first_name=first_name,
        lead_name=values.get("lead_name", "Meera"),
        lead_city=values.get("lead_city", "Bengaluru"),
    )
