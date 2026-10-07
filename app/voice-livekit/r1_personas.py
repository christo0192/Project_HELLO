"""R1 learner personas: four normalised cards, hidden needs and genuine-probe unlock rules.

Plan 5.5.  Every persona has the same shape: three needs (H1 why now, H2 doubt or past
setback, H3 practical constraint), each with a short SURFACE answer for the first related
question and a DEEP need that may only be released after a genuine probe and a follow-up.
The learner never sees a deep need before release (``r1_tracker.DisclosureGate`` decides),
and ``r1_guard`` blocks any sentence that states a still-locked deep need.

What counts as a probe (the S0-B lesson): a QUESTION or elicitation about the topic.
Keyword substring hits are not probes.  "Interview Kickstart", "thanks for your time" and
"career-transition support" are statements, so they can never unlock anything.

Persona ids match the ``interview_round_attempts.persona_id`` check constraint in
migration 0115.  Persona facts here are fiction by design; product facts live only in
``r1_world``.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from r1_script import line as script_line
from r1_text import fold, is_question_like, split_sentences
from r1_world import LEARNER_DEFLECTION

PERSONA_VERSION = 1
STATE_NAMES = {
    "NJ": "New Jersey",
    "TX": "Texas",
    "NC": "North Carolina",
    "GA": "Georgia",
    "MA": "Massachusetts",
}
H_TOPICS = ("H1", "H2", "H3")
TOPIC_LABELS = {
    "H1": "why you are looking now",
    "H2": "what has held you back or not worked before",
    "H3": "your schedule, money or who else decides",
}

CONTACT_ANSWER = "You can use the email on my form."
AVAILABILITY_ANSWER = "I'm not sure yet how many hours a week I could give it."
# The decision timeline and the "data role" goal are deliberately separate (S0-B defect 10).
PUBLIC_ANSWERS: tuple[tuple[str, str], ...] = (
    ("your monthly budget", "Around $500-700 a month."),
    ("when you would decide on this course", "Within a couple of weeks."),
    (
        "other options you looked at",
        "I looked at a couple of bootcamps but didn't compare them in detail.",
    ),
    ("how you heard about it", "I heard about it at a webinar."),
    ("what success looks like for you", "A data role within a year."),
    ("hours a week you could give it", AVAILABILITY_ANSWER),
    ("your e-mail, phone number or any contact detail", CONTACT_ANSWER),
)


@dataclass(frozen=True)
class Need:
    """One hidden need: the surface answer, the deep need and its disclosure markers.

    ``markers`` are regexes for distinctive facets of the deep text.  They must match
    the deep need and nothing on the public card, a surface answer or a scripted line;
    ``tests/test_r1_personas.py`` enforces that.
    """

    topic: str
    surface: str
    deep: str
    markers: tuple[str, ...]


@dataclass(frozen=True)
class Variant:
    """A surface variant: name, city and employer type.  The structure never changes."""

    id: str
    first_name: str
    last_name: str
    city: str
    employer: str

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


@dataclass(frozen=True)
class Persona:
    id: str
    label: str
    age: int
    profile: str
    needs: tuple[Need, ...]
    decision_maker: str
    prior_learning: str
    variants: tuple[Variant, ...]
    version: int = PERSONA_VERSION

    def need(self, topic: str) -> Need:
        for item in self.needs:
            if item.topic == topic:
                return item
        raise KeyError(topic)


PERSONAS: tuple[Persona, ...] = (
    Persona(
        id="p1_career_switcher",
        label="Career switcher",
        age=33,
        profile="Eight years in {employer}; Excel-heavy; no coding.",
        needs=(
            Need(
                "H1",
                "Just exploring options.",
                "My plant is being consolidated next year, and my role has been stagnant "
                "for three years.",
                (
                    r"consolidat",
                    r"stagna",
                    r"\bplant\b",
                    r"stuck (?:in )?(?:the|my) same (?:role|job|position)",
                    r"no (?:growth|promotion)",
                ),
            ),
            Need(
                "H2",
                "I've tried a bit of online stuff.",
                "I quit a free Python course after three weeks without any structure, and "
                "I worry I'm too old to start coding.",
                (
                    r"\bquit\b",
                    r"\bgave up\b",
                    r"\b(?:three|3) weeks\b",
                    r"too old",
                    r"(?:without|no|lack of|lacked) (?:any |real )?structure",
                    r"\bdropped out\b",
                    r"(?:didn'?t|did not|couldn'?t) (?:finish|stick|complete)",
                ),
            ),
            Need(
                "H3",
                "My schedule is pretty packed.",
                "I have two kids, so it would be evenings and weekends only, and our "
                "finances are shared, so I'd need monthly instalments.",
                (
                    r"\bkids\b",
                    r"\bchildren\b",
                    r"evenings? (?:and|&) weekends?",
                    r"weekends? only",
                    r"(?:shared|joint) finances",
                    r"\b(?:daughters?|sons?)\b",
                    r"\bchildcare\b",
                ),
            ),
        ),
        decision_maker="husband",
        prior_learning="Just a bit of online stuff.",
        variants=(
            Variant("v1", "Meera", "Iyer", "Edison, NJ", "pharma operations and quality"),
            Variant(
                "v2", "Priya", "Nair", "Princeton, NJ", "medical device operations and quality"
            ),
            Variant(
                "v3", "Divya", "Shah", "New Brunswick, NJ", "life sciences operations and quality"
            ),
        ),
    ),
    Persona(
        id="p2_recent_grad",
        label="Recent graduate",
        age=24,
        profile=(
            "MS in Information Systems (May); working as a contract {employer} analyst; "
            "150+ data-scientist applications; two final-round losses."
        ),
        needs=(
            Need(
                "H1",
                "The job search is okay.",
                "My contract renewal is decided in about six months, and I want a data "
                "science role by then.",
                (
                    r"contract (?:renewal|renews|is up|ends|end|expires|runs out)\b",
                    r"\brenewal\b",
                ),
            ),
            Need(
                "H2",
                "I get some interviews.",
                "I keep failing the ML and technical rounds, and self-study isn't working "
                "for me.",
                (
                    r"(?:keep|kept|keeps) failing",
                    r"fail(?:ing|ed)? (?:the |my |in )?(?:ml|machine[- ]learning|technical)",
                    r"(?:isn'?t|is not|not) (?:really )?(?:working|translating|getting me)",
                    r"(?:rejected|failed) (?:in|after|at) (?:the )?(?:ml|machine[- ]learning|"
                    r"technical|final)",
                ),
            ),
            Need(
                "H3",
                "Money's a bit tight.",
                "I have student loans, so it would have to be instalments.",
                (r"student loans?", r"\bloans?\b", r"\bdebt\b"),
            ),
        ),
        decision_maker="father",
        prior_learning="Mostly self-study.",
        variants=(
            Variant("v1", "Ananya", "Rao", "Austin, TX", "reporting"),
            Variant("v2", "Neha", "Singh", "Dallas, TX", "business intelligence"),
            Variant("v3", "Pooja", "Gupta", "Houston, TX", "operations reporting"),
        ),
    ),
    Persona(
        id="p3_data_analyst",
        label="Working data analyst",
        age=29,
        profile="Four years as an analyst at {employer} (SQL, Excel, Tableau, some Python).",
        needs=(
            Need(
                "H1",
                "Thinking about my next step.",
                "I was passed over for an internal data science role for not enough ML "
                "depth, and the next opening is in six to eight months.",
                (
                    r"passed over",
                    r"internal (?:ds |data science |data scientist |data )?"
                    r"(?:role|position|opening|job|promotion)",
                    r"ml depth|depth in ml",
                    r"next opening",
                    r"\b(?:6|six)\s*(?:-|to)\s*(?:8|eight) months",
                    r"\bpromotion\b",
                    r"\boverlooked\b",
                ),
            ),
            Need(
                "H2",
                "I already know a lot of the basics.",
                "I'm afraid the course will repeat the SQL basics, and restructuring "
                "rumours make me doubt data science is a safe bet.",
                (
                    r"repeat\w* (?:the |a lot of |all )?(?:sql|basics|stuff i|what i|things i)",
                    r"sql 101",
                    r"basics again",
                    r"restructur",
                    r"safe bet",
                    r"(?:ds|data science) (?:is|isn'?t|is not|might not be) (?:a )?safe",
                    r"\brumou?rs?\b",
                ),
            ),
            Need(
                "H3",
                "Work gets crazy sometimes.",
                "Quarter-end crunches are brutal, and I'd be paying for it myself, so I'd "
                "need instalments.",
                (
                    r"quarter[- ]end",
                    r"pay(?:ing)? (?:for (?:it|this) )?(?:myself|out of pocket)",
                    r"self[- ]fund",
                    r"my own (?:money|pocket)",
                    r"\bcrunch(?:es)?\b",
                    r"year[- ]end",
                ),
            ),
        ),
        decision_maker="husband",
        prior_learning="SQL, Excel, Tableau and some Python at work.",
        variants=(
            Variant("v1", "Kavya", "Menon", "Charlotte, NC", "a bank"),
            Variant("v2", "Sneha", "Pillai", "Raleigh, NC", "an insurance company"),
            Variant("v3", "Ritu", "Kapoor", "Atlanta, GA", "a financial services firm"),
        ),
    ),
    Persona(
        id="p4_research_scholar",
        label="Research scholar",
        age=31,
        profile="PhD, now a postdoc in {employer}; strong Python, R and statistics.",
        needs=(
            Need(
                "H1",
                "Weighing a few paths.",
                "My funding ends in about eight months, and the academic job market is "
                "bleak.",
                (
                    r"\bfunding\b",
                    r"academic (?:job )?market",
                    r"\bbleak\b",
                    r"\b(?:8|eight) months\b",
                    r"postdoc (?:ends|is ending)",
                    r"job market",
                ),
            ),
            Need(
                "H2",
                "Industry interviews are different.",
                "I was rejected after an industry case round; I lack production ML, SQL and "
                "interview skills, and I feel like an outsider.",
                (
                    r"case (?:round|interview|study)",
                    r"\brejected\b",
                    r"production (?:ml|machine learning|code|systems?)",
                    r"\boutsider\b",
                    r"(?:lack|missing|don'?t have|no|weak on) (?:production|sql)",
                    r"industry (?:case|interview) (?:round|rejection)",
                ),
            ),
            Need(
                "H3",
                "I'm still running experiments.",
                "My postdoc budget is tight, so I'd need instalments.",
                (
                    r"postdoc (?:budget|salary|stipend|pay)",
                    r"budget(?:'s| is) (?:pretty |really |a bit |quite )?tight",
                    r"tight budget",
                    r"\bstipend\b",
                ),
            ),
        ),
        decision_maker="partner",
        prior_learning="Python, R and statistics from my research.",
        variants=(
            Variant("v1", "Shalini", "Verma", "Boston, MA", "computational biology"),
            Variant("v2", "Anjali", "Joshi", "Cambridge, MA", "bioinformatics"),
            Variant("v3", "Nisha", "Reddy", "Somerville, MA", "computational neuroscience"),
        ),
    ),
)

PERSONA_IDS = tuple(persona.id for persona in PERSONAS)
PERSONA_BY_ID = {persona.id: persona for persona in PERSONAS}
ALL_PERSONA_NAMES = tuple(
    name
    for persona in PERSONAS
    for variant in persona.variants
    for name in (variant.first_name, variant.last_name, variant.full_name)
)


def get_persona(persona_id: str) -> Persona:
    """Return a persona by its database id; an unknown id raises ``KeyError``."""
    return PERSONA_BY_ID[persona_id]


@dataclass(frozen=True)
class RenderedPersona:
    """A persona with one resolved surface variant, ready to feed the prompts."""

    persona: Persona
    variant: Variant

    @property
    def id(self) -> str:
        return self.persona.id

    @property
    def version(self) -> int:
        return self.persona.version

    @property
    def variant_id(self) -> str:
        return self.variant.id

    @property
    def first_name(self) -> str:
        return self.variant.first_name

    @property
    def lead_name(self) -> str:
        return self.variant.full_name

    @property
    def lead_city(self) -> str:
        return self.variant.city

    @property
    def decision_maker(self) -> str:
        return self.persona.decision_maker

    @property
    def spoken_city(self) -> str:
        """The city as TTS should read it: "Edison, New Jersey", not "Edison, NJ"."""
        town, _, state = self.variant.city.partition(", ")
        return f"{town}, {STATE_NAMES.get(state, state)}" if state else town

    @property
    def line_values(self) -> dict[str, str]:
        """Persona values for ``r1_script.line`` (never candidate data)."""
        return {
            "lead_name": self.lead_name,
            "lead_city": self.spoken_city,
            "lead_first_name": self.first_name,
        }

    @property
    def pickup_line(self) -> str:
        return script_line("L-PICKUP", **self.line_values)

    @property
    def profile(self) -> str:
        return self.persona.profile.format(employer=self.variant.employer)

    def surface(self, topic: str) -> str:
        return self.persona.need(topic).surface

    def deep(self, topic: str) -> str:
        return self.persona.need(topic).deep

    def markers(self, topic: str) -> tuple[re.Pattern[str], ...]:
        return _compiled_markers(self.persona.id, topic)

    def public_card_text(self) -> str:
        """Everything the learner prompt may say about the persona; no deep need."""
        parts = [
            f"You are {self.lead_name}, {self.persona.age}, in {self.lead_city}. "
            f"{self.profile}",
            "You filled in a form on the Interview Kickstart website a few days ago about "
            "the Data Science course. You know only that it is around $9,000 and about "
            "6 months.",
            "Short answers, to give only when asked and never to expand on:",
        ]
        for topic in H_TOPICS:
            parts.append(f'- {TOPIC_LABELS[topic]}: "{self.surface(topic)}"')
        parts.append(f'- what you have studied so far: "{self.persona.prior_learning}"')
        for label, answer in PUBLIC_ANSWERS:
            parts.append(f'- {label}: "{answer}"')
        parts.append(f'Anything else not listed here: "{LEARNER_DEFLECTION}"')
        return "\n".join(parts)


_MARKER_CACHE: dict[tuple[str, str], tuple[re.Pattern[str], ...]] = {}


def _compiled_markers(persona_id: str, topic: str) -> tuple[re.Pattern[str], ...]:
    key = (persona_id, topic)
    cached = _MARKER_CACHE.get(key)
    if cached is None:
        raw = PERSONA_BY_ID[persona_id].need(topic).markers
        cached = tuple(re.compile(pattern, re.IGNORECASE) for pattern in raw)
        _MARKER_CACHE[key] = cached
    return cached


def deep_need_topics_in(rendered: RenderedPersona, text: object) -> frozenset[str]:
    """Topics whose deep-need markers occur in ``text`` (used for reveal bookkeeping)."""
    folded = fold(text)
    return frozenset(
        topic
        for topic in H_TOPICS
        if any(pattern.search(folded) for pattern in rendered.markers(topic))
    )


def resolve_persona(
    persona_id: str,
    *,
    variant: str = "default",
    seed: str = "",
    avoid_first_name: str = "",
) -> RenderedPersona:
    """Resolve the attempt's persona and one stable surface variant.

    ``variant`` is the stored ``persona_variant``: a known variant id is honoured, while
    ``"default"`` (the column default) or an unknown id is replaced by a deterministic
    pick from ``seed`` (the attempt id), so a restart of the same attempt always gets
    the same variant.  The pick skips a variant whose first name equals the candidate's,
    so the learner is never named like the person on the call.
    """
    persona = PERSONA_BY_ID[persona_id]
    avoid = (avoid_first_name or "").strip().lower()
    by_id = {item.id: item for item in persona.variants}
    chosen = by_id.get(variant)
    if chosen is None:
        digest = hashlib.sha256(f"{persona_id}:{seed}".encode()).digest()
        start = int.from_bytes(digest[:4], "big") % len(persona.variants)
        chosen = persona.variants[start]
        for offset in range(len(persona.variants)):
            candidate = persona.variants[(start + offset) % len(persona.variants)]
            if candidate.first_name.lower() != avoid:
                chosen = candidate
                break
    return RenderedPersona(persona, chosen)


# ----------------------------------------------------------------------------------
# Genuine-probe detection.  A probe is a QUESTION sentence about the topic; every
# pattern below is applied to question-like sentences only.
# ----------------------------------------------------------------------------------
_H1_PATTERNS = (
    r"\bwhy (?:now|this year|this time|today|so soon|right now)\b",
    r"\bwhy you(?:'re| are) (?:\w+ ){0,3}(?:now|right now|at this point|this year|this time|"
    r"recently)\b",
    r"\b(?:the|your) timing\b",
    r"\bwhy (?:are|did|do|would) you (?:\w+ ){0,4}(?:now|right now|at this point|this year|"
    r"this time|recently|so soon)\b",
    r"\bwhat(?:'s| is| was| has| have)? (?:been )?(?:driving|behind|prompting|motivating|"
    r"pushing|triggering)\b",
    r"\bwhat (?:made|prompted|triggered|sparked|pushed|got|led|brought) you\b",
    r"\bwhat (?:changed|has changed)\b",
    r"\b(?:specific|particular|any) (?:trigger|event|reason|deadline|date|catalyst)\b",
    r"\btrigger\b",
    r"\burgency\b",
    r"\bhow soon\b",
    r"\bby when\b",
    r"\bwhen (?:are|do|would|did|were) you (?:\w+ ){0,3}(?:hoping|want|plan|expect|looking|"
    r"aiming|need|thinking)\b",
    r"\b(?:your|any) (?:[\w-]+ ){0,4}(?:timeline|timeframe|time frame|time-frame)\b",
    r"\bwhat(?:'s| is| was)? (?:the |your )?(?:[\w-]+ ){0,2}(?:timeline|timeframe)\b",
    r"\b(?:a|an) (?:specific |particular |hard |tight )?(?:timeline|timeframe|time frame)\b",
    r"\b(?:your|any|a|an) (?:[\w-]+ ){0,2}deadline\b",
)
_H2_PATTERNS = (
    r"\b(?:concerns?|worr(?:y|ies|ied|ying)|hesitat\w+|doubts?|nervous|afraid|fears?|"
    r"apprehens\w+|reservations?)\b",
    r"\bholding you back\b|\bstopp(?:ing|ed) you\b|\bin your way\b|\bgot in the way\b"
    r"|\bget in the way\b",
    r"\b(?:challenges?|struggl\w+|hurdles?|obstacles?|setbacks?|roadblocks?|frustrat\w+)\b",
    r"\bwhat (?:have|did|had) you (?:tried|try|done|attempted|used)\b",
    r"\b(?:have|had) you (?:tried|taken|attempted|studied|used)\b",
    r"\b(?:tried|trying) (?:so far|before|already|anything)\b",
    r"\b(?:learned|studied|done|taken|worked on|looked at)\b[^?.!]{0,25}\bso far\b",
    r"\bprevious(?:ly)? (?:attempts?|courses?|programs?|bootcamps?|tries|efforts?)\b"
    r"|\bpast (?:attempts?|efforts?)\b|\blast time\b",
    r"\bself[- ]?(?:study|taught|learning|paced)\b",
    r"\bdidn'?t work\b|\bnot working\b|\bwhat went wrong\b|\bwhat happened\b",
    r"\bhow (?:has|have|is|was|did|are) (?:the |your |that |it |this )?(?:job search|search|"
    r"learning|studying|studies|prep|preparation|interviews?|applications?|courses?|"
    r"attempts?|that|it)\b[^?.!]{0,30}\b(?:going|gone|go|worked|working)\b",
    r"\bbiggest (?:gap|worry|concern|challenge|hurdle|obstacle|weakness|fear)\b",
    r"\b(?:gaps?|weak(?:ness|nesses|est)?) (?:in|you|that)\b",
)
_H3_PATTERNS = (
    r"\bhow (?:many|much) (?:hours|time)\b",
    r"\bhours? (?:a|per|each|every) (?:week|day)\b|\b(?:weekly|daily) (?:hours|commitment|"
    r"routine|schedule)\b",
    r"\b(?:typical|usual|average|regular|normal) (?:week|day|schedule|routine)\b"
    r"|\bweek look\b|\bday look\b",
    r"\b(?:your|work|study|learning|weekly|daily|current) (?:schedule|availability|workload|"
    r"routine|commitments?)\b",
    r"\bscheduling (?:constraints?|issues?|challenges?|conflicts?)\b"
    r"|\bschedule (?:look|like|allow|permit|conflicts?|constraints?)\b",
    r"\bavailability\b|\bbandwidth\b|\bworkload\b",
    r"\b(?:fit|squeeze|balance|juggle|manage)\b[^?.!]{0,40}\b(?:work|job|family|life|"
    r"schedule|alongside|around)\b",
    r"\b(?:dedicate|devote|set aside|find the time)\b|\bput in (?:the )?(?:time|hours|effort)\b",
    r"\b(?:budget|afford\w*|financing|finances|funding|funded|sponsor\w*|reimburs\w*|"
    r"out of pocket|self[- ]?fund\w*)\b",
    r"\bfinancial (?:constraints?|situation|concerns?|commitments?|aid|support|planning|"
    r"picture)\b",
    r"\b(?:paying|pay|payment|payments) (?:for|on|plans?|options?)\b"
    r"|\bhow (?:are|do|would|will) you (?:\w+ ){0,3}(?:pay|paying|fund|finance)\b",
    r"\b(?:instal?lments?|emi|loans?|money)\b",
    r"\b(?:cost|price|fees?)\b[^?.!]{0,20}\b(?:concern|issue|factor|worry|problem|matter|"
    r"stretch)\b|\b(?:concern|issue|worry)\b[^?.!]{0,20}\b(?:cost|price|money|budget)\b",
    r"\bdecision[- ]?makers?\b|\banyone else\b|\bsomeone else\b|\bother (?:people|person|"
    r"stakeholders?)\b",
    r"\b(?:spouse|partner|husband|wife|family|parents?|father|mother)\b",
    r"\b(?:manager|boss|employer) (?:know|think|support|approve|involved|pay)\w*\b",
    r"\binvolved in (?:the|this|that) decision\b|\bwho (?:else|decides|makes the decision)\b"
    r"|\bdecide (?:together|with)\b|\bdiscuss (?:it|this|that) with\b",
)
_PROBE_PATTERNS = {"H1": _H1_PATTERNS, "H2": _H2_PATTERNS, "H3": _H3_PATTERNS}
PROBE_RULES: dict[str, tuple[re.Pattern[str], ...]] = {
    topic: tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)
    for topic, patterns in _PROBE_PATTERNS.items()
}
# A follow-up asks the LEARNER to say more.  It must be a question or an imperative
# addressed to the learner: "Let me give you an example of a student like you", "I'll
# elaborate on our curriculum" and "Let me unpack the modules" are the advisor's own
# pitch and must not release a deep need.
_FOLLOWUP = re.compile(
    r"\b(?:tell me more|say more|what do you mean|how so|why is that|why's that|"
    r"why do you say that|(?:can|could|would) you (?:please )?(?:elaborate|expand|share more|"
    r"say more|tell me more|walk me through that|unpack that|give me an example|"
    r"give an example)|walk me through that|help me understand (?:that|more|this)|"
    r"what'?s behind that|what happened there|what specifically|like what|is there more|"
    r"how come|in what way|more about that|more on that|dig(?:ging)? (?:in|deeper)|"
    r"what does (?:that|this|it) (?:[\w-]+ ){0,3}look like)\b",
    re.IGNORECASE,
)
_FOLLOWUP_IMPERATIVE = re.compile(
    r"^(?:(?:okay|ok|so|and|please)[,\s]+)*(?:please\s+)?"
    r"(?:say more|elaborate|expand|dig (?:in|deeper)|go on|keep going|unpack that)\b",
    re.IGNORECASE,
)


def detect_probes(text: object) -> frozenset[str]:
    """Topics the candidate genuinely asked about in ``text``.

    Only question-like sentences are examined, so a statement such as "Interview
    Kickstart was founded in 2014" or "Thanks for your time" can never match.
    """
    found: set[str] = set()
    for sentence in split_sentences(text):
        if not is_question_like(sentence):
            continue
        lowered = fold(sentence).lower()
        for topic, patterns in PROBE_RULES.items():
            if any(pattern.search(lowered) for pattern in patterns):
                found.add(topic)
    return frozenset(found)


def detect_followup(text: object) -> bool:
    """True when the candidate asks the learner to say more about what they just said.

    Only a question or an imperative addressed to the learner counts; a statement that
    happens to contain "an example" or "elaborate" is the advisor's pitch.
    """
    for sentence in split_sentences(text):
        folded = fold(sentence)
        if _FOLLOWUP_IMPERATIVE.match(folded.strip()):
            return True
        if is_question_like(folded) and _FOLLOWUP.search(folded):
            return True
    return False


def has_question(text: object) -> bool:
    """True when at least one sentence of ``text`` is question-like."""
    return any(is_question_like(sentence) for sentence in split_sentences(text))
