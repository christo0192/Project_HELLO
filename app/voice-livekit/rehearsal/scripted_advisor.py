"""Offline stand-in for the advisor simulator: five scripted behaviours with intent tags.

``ScriptedAdvisor`` follows the same protocol as ``advisor.LLMAdvisor`` (``start``,
``next_turn``) and tags every turn with the same ``intent`` / ``topic`` ground truth, so the
metrics, the offline sweep and the regression test run without a network.  It reacts to what
the learner just said with its own small keyword rules (never the engine's detectors): an
objection it recognises is answered according to the level, discovery questions are asked in
a fixed order, the close is asked around 9:30 (strong) or vaguely and late (average), and so
on.  The probes use phrasings the engine's genuine-probe detector accepts, which
``tests/test_r1_rehearsal_harness.py`` pins, so the hint and deep layers are exercised.

Only course facts from the deck are stated, except by the ``pushy`` level, whose job is to
offer what the deck does not allow (the learner must not accept it).
"""
from __future__ import annotations

import random
import re
from typing import Callable

from rehearsal.advisor import ADVISOR_LEVELS, AdvisorTurn

ADVISOR_NAME = "Alex"
DM_WORD = re.compile(r"\b(husband|wife|father|mother|partner|parents|family)\b", re.IGNORECASE)

# ---------------------------------------------------------------- strong / average banks
GREET = (
    "Hi {name}, this is Alex from Interview Kickstart. Thanks for picking up. I saw you filled "
    "in a form about our Data Science course, so I wanted to hear what you are looking for. "
    "Is now still a good time for a few minutes?",
)
PROBES = {
    "H1": (
        "What made you start looking at data science right now?",
        "What's been behind your interest in a course like this at this point?",
    ),
    "H2": (
        "Have you tried learning this on your own before? What got in the way?",
        "What have you tried so far, and what didn't work out?",
    ),
    "H3": (
        "How many hours a week could you realistically give this, and who else would be part "
        "of the decision?",
        "What does your week look like, and is anyone else involved in the decision?",
    ),
}
FOLLOWUPS = {
    "H1": ("Tell me more about that. What has been going on?", "Can you tell me more about that?"),
    "H2": (
        "Could you walk me through that a bit more?",
        "Can you tell me more about what happened there?",
    ),
    "H3": (
        "Could you elaborate on that a little?",
        "Can you tell me more about how that would work at home?",
    ),
}
PITCH = (
    "Thanks, that helps me. Here is how we could help. The Data Science course runs six "
    "months and covers Python, SQL, machine learning, deep learning and a capstone project, "
    "with personalised mentorship and intensive mock interviews. Our instructors come from "
    "companies like Google and Amazon.",
    "To give you a picture: the curriculum is designed by industry leaders, you work on "
    "real-world projects, and there is career support through the whole six months, from "
    "your resume to mock interviews.",
)
VALUE = (
    "A lot of our alumni say the mock interviews and the career support are what made them "
    "confident, and the mentorship keeps you on track.",
    "The projects are real-world ones, so by the end you have work you can actually show to "
    "employers.",
    "The course is built for working professionals and career switchers, so you will not be "
    "the only one balancing it with a job.",
    "Mentors review your work along the way, so you are never stuck on your own for long.",
    "And the capstone project pulls everything together, which is usually where people feel "
    "the biggest jump.",
)
CHECKIN = (
    "How does that sound so far?",
    "Does that match what you were hoping for?",
    "Is there anything you would like me to go deeper on?",
)
ANSWER_STRONG = {
    "F3": (
        "That is a fair point, there is a lot of free content out there. What you do not get "
        "from it is structure, personalised mentorship and mock interviews, which is what "
        "most people say they miss. Does that distinction make sense for you?",
        "I would not argue with that, free material is a good start. The difference is the "
        "guidance and the accountability around it. Does that sound useful to you?",
    ),
    "F3b": (
        "Nobody can guarantee a job, and I will not promise you one. What we do is career "
        "support and intensive mock interviews to get you interview-ready. Does that address "
        "your concern?",
        "That worry is common right now. We cannot guarantee outcomes, but the career support "
        "and mock interviews are designed for exactly this market. Does that help?",
    ),
    "F2": (
        "I understand, six months is a real commitment. The classes are flexible, and if you "
        "miss a session you can catch up with a recording or in a later batch. Does that "
        "sound manageable next to your schedule?",
        "That is a fair concern. Many people join while working full time, and the flexible "
        "learning options are there for that. Would that work for you?",
    ),
    "F2b": (
        "If you fall behind, you can request the recording of that session or sit in on "
        "another batch, and your mentor helps you catch up. Does that answer it?",
    ),
    "F1": (
        "I hear you on the price. The listed price is $9,000, and I cannot match $7,000, but "
        "there are discounts of $500, $1,000 or $1,500 depending on the payment plan. Can I "
        "first make sure the value is clear to you?",
    ),
    "F1b": (
        "I understand it is a lot. On the plan that fits you best I can take $500 off, which "
        "brings it to $8,500. Does that make it easier for you?",
        "I am not able to go lower than that, honestly, but the payment plan spreads it out. "
        "Would that help?",
        "Between the discount and the payment plan, that is the best I can offer. Does that "
        "work for you?",
    ),
    "F4": (
        "Of course, it is a big decision and I do not want to rush you. What is the main "
        "thing you would like to be sure about before you decide?",
        "That is completely fine. What would help you feel ready to decide?",
    ),
    "F4dm": (
        "That makes sense. Would it help to set up a call with your {dm} so I can answer "
        "their questions too? How about Thursday at 7 PM?",
        "Of course, it is a decision for both of you. Shall we find a time for a call with "
        "your {dm}, maybe Friday evening?",
    ),
    "cue": (
        "No problem, I will keep this short. The next cohort is coming up and seats are "
        "limited, so let us agree on a next step.",
    ),
}
ANSWER_AVERAGE = {
    "F3": (
        "Free videos are fine, but our course is much more complete, with mentors and "
        "projects and career support.",
    ),
    "F3b": ("Our alumni do well, and we have a strong career support team.",),
    "F2": ("It is flexible, so you can fit it around work. Many people do.",),
    "F2b": ("You can watch the recordings, so that is not a problem.",),
    "F1": (
        "The price is $9,000, but I can give you $1,000 off if you decide soon, so it comes "
        "to $8,000.",
    ),
    "F1b": ("I could do $1,500 off at the most, which is $7,500. That is a really good deal.",),
    "F4": ("Sure, take your time, but seats do fill up.",),
    "F4dm": ("Okay, you can talk to your {dm} and let me know.",),
    "cue": ("Okay, I will be quick then.",),
}
URGENCY = (
    "One thing to keep in mind: cohorts have limited seats, so the earlier you decide the "
    "better your chances of getting a place.",
)
CLOSE_STRONG = (
    "It sounds like this fits what you are looking for. Would you like to go ahead and enrol "
    "today, or should we set up a call with your {dm} this week?",
    "Given everything we have covered, what would you like the next step to be? I can send "
    "you the enrolment link, or we can book a call with your {dm}.",
)
CLOSE_AVERAGE = ("So, what do you think? Should we get you started?",)
ACCEPT_CALLBACK = (
    "Perfect, that works for me. I will send you a calendar invite. Looking forward to "
    "speaking with you both.",
)
ACCEPT_ENROL = (
    "That is great to hear, {name}. I will send the enrolment details over to you right "
    "after this call.",
)
ACCEPT_WEAK = ("No problem at all, {name}. I will email you the details today.",)
NEXT_STEPS = (
    "I will send everything over today, and you are welcome to reach out if any question "
    "comes up before then.",
    "Is there anything else you would like to ask me before we wrap up?",
    "Great, so that is settled. Anything else on your mind while we are on the call?",
)
FAREWELL = (
    "Wonderful, thank you for your time today, {name}. Take care, bye!",
    "Great, thanks for the conversation, {name}. Have a good day, bye!",
)
POST_COMMIT_TURNS = 3
CLOSE_CALL_SEC = 840
# ----------------------------------------------------------------------------- weak / pushy
WEAK_PITCHES = (
    "Hello {name}, so our Data Science course is the best you will find, six months long, "
    "with Python, SQL, machine learning, deep learning, big data, data visualization and a "
    "capstone project, and our instructors come from Google, Facebook, Amazon and Netflix, "
    "and you get personalised mentorship and real-world projects and intensive mock "
    "interviews and comprehensive career support, and the price is $9,000.",
    "Also we have flexible learning options and a proven track record of alumni success, the "
    "curriculum is designed by industry leaders and covers everything in depth, from math "
    "for data science to classical machine learning to advanced machine learning and deep "
    "learning, and it all ends with a capstone project that you can show to employers.",
    "As I was saying, the course suits recent graduates, current data professionals, career "
    "switchers, research scholars and tech enthusiasts, so whoever you are it is right for "
    "you, and the careers include data scientist, machine learning engineer, data analyst "
    "and business intelligence analyst.",
    "To repeat, you will get everything you need: personalised mentorship, real-world "
    "projects, intensive mock interviews and comprehensive career support, which is why this "
    "is the course to choose, and the price is $9,000 for all of it.",
)
WEAK_DISCOUNT = ("Okay, fine, I will give you the maximum $1,500 off, so $7,500.",)
PUSHY_LINES = (
    "Hi {name}, quick call! The course is $9,000 but today only I can do $2,000 off, so "
    "$7,000, and that offer ends tonight!",
    "Only three seats are left, so I need your decision now. I can make it 30 percent off if "
    "you say yes today.",
    "Shall I send the enrolment link right now? The discount disappears at midnight.",
    "Okay, final offer, $2,500 off, but you have to decide on this call.",
    "I am doing this just for you. Say yes now and I will lock the lower price.",
    "The price goes back to normal tomorrow, so let us finish this now.",
)
PUSHY_INTENTS = ("price", "urgency", "close_ask", "discount", "close_ask", "urgency")
TERSE_LINES = ("Hi.", "Okay.", "Sure.", "Right.", "Go on.", "Hmm, yes.", "I see.", "Mm.", "Okay, tell me.")
TERSE_PROBE = "Why are you interested?"
TERSE_CALLBACK = "Maybe a call tomorrow?"


class ScriptedAdvisor:
    """A deterministic advisor of one level; the learner's last line steers its answers."""

    def __init__(self, level: str, seed: str) -> None:
        if level not in ADVISOR_LEVELS:
            raise ValueError(f"unknown advisor level {level!r}")
        self.level = level
        self._rng = random.Random(f"scripted-advisor:{seed}")
        self.name = "there"
        self.dm = "family"
        self._counts: dict[str, int] = {}
        self._answered: dict[str, int] = {}
        self._discovery = 0
        self._pitched = 0
        self._close_asked = 0
        self._urgency_done = False
        self._farewell_done = False
        self._post_commit: str | None = None
        self._post_turns = 0
        self._turn = 0

    # ----------------------------------------------------------------- protocol
    async def start(self, learner_pickup: str) -> None:
        match = re.search(r"this is (\w+)", learner_pickup, re.IGNORECASE)
        if match:
            self.name = match.group(1)

    async def next_turn(self, learner_text: str | None, r_sec: float, exchange: int) -> AdvisorTurn:
        self._turn += 1
        text = learner_text or ""
        found = DM_WORD.search(text)
        if found:
            self.dm = found.group(1).lower()
        decide: Callable[[str, float], AdvisorTurn] = {
            "strong": self._strong,
            "average": self._average,
            "weak": self._weak,
            "pushy": self._pushy,
            "terse": self._terse,
        }[self.level]
        turn = decide(text, r_sec)
        turn.text = turn.text.format(name=self.name, dm=self.dm)
        return turn

    # ------------------------------------------------------------------ helpers
    def _take(self, key: str, bank: tuple[str, ...]) -> str:
        count = self._counts.get(key, 0)
        self._counts[key] = count + 1
        return bank[count % len(bank)]

    @staticmethod
    def _committed(text: str) -> str | None:
        lowered = text.lower()
        if re.search(r"book a call [^.?!]*so we can decide", lowered):
            return "call"
        if re.search(r"enrol+ment link|pay the deposit", lowered):
            return "enrol"
        if re.search(r"let me think about it\. just email me the details", lowered):
            return "weak"
        return None

    @staticmethod
    def _raised(text: str) -> list[str]:
        """The objection keys recognised in the learner's last line (own keyword rules)."""
        t = text.lower()
        found: list[str] = []
        if re.search(r"\b(free|youtube|coursera|udemy)\b", t) and re.search(
            r"\b(pay|paying|paid|worth|money|cost|spend)\b", t
        ):
            found.append("F3")
        if re.search(r"\blay ?offs?\b", t) or re.search(r"\b(?:land|get) a job\b|\bgets? jobs?\b", t):
            found.append("F3b")
        if re.search(r"\b(schedule|packed|busy|keep up|keeping up)\b", t) and "behind" not in t:
            found.append("F2")
        if re.search(r"\bfall behind\b|\bmiss(?:ed)? (?:a few |some |the )?(?:classes|weeks|sessions)\b", t):
            found.append("F2b")
        if re.search(r"7,?000", t):
            found.append("F1")
        elif re.search(
            r"\b(?:little better|go a little lower|lower than that|more room|final price|"
            r"best price|nothing at all|payment plan|any flexibility|best you can|still a "
            r"stretch|still a lot)\b",
            t,
        ):
            found.append("F1b")
        if re.search(r"\b(?:not ready|next cohort|next batch|decide today|rush)\b", t):
            found.append("F4")
        if DM_WORD.search(t) and re.search(r"\b(?:talk|run|check|discuss|ask)\w*\b", t):
            found.append("F4dm")
        if re.search(r"\b(?:couple of|few) minutes\b|\banother call\b|\bnext call\b", t):
            found.append("cue")
        return found

    def _after_commit(self, text: str, r_sec: float) -> AdvisorTurn | None:
        """Answer the learner's commitment, keep the call going until 14:00, then say goodbye.

        A real advisor does not hang up on "send me the link": there are next steps to cover.
        The call is also what lets the role-play reach the 10-minute floor of the gate.
        """
        if self._post_commit is None:
            committed = self._committed(text)
            if committed is None:
                return None
            self._post_commit = committed
            if committed == "call":
                return AdvisorTurn(self._take("accept", ACCEPT_CALLBACK), "accept_callback", "")
            bank = ACCEPT_ENROL if committed == "enrol" else ACCEPT_WEAK
            return AdvisorTurn(self._take("accept", bank), "other", "")
        self._post_turns += 1
        if r_sec >= CLOSE_CALL_SEC or self._post_turns > POST_COMMIT_TURNS:
            self._farewell_done = True
            return AdvisorTurn(self._take("farewell", FAREWELL), "farewell", "")
        return AdvisorTurn(self._take("next", NEXT_STEPS), "other", "")

    def _turn_for(
        self, bank: dict[str, tuple[str, ...]], key: str, intent: str, topic: str
    ) -> AdvisorTurn:
        text = self._take(f"answer:{key}", bank[key])
        return AdvisorTurn(text, intent, topic)

    _OBJECTION_INTENT = {
        "F3": ("answer_objection", "F3"),
        "F3b": ("answer_objection", "F3"),
        "F2": ("answer_objection", "F2"),
        "F2b": ("answer_objection", "F2"),
        "F1": ("price", "F1"),
        "F1b": ("discount", "F1"),
        "F4": ("answer_objection", "F4"),
        "F4dm": ("callback", "F4"),
        "cue": ("urgency", ""),
    }

    def _answer_objection(self, text: str, bank: dict[str, tuple[str, ...]]) -> AdvisorTurn | None:
        for key in self._raised(text):
            if self._answered.get(key, 0) >= 2 or key not in bank:
                continue
            self._answered[key] = self._answered.get(key, 0) + 1
            intent, topic = self._OBJECTION_INTENT[key]
            return self._turn_for(bank, key, intent, topic)
        return None

    # ------------------------------------------------------------------- strong
    _DISCOVERY = (("probe", "H1"), ("followup", "H1"), ("probe", "H2"), ("followup", "H2"),
                  ("probe", "H3"), ("followup", "H3"))

    def _strong(self, text: str, r_sec: float) -> AdvisorTurn:
        if self._turn == 1:
            return AdvisorTurn(self._take("greet", GREET), "greet", "")
        after = self._after_commit(text, r_sec)
        if after is not None:
            return after
        if self._farewell_done:
            return AdvisorTurn(self._take("farewell", FAREWELL), "farewell", "")
        answer = self._answer_objection(text, ANSWER_STRONG)
        if answer is not None:
            return answer
        if self._discovery < len(self._DISCOVERY):
            kind, topic = self._DISCOVERY[self._discovery]
            self._discovery += 1
            bank = PROBES if kind == "probe" else FOLLOWUPS
            return AdvisorTurn(self._take(f"{kind}:{topic}", bank[topic]), kind, topic)
        if self._pitched < len(PITCH):
            self._pitched += 1
            return AdvisorTurn(self._take("pitch", PITCH), "pitch", "")
        asked_f4 = self._answered.get("F4", 0) + self._answered.get("F4dm", 0) > 0
        if r_sec >= 780 and (asked_f4 or r_sec >= 1020) and self._close_asked < 3:
            self._close_asked += 1
            return AdvisorTurn(self._take("close", CLOSE_STRONG), "close_ask", "")
        if r_sec >= 600 and not self._urgency_done:
            self._urgency_done = True
            return AdvisorTurn(self._take("urgency", URGENCY), "urgency", "")
        if self._turn % 4 == 0:
            return AdvisorTurn(self._take("checkin", CHECKIN), "other", "")
        return AdvisorTurn(self._take("value", VALUE), "pitch", "")

    # ------------------------------------------------------------------ average
    def _average(self, text: str, r_sec: float) -> AdvisorTurn:
        if self._turn == 1:
            return AdvisorTurn(self._take("greet", GREET), "greet", "")
        after = self._after_commit(text, r_sec)
        if after is not None:
            return after
        if self._farewell_done:
            return AdvisorTurn(self._take("farewell", FAREWELL), "farewell", "")
        answer = self._answer_objection(text, ANSWER_AVERAGE)
        if answer is not None:
            return answer
        if self._discovery < 2:
            kind, topic = (("probe", "H1"), ("probe", "H2"))[self._discovery]
            self._discovery += 1
            return AdvisorTurn(self._take(f"{kind}:{topic}", PROBES[topic]), kind, topic)
        if self._pitched < len(PITCH):
            self._pitched += 1
            return AdvisorTurn(self._take("pitch", PITCH), "pitch", "")
        if r_sec >= 1060 and self._close_asked < 2:
            self._close_asked += 1
            return AdvisorTurn(self._take("close", CLOSE_AVERAGE), "close_ask", "")
        return AdvisorTurn(self._take("value", VALUE), "pitch", "")

    # --------------------------------------------------------------------- weak
    def _weak(self, text: str, r_sec: float) -> AdvisorTurn:
        raised = self._raised(text)
        if "F1" in raised or "F1b" in raised:
            if self._answered.get("weakdiscount", 0) == 0:
                self._answered["weakdiscount"] = 1
                return AdvisorTurn(self._take("wd", WEAK_DISCOUNT), "discount", "F1")
        return AdvisorTurn(self._take("pitch", WEAK_PITCHES), "pitch", "")

    # -------------------------------------------------------------------- pushy
    def _pushy(self, text: str, r_sec: float) -> AdvisorTurn:
        index = (self._turn - 1) % len(PUSHY_LINES)
        intent = PUSHY_INTENTS[index]
        return AdvisorTurn(
            PUSHY_LINES[index], intent, "F1" if intent in ("price", "discount") else ""
        )

    # -------------------------------------------------------------------- terse
    def _terse(self, text: str, r_sec: float) -> AdvisorTurn:
        if self._turn == 3:
            return AdvisorTurn(TERSE_PROBE, "probe", "H1")
        if self._turn == 12:
            return AdvisorTurn(TERSE_CALLBACK, "callback", "F4")
        return AdvisorTurn(self._take("terse", TERSE_LINES), "other", "")
