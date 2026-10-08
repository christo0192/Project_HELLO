"""R1 output guard: per-sentence screening of every LLM sentence before it is spoken.

Plan 5.3.  The guard runs in EVERY phase, before the transcription/TTS tee, so captions,
stored transcript turns and scorer input are filtered as well as speech.  It never calls
the LLM and never changes a phase: it can only keep, replace or drop a sentence.

What it blocks (each category logs as ``r1_guard_<category>``):

``control`` / ``vendor`` / ``evaluation``
    Prompt and scoring vocabulary (CONTROL, OWED, H1-H3, F1-F4, "rubric", "system prompt",
    "as an AI", "language model"), model or vendor names, and scoring words.  In the
    opening and the icebreaker only a genuine leak counts (rubric, scorecard, threshold,
    "you are being scored", "your score"): "metrics", "rated" and "scores" are everyday
    words when the candidate describes a sales background.
``meta``
    Learner only: AI identity, "role-play", "this test", "persona", "instructions",
    "Christy".
``persona_secret``
    Interviewer phases after the persona is revealed: persona names (except the
    candidate's own first name), "$7,000", "objection", "hidden need" and the active
    persona's deep-need markers.
``volunteered_need``
    Learner only: a deep need whose topic has not been released by a probe and a
    follow-up.  The replacement is the topic's surface answer.
``commitment`` / ``concession``
    Learner only: any call, day, time, enrolment or payment acceptance above the WEAK
    stall, or resolution phrasing ("you've convinced me"); doubt such as "I'm not convinced
    yet" is not a concession.  Commitments are scripted and spoken by the worker, never by
    the LLM (S0-B: a dated call was accepted).
``invented_fact``
    Learner only: product, format, schedule, hours, outcome or amount claims that are not
    on the public card.  Interviewer: salary or work-mode claims, next-step timelines
    and role facts beyond the deck's shift timings, replaced by the deferral line.
``feedback`` / ``hiring_comp``
    Interviewer: feedback phrasing in wrap-up (replaced by L-NO-FEEDBACK, and the reply ends
    there: nothing the model says after the refusal is spoken), and hiring or
    compensation statements.  Outcomes and pay figures are always blocked; incentives,
    work mode and timelines only when the sentence is about THIS role, the future or an
    offer, so the candidate's own history ("you earned strong incentives", "you relocated
    for that role") can be repeated back.
``contact``
    Every phase: e-mail addresses (written or spoken), phone numbers, URLs and handles.
    S0-B found invented addresses in 24% of conversations.
``protected_question``
    Interviewer: questions about the CANDIDATE's age, marital status, children, religion,
    caste or health ("how old are you", "do you have kids"); the bare words are sales
    vocabulary ("convince parents to enrol their children", "sold health insurance").
``scripted_cue``
    The scripted exit line imitated by the LLM; and, in the opening and the icebreaker, the
    LLM announcing the role-play itself ("Now let's move into the role-play...").  The
    driver alone starts the role-play (the scripted transition line), so an improvised start
    would be a second one.
``ack_format``
    Hygiene, not a leak: an acknowledgement sentence with a question, a digit or a product
    word that is not a card answer or a paraphrase of one.  The sentence is dropped, but
    the hit does not count toward the 3-hit gate (``LEAK_CATEGORIES``).

The ``control`` category also covers an INSTRUCTION ECHO: six consecutive words copied
from the private prompt prose (``GuardContext.control_texts``; the phone lane's
``phone_instruction_echo_detected``, copied rather than imported).

Plan section 9 forbids logging utterances, so a ``Hit`` carries the category, the rule and
a 12-character digest, and no text unless the caller opts in (``keep_excerpts``).

False positives matter as much as leaks: "time commitment" and "Interview Kickstart" are
fine (S0-B defect 7), and the candidate's own first name is never a persona leak.
"""
from __future__ import annotations

import functools
import hashlib
import re
from dataclasses import dataclass, field
from typing import Iterable

from r1_commitment import Level, classify_learner_commitment
from r1_personas import (
    ALL_PERSONA_NAMES,
    H_TOPICS,
    PERSONAS,
    PUBLIC_ANSWERS,
    RenderedPersona,
)
from r1_script import EXIT_CUE, LINES
from r1_text import (
    dollar_amounts,
    fold,
    fuzzy_contains,
    has_contact_detail,
    is_question_like,
    mask_contact,
    negated_before,
    normalize,
    split_sentences,
    truncate_words,
    word_count,
)
from r1_world import INTERVIEWER_DEFLECTION, LEARNER_DEFLECTION

FALLBACK_REPLY = "Sorry, what were you saying?"
NO_FEEDBACK_LINE = LINES["L-NO-FEEDBACK"]
CONTACT_REPLACEMENT = "You can use the email on my form."
NEUTRAL_ACKS = ("Okay.", "I see.", "Right.", "Mm-hmm.")
REPLY_WORD_CAP = 45
ACK_WORD_CAP = 15
HIT_FLAG_THRESHOLD = 3

LEARNER_PHASE = "roleplay"
FEEDBACK_PHASES = frozenset({"roleplay_exit", "wrapup", "closing"})
PERSONA_REVEALED_PHASES = frozenset({"transition", "roleplay_exit", "wrapup", "closing"})

CONTROL = "control"
VENDOR = "vendor"
EVALUATION = "evaluation"
META = "meta"
PERSONA_SECRET = "persona_secret"
VOLUNTEERED_NEED = "volunteered_need"
COMMITMENT = "commitment"
CONCESSION = "concession"
INVENTED_FACT = "invented_fact"
FEEDBACK = "feedback"
HIRING_COMP = "hiring_comp"
CONTACT = "contact"
PROTECTED_QUESTION = "protected_question"
SCRIPTED_CUE = "scripted_cue"
ACK_FORMAT = "ack_format"
CATEGORIES = (
    CONTROL,
    VENDOR,
    EVALUATION,
    META,
    PERSONA_SECRET,
    VOLUNTEERED_NEED,
    COMMITMENT,
    CONCESSION,
    INVENTED_FACT,
    FEEDBACK,
    HIRING_COMP,
    CONTACT,
    PROTECTED_QUESTION,
    SCRIPTED_CUE,
    ACK_FORMAT,
)
# Categories that count toward the 3-hit gate: everything except acknowledgement hygiene.
LEAK_CATEGORIES = frozenset(CATEGORIES) - {ACK_FORMAT}


def _ci(*patterns: str) -> re.Pattern[str]:
    return re.compile("|".join(patterns), re.IGNORECASE)


# Control tokens appear in prompts in upper case, so they are matched case-sensitively;
# "owed", "reminder" and "h1" in ordinary lower-case speech are not leaks.
_CONTROL_TOKEN = re.compile(
    r"\b(?:CONTROL|OWED|ROLEPLAY|CANDIDATE_MONOLOGUE|R_CLOCK\w*|MODE=\w*)\b|\b[HF][1-4]\b"
    r"|\bPHASE\s*[=:]"
)
_CONTROL_PHRASE = _ci(
    r"\brubric\b",
    r"\bsystem (?:prompt|message|note)\b",
    r"\bas an ai\b",
    r"\blanguage model\b",
    r"\bowed move\b",
    r"\bhidden needs?\b",
)
_VENDOR = _ci(r"\b(?:deepseek|chatgpt|openai|gemini|claude|anthropic|gpt-?\d*|sarvam|livekit)\b")
_EVALUATION = _ci(
    r"\b(?:rubric|scorecard|scoring|scored|scores?|grading|graded|rated|ratings?|metrics?|"
    r"thresholds?|calibrat\w+|auto-?reject\w*|automated decisions?)\b"
)
# In the opening and the icebreaker the interviewer talks about the candidate's sales
# background, where "metrics", "rated" and "scores" are everyday words ("What metrics did
# you own?", "How were you rated against your targets?").  There only a genuine leak of
# THIS evaluation counts: jargon, or a statement that the candidate is being scored.
SMALL_TALK_PHASES = frozenset({"opening", "icebreaker"})
_EVALUATION_LEAK = _ci(
    r"\b(?:rubric|scorecard|thresholds?|calibrat\w+|auto-?reject\w*|automated decisions?)\b",
    r"\bscor(?:ed|es|ing)? (?:you|your (?:answers?|responses?|call|performance|interview)|"
    r"this (?:call|interview|conversation)|the (?:call|interview|conversation))\b",
    r"\bgrad(?:e|es|ed|ing) (?:you|your|this|the (?:call|interview|conversation)|on|against)\b",
    r"\b(?:is|are|will be|being|be|get|gets) (?:scored|graded)\b",
    r"\byour (?:score|scores|grade|marks)\b",
)
_LEARNER_META = _ci(
    r"\b(?:i am|i'?m|am i|you are|you'?re|are you) (?:an? )?(?:ai|a\.i\.|bot|chatbot|robot|"
    r"language model|artificial)\b",
    r"\bartificial intelligence (?:model|assistant)\b|\bai (?:assistant|model|agent)\b",
    r"\bsimulat\w+\b|\brole-?play(?:ing)?\b|\bthis test\b|\bthe test\b|\btest (?:call|scenario)\b",
    r"\bpersona\b|\bprompts?\b|\bmy instructions\b|\binstructions? (?:say|tell|state)\b",
    r"\bchristy\b",
)
_INTERVIEWER_SECRET = _ci(r"\$\s?7,?000\b", r"\bobjections?\b", r"\bhidden needs?\b")
_FEEDBACK = _ci(
    r"\byou did (?:well|great|good|fine|poorly|badly)\b",
    r"\b(?:well|good|great|nice|excellent) (?:done|job|work)\b",
    r"\byour (?:score|performance|rating|result)s?\b",
    r"\byou (?:scored|handled|missed|passed|failed|cleared)\b",
    r"\byou were (?:good|great|strong|weak|excellent|impressive)\b",
    r"\b(?:strong|weak|good|great) candidate\b|\bareas? (?:to|for|of) improv\w+\b",
    r"\bfeedback\b|\byou (?:should|could) have\b|\bimpressed\b",
    r"\b(?:not|n't) (?:a )?(?:good )?fit\b",
)
# An outcome, or a pay figure, is never the interviewer's to state.
_HIRING_ALWAYS = _ci(
    r"\byou(?:'re| are) (?:hired|selected|shortlisted|through|moving forward)\b",
    r"\b(?:the )?job is yours\b|\boffer letter\b|\bcongratulations\b",
    r"\b(?:we|i)(?:'ll| will) (?:make you an offer|hire you|move you forward|call you for)\b",
    r"\byou(?:'ll| will) (?:get|receive) (?:the )?(?:job|offer)\b",
    r"\bsalar(?:y|ies)\b|\bctc\b|\blpa\b|\blakhs?\b|\bstipend\b|\bcompensation\b",
    r"\b(?:competitive|compensation|salary|benefits?|pay|attractive|good|great) package\b",
    r"\bpay ?(?:scale|range|band|grade)\b|\bvariable pay\b|\bper annum\b",
)
# Incentives, work mode and next-step timelines are only a leak when the interviewer
# states them about THIS role, the future or an offer.  The same words are the candidate's
# own history in the icebreaker ("so you hit your targets and earned strong incentives",
# "you relocated for that role", "you ramped up within a few weeks"), which must pass.
_HIRING_ROLE_TERMS = _ci(
    r"\bincentives?\b|\bcommissions?\b|\bbonus(?:es)?\b|\bannual(?:ly)?\b",
    r"\b(?:remote|hybrid|work from home|wfh|on-?site|in-?office|office-based|relocat\w+)\b",
    r"\b(?:within|in|after|by) (?:the next |about |around )?(?:\d+|one|two|three|four|five|"
    r"a few|few|several) (?:business |working )?(?:days?|weeks?)\b",
    r"\bby (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|"
    r"end of (?:the )?(?:day|week|month))\b|\bnext week\b|\bthis week\b",
)
_ABOUT_THE_ROLE_OR_FUTURE = _ci(
    r"\b(?:we|our|ours|us|we'?re|we'?ve)\b",
    r"\bi(?:'ll| will)\b|\byou(?:'ll| will| would| shall)\b",
    r"\byou (?:can|could|should|may) (?:expect|hear|get|receive)\b",
    r"\bthere (?:is|are|will be|'s)\b",
    r"\bthis (?:role|position|job|opening|vacancy|package|offer|team|company)\b",
    r"\bthe (?:role|position|job|offer|package) (?:is|will|has|comes|offers|pays|involves)\b",
    r"\b(?:it|this|that)(?:'s| is) (?:a|an)\b[^.?!]{0,25}\b(?:role|position|job|opening)\b",
    r"\b(?:it|the role|the job) (?:pays|comes with|includes|offers)\b",
)
# Questions about the CANDIDATE's own protected characteristics.  The bare words are
# everyday sales vocabulary ("convince parents to enrol their children", "sold health
# insurance"), so each pattern names the candidate ("how old are you", "your religion",
# "do you have kids"), never the topic alone.
_PROTECTED = _ci(
    r"\bhow old (?:are|were) you\b|\byour (?:age|age group|date of birth)\b|\bwhat'?s your age\b",
    r"\b(?:are|were) you (?:\w+ )?(?:married|single|divorced|engaged|pregnant|expecting)\b"
    r"|\bmarital status\b|\bpregnan\w+\b",
    r"\bdo you (?:have|plan to have|want) (?:any )?(?:kids|children|a family|dependents?)\b"
    r"|\bhow many (?:kids|children)\b|\bplan(?:ning)? (?:on )?(?:having )?(?:a family|kids)\b",
    r"\byour (?:spouse|husband|wife|kids|children)\b",
    r"\byour (?:religio\w+|caste|ethnic\w*|race|nationality|visa status|community)\b"
    r"|\b(?:what|which) (?:religio\w+|caste|community|ethnic\w*|nationality)\b",
    r"\byour (?:health|medical (?:condition|history|issues?|status))\b(?!\s+(?:insurance|care|"
    r"tech|products?|plans?|sector|industry|domain|business|startup|apps?|vertical|segment|"
    r"devices?|equipment|sales|clients?|accounts?|portfolio|territory))"
    r"|\bany (?:health|medical) (?:issues?|conditions?|problems?|concerns?)\b"
    r"|\bdo you have (?:a |any )?(?:disabilit\w+|illness\w*|chronic\w*)\b|\bare you disabled\b",
)
# The interviewer ANNOUNCING the role-play in the getting-to-know-you part.  A statement that
# looks forward ("let's move into the role-play", "we'll start the role play", "I'll play a
# prospective learner") is the driver's job, never the model's.  Repeating the candidate's own
# history ("you ran role-plays for new hires") has no such marker and passes, as does any
# question.
_ROLEPLAY_WORD = r"role[- ]?play(?:s|ing|ed)?"
_ROLEPLAY_ANNOUNCE = _ci(
    r"\b(?:let'?s|let us|shall we|we\b|i(?:'ll| will|'m going to| am going to)|"
    r"time (?:to|for)|ready (?:to|for)|about to|"
    r"(?:move|moving|switch|switching|go|going|jump|jumping|dive|diving|get|getting|start|"
    r"starting|begin|beginning|proceed|proceeding) (?:on )?(?:in)?to)\b[^.?!]{0,60}\b"
    + _ROLEPLAY_WORD
    + r"\b",
    r"\bi(?:'ll| will|'m going to| am going to)\b[^.?!]{0,30}\bplay(?:ing)?\b[^.?!]{0,25}"
    r"\b(?:learner|student|prospect|lead|customer)\b",
)
_ROLE_CONTEXT = _ci(
    r"\b(?:(?:this|the) role(?!-)|our shifts?|the shifts?|shift timings?|working days|"
    r"you(?:'ll| will) (?:work|be working)|we work)\b"
)
_TIME_OF_DAY = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", re.IGNORECASE)
_ALLOWED_TIMES = frozenset({(10, 0, "pm"), (8, 0, "am"), (3, 30, "am")})
_SPELLED = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "fifteen": 15,
    "twenty": 20,
}
_UNIT_NUMBER = r"(\d+(?:\.\d+)?|" + "|".join(_SPELLED) + r")(?:-|\s)*"
_HOURS_UNIT = re.compile(r"\b" + _UNIT_NUMBER + r"hours?\b", re.IGNORECASE)
_DAYS_UNIT = re.compile(r"\b" + _UNIT_NUMBER + r"days?\b", re.IGNORECASE)
_ALLOWED_HOURS = frozenset({10.0, 4.5})
_ALLOWED_DAYS = frozenset({5.5})

_CONCESSION = _ci(
    r"\bconvinc",
    r"that (?:resolves|settles|addresses)",
    r"(?:resolves|addresses) my (?:concern|worry|question)",
    r"no (?:more|other) (?:concerns|worries)",
    r"i'?m (?:sold|on board)",
    r"(?:price|cost|\$ ?9,?000) (?:is|'s|sounds) (?:fine|okay|ok|reasonable|fair|worth it)",
    r"(?<!whether )(?<!if )\b(?:it'?s|that'?s|it is|that is|sounds|seems) "
    r"(?:definitely |totally |really )?worth (?:it|every penny|the money|the price)",
    r"you'?ve (?:answered|addressed) (?:all|everything)",
    r"\bsounds like a deal\b|\bi'?ll take it\b(?!\s+from)|\bi accept\b",
)
_OPINION = _ci(
    r"\b(?:is|are|sounds?|seems?|looks?) (?:really |very |quite |pretty |so |super )?"
    r"(?:impressive|good|great|solid|interesting|helpful|expensive|steep|pricey|appealing|"
    r"nice|intense|comprehensive|broad|a lot|too much)\b",
    # Evaluative predicates about the learner's own situation are doubt or opinion, not a
    # product fact: "the course is right for me", "this program is a big decision for me".
    r"\b(?:is|are|sounds?|seems?|feels?) (?:really |just |not |still |kind of |a bit |quite )*"
    r"(?:right|the right|a (?:good |great |bad |better )?fit|for me|a (?:big|huge|major|tough|"
    r"hard|serious) (?:decision|commitment|investment|step|ask)|worth (?:considering|a look))\b",
)
_FORMAT_FACT = _ci(
    r"^(?:i think |i believe |i heard |i guess )?(?:it'?s |it is |they'?re |they are |"
    r"(?:the )?classes are |(?:the )?sessions are |the (?:course|program) is )?"
    r"(?:mostly |all |fully |partly |usually |entirely )?(?:live|recorded)\b",
    r"\blive (?:sessions|classes) (?:plus|with|and) record",
    r"\b(?:classes|sessions|lectures)\b[^.?!]{0,30}\b(?:evenings?|weekends?|weekdays?|"
    r"mornings?)\b",
    r"\b(?:it|the course|the program)\b[^.?!]{0,20}\b(?:takes|needs|requires)\b[^.?!]{0,15}"
    r"\b\d+\s*(?:-|to)?\s*\d*\s*hours?\b",
)
_NUM_WORD = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)"
_HOURS_A_WEEK = re.compile(
    rf"\b{_NUM_WORD}(?:\s*(?:-|to)\s*{_NUM_WORD})?\s*hours?\s*(?:a|per|each|every)\s*"
    r"(?:week|day)\b",
    re.IGNORECASE,
)
_CARD_NOUNS = frozenset({"course", "program", "programme", "bootcamp"})
_PRODUCT_SUBJECT = _ci(
    r"\b(?:the|this|your|that) (?P<noun>course|program|programme|curriculum|classes|"
    r"instructors|mentors?|bootcamp|cohort|capstone|certificate)"
    r"(?:'s\b|\s+(?:\w+\s+){0,3}?(?:is|are|has|have|includes?|covers?|offers?|provides?|"
    r"gives?|gets?|teach(?:es)?|costs?|takes?|runs?|lasts?|comes? with|focus(?:es)?|"
    r"starts?|meets?|happens?)\b)"
)
_CLAIM_WORDS = _ci(
    r"\bguarantee\w*\b",
    r"\bplacements?\b",
    r"\brefunds?\b",
    r"\bsuccess rate\b",
    r"\b\d+\s?% (?:of )?(?:students|learners|graduates)\b",
    r"\bmoney[- ]back\b",
    r"\bfree trial\b",
    r"\b\d{1,2}\s?%\s*(?:off|discount)\b",
)
_CARD_AMOUNTS = frozenset({9000, 7000, 500, 700})
_CARD_DURATION = _ci(r"\b(?:6|six) months\b")
_ACK_WORDS = _ci(
    r"\b(?:course|program|programme|curriculum|class(?:es)?|price|cost|discount|schedule|"
    r"hours?|weeks?|months?|projects?|cohort|capstone|instructors?|mentors?|live|"
    r"recorded|format|evenings?|weekends?|weekdays?|mornings?|nights?|budget|money|"
    r"loans?|instal?lments?|kids|children|husband|wife|family)\b"
)


@dataclass(frozen=True)
class Hit:
    """One guard hit: what fired and a digest, never the utterance itself by default.

    Plan section 9 forbids logging utterances, so ``excerpt`` is empty unless the context
    opts in (``GuardContext.keep_excerpts``, meant for staff dry runs and offline
    replay).  ``digest`` (12 hex characters of the normalised sentence) lets repeated
    hits be correlated without keeping any text.
    """

    category: str
    rule: str
    excerpt: str
    digest: str = ""

    @property
    def log_key(self) -> str:
        return f"r1_guard_{self.category}"


@dataclass(frozen=True)
class GuardContext:
    """Everything the guard needs to know about the moment a sentence is produced."""

    phase: str
    persona: RenderedPersona | None = None
    candidate_first_name: str = ""
    released_topics: frozenset[str] = frozenset()
    advisor_amounts: frozenset[int] = frozenset()
    mode: str = "reply"
    commitment_cap: Level = Level.WEAK
    turn: int = 0
    control_texts: tuple[str, ...] = ()
    keep_excerpts: bool = False

    @property
    def is_learner(self) -> bool:
        return self.phase == LEARNER_PHASE

    @property
    def word_cap(self) -> int | None:
        if not self.is_learner:
            return None
        return ACK_WORD_CAP if self.mode == "ack" else REPLY_WORD_CAP


@dataclass(frozen=True)
class GuardResult:
    """The vetted text and what was found.  ``text`` is always safe to speak."""

    text: str
    hits: tuple[Hit, ...]
    replaced: bool
    fallback_used: bool
    truncated: bool = False

    @property
    def clean(self) -> bool:
        return not self.hits


@dataclass
class GuardLedger:
    """Session counters: three or more LEAK hits flag the session for HR and fail fidelity.

    ``ack_format`` hits are hygiene, not leaks: the acknowledgement guard drops any
    sentence that carries a digit or product word, and that is how a benign paraphrase of
    a card answer ("Money's a bit tight, honestly.") gets removed.  Counting them would
    flag one conversation in four as having broken character for nothing a candidate or
    HR could see (S0-B defect 7 again).  They are still counted and reported separately.
    """

    counts: dict[str, int] = field(default_factory=dict)
    total: int = 0
    leak_total: int = 0

    def record(self, result: GuardResult) -> None:
        for hit in result.hits:
            self.counts[hit.category] = self.counts.get(hit.category, 0) + 1
            self.total += 1
            if hit.category in LEAK_CATEGORIES:
                self.leak_total += 1

    @property
    def flagged(self) -> bool:
        return self.leak_total >= HIT_FLAG_THRESHOLD

    def summary(self) -> dict[str, object]:
        return {
            "hits": self.total,
            "leak_hits": self.leak_total,
            "hygiene_hits": self.total - self.leak_total,
            "by_category": dict(self.counts),
            "flagged": self.flagged,
        }


def _hit(category: str, rule: str, sentence: str) -> Hit:
    return Hit(category, rule, mask_contact(sentence, 60))


def _persona_name_pattern(candidate_first_name: str) -> re.Pattern[str] | None:
    own = (candidate_first_name or "").strip().lower()
    names = sorted(
        {
            name
            for persona in PERSONAS
            for variant in persona.variants
            for name in (variant.first_name, variant.full_name)
            if name.split()[0].lower() != own
        },
        key=len,
        reverse=True,
    )
    if not names:
        return None
    return re.compile(r"\b(?:" + "|".join(re.escape(name) for name in names) + r")\b", re.I)


_NAME_PATTERN_CACHE: dict[str, re.Pattern[str] | None] = {}


def _names(candidate_first_name: str) -> re.Pattern[str] | None:
    key = (candidate_first_name or "").strip().lower()
    if key not in _NAME_PATTERN_CACHE:
        _NAME_PATTERN_CACHE[key] = _persona_name_pattern(key)
    return _NAME_PATTERN_CACHE[key]


_ECHO_TOKEN = re.compile(r"[a-z0-9']+")
ECHO_RUN_WORDS = 6


@functools.lru_cache(maxsize=64)
def _echo_windows(control_texts: tuple[str, ...]) -> frozenset[tuple[str, ...]]:
    windows: set[tuple[str, ...]] = set()
    for text in control_texts:
        tokens = _ECHO_TOKEN.findall(fold(text).lower())
        for index in range(len(tokens) - ECHO_RUN_WORDS + 1):
            windows.add(tuple(tokens[index : index + ECHO_RUN_WORDS]))
    return frozenset(windows)


def echo_detected(sentence: object, control_texts: tuple[str, ...]) -> bool:
    """True when ``sentence`` repeats six consecutive words of a private control text.

    Copied from the phone lane's ``phone_instruction_echo_detected`` (copied, not
    imported: the phone lane is untouchable).  Callers pass only INSTRUCTION prose, never
    the words the model is meant to speak, so a legitimate verbatim answer is not a leak.
    """
    if not control_texts:
        return False
    spoken = _ECHO_TOKEN.findall(fold(sentence).lower())
    if len(spoken) < ECHO_RUN_WORDS:
        return False
    windows = _echo_windows(tuple(control_texts))
    return any(
        tuple(spoken[index : index + ECHO_RUN_WORDS]) in windows
        for index in range(len(spoken) - ECHO_RUN_WORDS + 1)
    )


def _shared_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if echo_detected(sentence, ctx.control_texts):
        hits.append(_hit(CONTROL, "instruction_echo", sentence))
    if _CONTROL_TOKEN.search(sentence) or _CONTROL_PHRASE.search(sentence):
        hits.append(_hit(CONTROL, "control_vocabulary", sentence))
    if _VENDOR.search(sentence):
        hits.append(_hit(VENDOR, "vendor_name", sentence))
    evaluation = _EVALUATION_LEAK if ctx.phase in SMALL_TALK_PHASES else _EVALUATION
    if evaluation.search(sentence):
        hits.append(_hit(EVALUATION, "scoring_vocabulary", sentence))
    if has_contact_detail(sentence):
        hits.append(_hit(CONTACT, "contact_detail", sentence))
    if fuzzy_contains(sentence, EXIT_CUE, 0.9) and word_count(sentence) <= 12:
        hits.append(_hit(SCRIPTED_CUE, "exit_line_imitation", sentence))
    return hits


def _interviewer_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if ctx.phase in PERSONA_REVEALED_PHASES:
        names = _names(ctx.candidate_first_name)
        if (names and names.search(sentence)) or _INTERVIEWER_SECRET.search(sentence):
            hits.append(_hit(PERSONA_SECRET, "persona_vocabulary", sentence))
        elif ctx.persona is not None:
            for topic in H_TOPICS:
                if any(pattern.search(sentence) for pattern in ctx.persona.markers(topic)):
                    hits.append(_hit(PERSONA_SECRET, f"deep_need_{topic}", sentence))
                    break
    if ctx.phase in FEEDBACK_PHASES and _FEEDBACK.search(sentence):
        hits.append(_hit(FEEDBACK, "feedback_phrasing", sentence))
    question = is_question_like(sentence)
    # Only STATEMENTS assert a hiring, pay, work-mode or timeline fact; a question such as
    # "Have you worked in a hybrid team?" asks about the candidate's own experience.
    if not question and _states_hiring_or_pay(sentence):
        hits.append(_hit(HIRING_COMP, "hiring_or_compensation", sentence))
    elif not question and _unapproved_role_fact(sentence):
        hits.append(_hit(INVENTED_FACT, "role_fact_beyond_deck", sentence))
    if question and _PROTECTED.search(sentence):
        hits.append(_hit(PROTECTED_QUESTION, "protected_class", sentence))
    if ctx.phase in SMALL_TALK_PHASES and not question and _ROLEPLAY_ANNOUNCE.search(sentence):
        hits.append(_hit(SCRIPTED_CUE, "roleplay_announcement", sentence))
    return hits


def _states_hiring_or_pay(sentence: str) -> bool:
    """An outcome or pay figure, or an incentive, work-mode or timeline claim about the role.

    The second kind needs a cue that the sentence is about THIS role, the future or an
    offer (``_ABOUT_THE_ROLE_OR_FUTURE``); without one it is the candidate's own past.
    """
    if _HIRING_ALWAYS.search(sentence):
        return True
    return bool(
        _HIRING_ROLE_TERMS.search(sentence) and _ABOUT_THE_ROLE_OR_FUTURE.search(sentence)
    )


def _unapproved_role_fact(sentence: str) -> bool:
    """A shift time, hours or day count for THIS role that the deck does not state.

    Only sentences that describe the role's own shift are checked, so a candidate's
    "12-hour shifts" at a previous job can be repeated back without a false positive.
    """
    if not _ROLE_CONTEXT.search(sentence):
        return False
    for match in _TIME_OF_DAY.finditer(sentence):
        key = (int(match.group(1)), int(match.group(2) or 0), match.group(3).lower())
        if key not in _ALLOWED_TIMES:
            return True
    for match in _HOURS_UNIT.finditer(sentence):
        if _number_value(match.group(1)) not in _ALLOWED_HOURS:
            return True
    for match in _DAYS_UNIT.finditer(sentence):
        if _number_value(match.group(1)) not in _ALLOWED_DAYS:
            return True
    return False


def _number_value(token: str) -> float:
    """A digit string or a spelled-out number (one to twenty) as a float; -1 if unknown."""
    lowered = token.lower()
    if lowered in _SPELLED:
        return float(_SPELLED[lowered])
    try:
        return float(lowered)
    except ValueError:
        return -1.0


def _card_fact_only(sentence: str, allowed: frozenset[int]) -> bool:
    """True when every number in ``sentence`` is a public-card fact (9,000 / six months)."""
    amounts = dollar_amounts(sentence)
    if any(amount not in allowed for amount in amounts):
        return False
    without = _CARD_DURATION.sub(" ", sentence)
    without = re.sub(r"\$\s?[\d,]+(?:\.\d+)?\s*k?", " ", without)
    return not re.search(r"\d", without) and bool(amounts or _CARD_DURATION.search(sentence))


def _is_product_statement(sentence: str, allowed: frozenset[int]) -> bool:
    """A declarative about the product.  Only the website's price and duration pass.

    "The course is around $9,000" and "about six months" are on the card.  Any other
    subject (capstone, classes, instructors, cohort ...) or any other number is a fact
    the learner must not assert, even when it happens to agree with the deck.
    """
    match = _PRODUCT_SUBJECT.search(sentence)
    if match is None or _OPINION.search(sentence):
        return False
    if match.group("noun").lower() in _CARD_NOUNS and _card_fact_only(sentence, allowed):
        return False
    return True


def _learner_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if _LEARNER_META.search(sentence):
        hits.append(_hit(META, "learner_meta", sentence))
    persona = ctx.persona
    if persona is not None:
        for topic in H_TOPICS:
            if topic in ctx.released_topics:
                continue
            if any(pattern.search(sentence) for pattern in persona.markers(topic)):
                hits.append(_hit(VOLUNTEERED_NEED, topic, sentence))
                break
    level = classify_learner_commitment(sentence)
    if level > ctx.commitment_cap:
        hits.append(_hit(COMMITMENT, f"level_{level.name.lower()}", sentence))
    if has_concession(sentence):
        hits.append(_hit(CONCESSION, "resolution_phrasing", sentence))
    question = is_question_like(sentence)
    allowed = _CARD_AMOUNTS | ctx.advisor_amounts
    if not question:
        if _FORMAT_FACT.search(sentence):
            hits.append(_hit(INVENTED_FACT, "format_or_schedule_claim", sentence))
        elif _is_product_statement(sentence, allowed):
            hits.append(_hit(INVENTED_FACT, "product_statement", sentence))
        elif _CLAIM_WORDS.search(sentence):
            hits.append(_hit(INVENTED_FACT, "outcome_or_policy_claim", sentence))
    if _HOURS_A_WEEK.search(sentence) and not question:
        hits.append(_hit(INVENTED_FACT, "own_availability_figure", sentence))
    elif any(amount not in allowed for amount in dollar_amounts(sentence)):
        hits.append(_hit(INVENTED_FACT, "amount_off_card", sentence))
    if ctx.mode == "ack" and not _is_card_answer(sentence, persona):
        if question:
            hits.append(_hit(ACK_FORMAT, "ack_question", sentence))
        elif re.search(r"\d", sentence) or _ACK_WORDS.search(sentence):
            hits.append(_hit(ACK_FORMAT, "ack_fact_vocabulary", sentence))
    return hits


CARD_MATCH_THRESHOLD = 0.75
_POSSESSIVE = re.compile(r"(?<=\w)'s\b")
_DIGITS = re.compile(r"\d+")


def _is_card_answer(sentence: str, persona: RenderedPersona | None) -> bool:
    """True when ``sentence`` is one of the persona's card answers, or a close paraphrase.

    An acknowledgement may carry no facts, but the card's answers ("Around $500-700 a
    month.", "My schedule is pretty packed.", the deflection) are exactly what the
    advisor is allowed to hear, so they pass the acknowledgement vocabulary check.  So
    does a paraphrase that keeps to the card: it contains the answer's content words in
    order (``CARD_MATCH_THRESHOLD``) and adds no digit and no product word the answer does
    not already have ("My schedule's pretty packed, honestly.", "Within a couple of
    weeks, ideally.").  A question is never a card answer unless it is one word for word.
    """
    if persona is None:
        return False
    if normalize(sentence) in _card_answers(persona):
        return True
    if is_question_like(sentence):
        return False
    plain = _POSSESSIVE.sub("", sentence)  # "schedule's" -> "schedule"
    digits = set(_DIGITS.findall(plain))
    vocabulary = {match.group(0).lower() for match in _ACK_WORDS.finditer(plain)}
    for answer, answer_digits, answer_vocabulary in _card_answer_forms(persona):
        if (
            digits <= answer_digits
            and vocabulary <= answer_vocabulary
            and fuzzy_contains(plain, answer, CARD_MATCH_THRESHOLD)
        ):
            return True
    return False


def _card_texts(persona: RenderedPersona) -> list[str]:
    answers = [answer for _, answer in PUBLIC_ANSWERS]
    answers.append(LEARNER_DEFLECTION)
    answers.append(persona.persona.prior_learning)
    answers.extend(persona.surface(topic) for topic in H_TOPICS)
    return answers


@functools.lru_cache(maxsize=64)
def _card_answers(persona: RenderedPersona) -> frozenset[str]:
    return frozenset(normalize(answer) for answer in _card_texts(persona))


@functools.lru_cache(maxsize=64)
def _card_answer_forms(
    persona: RenderedPersona,
) -> tuple[tuple[str, frozenset[str], frozenset[str]], ...]:
    """Each card answer with its possessive-folded text, its digits and its product words."""
    forms = []
    for answer in _card_texts(persona):
        plain = _POSSESSIVE.sub("", answer)
        forms.append(
            (
                plain,
                frozenset(_DIGITS.findall(plain)),
                frozenset(match.group(0).lower() for match in _ACK_WORDS.finditer(plain)),
            )
        )
    return tuple(forms)


def check_sentence(sentence: str, ctx: GuardContext) -> list[Hit]:
    """All hits for one sentence in ``ctx``.  Pure; does not change any state."""
    folded = fold(sentence)
    hits = _shared_hits(folded, ctx)
    if ctx.is_learner:
        hits.extend(_learner_hits(folded, ctx))
    else:
        hits.extend(_interviewer_hits(folded, ctx))
    if not hits:
        return hits
    digest = hashlib.sha256(normalize(folded).encode("utf-8")).hexdigest()[:12]
    keep = ctx.keep_excerpts
    first_name = (ctx.candidate_first_name or "").strip()
    return [
        Hit(
            hit.category,
            hit.rule,
            _scrub_name(hit.excerpt, first_name) if keep else "",
            digest,
        )
        for hit in hits
    ]


def _scrub_name(text: str, first_name: str) -> str:
    """Mask the candidate's first name (the only candidate PII) in an opted-in excerpt."""
    if not first_name:
        return text
    return re.sub(re.escape(first_name), "[name]", text, flags=re.IGNORECASE)


def _replacement(hits: list[Hit], ctx: GuardContext) -> str:
    """The line spoken in place of a blocked sentence, chosen by hit priority.

    Feedback wins over everything (the wrap-up always answers with L-NO-FEEDBACK), then
    the interviewer's deferral line, then the learner's surface answer or contact line.
    Anything else is simply dropped.
    """
    categories = {hit.category for hit in hits}
    if ctx.is_learner and ctx.mode == "ack":
        # An acknowledgement is a few neutral words: a blocked sentence is just dropped.
        return ""
    if FEEDBACK in categories:
        return NO_FEEDBACK_LINE
    if not ctx.is_learner and categories & {HIRING_COMP, INVENTED_FACT}:
        return INTERVIEWER_DEFLECTION
    if ctx.is_learner and ctx.persona is not None:
        need = next((hit for hit in hits if hit.category == VOLUNTEERED_NEED), None)
        if need is not None:
            return ctx.persona.surface(need.rule)
    if ctx.is_learner and CONTACT in categories:
        return CONTACT_REPLACEMENT
    return ""


def _fallback(ctx: GuardContext) -> str:
    if ctx.is_learner and ctx.mode == "ack":
        return NEUTRAL_ACKS[ctx.turn % len(NEUTRAL_ACKS)]
    return FALLBACK_REPLY


class StreamGuard:
    """Vet an LLM reply sentence by sentence, as it streams.

    ``feed`` takes text deltas and returns the sentences now complete and safe to speak;
    ``flush`` vets the remainder and, if nothing at all was emitted, returns the
    fallback.  A learner reply stops at its word cap.  ``result`` aggregates the hits.
    """

    def __init__(self, ctx: GuardContext) -> None:
        self.ctx = ctx
        self._buffer = ""
        self._emitted: list[str] = []
        self._hits: list[Hit] = []
        self._used = 0
        self._truncated = False
        self._replaced = False
        self._fallback_used = False
        self._replacements: set[str] = set()
        self._done = False

    def _vet(self, sentence: str) -> list[str]:
        if self._done:
            return []
        hits = check_sentence(sentence, self.ctx)
        out = sentence
        # The feedback refusal is the whole answer: whatever the model says after it (in the
        # owner's session, a paraphrase of the deferral line, "the hiring team will follow up")
        # would say the same thing twice.  The reply ends with the refusal.
        final = False
        if hits:
            self._hits.extend(hits)
            self._replaced = True
            out = _replacement(hits, self.ctx)
            final = out == NO_FEEDBACK_LINE
            if out in self._replacements:
                out = ""
            if out:
                self._replacements.add(out)
        if not out or out in self._emitted:
            return []
        cap = self.ctx.word_cap
        if cap is not None:
            room = cap - self._used
            size = word_count(out)
            if size > room:
                self._done = True
                self._truncated = True
                if self._emitted:
                    # Never speak a ragged fragment after complete sentences.
                    return []
                out = truncate_words(out, room)
                if not out:
                    return []
                size = word_count(out)
            self._used += size
            if self._used >= cap:
                self._done = True
        self._emitted.append(out)
        if final:
            self._done = True
        return [out]

    def feed(self, delta: str) -> list[str]:
        self._buffer += delta
        parts = split_sentences(self._buffer)
        if len(parts) <= 1:
            return []
        out: list[str] = []
        for sentence in parts[:-1]:
            out.extend(self._vet(sentence))
        self._buffer = parts[-1]
        return out

    def flush(self) -> list[str]:
        out: list[str] = []
        for sentence in split_sentences(self._buffer):
            out.extend(self._vet(sentence))
        self._buffer = ""
        if not self._emitted:
            self._fallback_used = True
            self._emitted.append(_fallback(self.ctx))
            out.append(self._emitted[-1])
        return out

    @property
    def result(self) -> GuardResult:
        return GuardResult(
            text=" ".join(self._emitted),
            hits=tuple(self._hits),
            replaced=self._replaced,
            fallback_used=self._fallback_used,
            truncated=self._truncated,
        )


def guard_text(text: str, ctx: GuardContext) -> GuardResult:
    """Vet a whole reply at once (the non-streaming form of ``StreamGuard``)."""
    guard = StreamGuard(ctx)
    guard.feed(text)
    guard.flush()
    return guard.result


def has_concession(text: object) -> bool:
    """True when ``text`` expresses resolution, acceptance or "you've convinced me".

    Polarity-aware: "I'm not convinced yet", "I'm still not convinced it's worth it" and
    "I'm not sure it's worth the money" are scepticism, which is exactly what the learner
    should voice, so a phrase with a negator earlier in its clause is not a concession.
    """
    folded = fold(text)
    return any(
        not negated_before(folded, match.start()) for match in _CONCESSION.finditer(folded)
    )


def log_keys(hits: Iterable[Hit]) -> list[str]:
    """The ``r1_guard_*`` keys to log for ``hits``, in first-seen order."""
    seen: list[str] = []
    for hit in hits:
        if hit.log_key not in seen:
            seen.append(hit.log_key)
    return seen


# Names that must never reach the interviewer's mouth are exported for tests and logs.
PERSONA_NAMES = tuple(sorted(set(ALL_PERSONA_NAMES)))
