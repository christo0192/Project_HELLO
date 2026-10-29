"""R1 learner personas: four normalised cards, hidden needs and genuine-probe unlock rules.

Plan 5.5.  Every persona has the same shape: three needs (H1 why now, H2 doubt or past
setback, H3 practical constraint), each in three layers: a short SURFACE answer for an
incidental mention, a HINT (a little feeling, no cause, no marker) for the first genuine
probe, and a DEEP need that may only be released after a genuine probe and a follow-up.
The learner never sees a deep need before release (``r1_tracker.DisclosureGate`` decides),
and ``r1_guard`` blocks any sentence that states a still-locked deep need.  The deep need is
handed over as short FACTS plus the STEM words that make the reveal recordable, on the turn
that asks about the topic (R1-Q "give facts, not quotes").

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

from r1_commitment import call_proposal_in
from r1_script import line as script_line
from r1_text import fold, is_question_like, split_sentences

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
    """One hidden need, in three layers: surface, hint and deep (plus the deep's markers).

    * ``surface``: the short answer on the public card, for an incidental mention.
    * ``hint``: what the learner says to the FIRST genuine probe of the topic.  A little
      feeling, no cause, no number: it carries no marker, so it can be spoken at any time.
    * ``deep``: the real need, released by a follow-up probe.  It is the canonical text (the
      content pin, the guard and the tests use it), but the learner is never handed it to
      read out: the reminder gives ``facts`` (2-3 short fragments) and ``stems`` (words to
      use), so the reply is in the learner's own voice and still registers as a reveal.
    * ``markers``: regexes for distinctive facets of the deep text.  They must match the
      deep need, every stem and nothing on the public card, a surface answer, a hint or a
      scripted line; ``tests/test_r1_personas.py`` enforces that.
    """

    topic: str
    surface: str
    deep: str
    markers: tuple[str, ...]
    hint: str
    facts: tuple[str, ...]
    stems: tuple[str, ...]


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
    # Public, marker-free facts the learner may use for small talk and "tell me about
    # yourself" questions, so it has true things to say instead of recycling one profile
    # line.  Nothing here may match a deep-need marker (``tests/test_r1_personas.py``).
    backstory: tuple[str, ...] = ()

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
                hint=(
                    "Things at work feel a bit uncertain right now, and I've been "
                    "in the same spot for a while."
                ),
                facts=(
                    "your plant is being consolidated next year",
                    "your role has been stagnant for about three years",
                ),
                stems=("consolidated", "stagnant"),
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
                hint="I did try learning on my own once, and it didn't really go anywhere.",
                facts=(
                    "you quit a free Python course after three weeks",
                    "it had no structure at all",
                    "you worry you are too old to start coding",
                ),
                stems=("quit", "three weeks", "too old"),
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
                hint="Time and money are both tight at home right now.",
                facts=(
                    "you have two kids",
                    "so it could only be evenings and weekends",
                    "money is shared at home, so you would need monthly instalments",
                ),
                stems=("kids", "evenings and weekends"),
            ),
        ),
        decision_maker="husband",
        prior_learning="Just a bit of online stuff.",
        backstory=(
            "Your day job is reviewing batch records and chasing deviation paperwork at a "
            "pharma site.",
            "You like your team, but the work has become repetitive.",
            "You already build big Excel trackers and reports, and you enjoy that part.",
            "You saw the Interview Kickstart webinar announcement on LinkedIn and "
            "registered.",
            "You are careful with money and like to compare before you pay for anything.",
            "You are calling from home after work, a bit tired but friendly.",
        ),
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
                hint=(
                    "My current job feels a bit temporary, and I'd like something "
                    "more settled."
                ),
                facts=(
                    "your contract renewal is decided in about six months",
                    "you want a data science role by then",
                ),
                stems=("contract renewal",),
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
                hint="The interviews haven't really been going my way lately.",
                facts=(
                    "you keep failing the ML and technical rounds",
                    "learning on your own is not working for you",
                ),
                stems=("keep failing", "not working"),
            ),
            Need(
                "H3",
                "Money's a bit tight.",
                "I have student loans, so it would have to be instalments.",
                (r"student loans?", r"\bloans?\b", r"\bdebt\b"),
                hint="Money is tight for me right now, so how I pay for this matters a lot.",
                facts=(
                    "you have student loans",
                    "so it would have to be monthly instalments",
                ),
                stems=("student loans",),
            ),
        ),
        decision_maker="father",
        prior_learning="Mostly self-study.",
        backstory=(
            "Day to day you build weekly dashboards and clean up spreadsheets with SQL and "
            "Excel.",
            "You apply to data science roles every week and tailor each application.",
            "You went to an Interview Kickstart webinar a few weeks ago and found it "
            "interesting.",
            "You watch free data science videos online in your spare time.",
            "You share an apartment with two roommates.",
        ),
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
                hint=(
                    "I was hoping for a step up at work, and it didn't work out this time."
                ),
                facts=(
                    "you were passed over for an internal data science role",
                    "you did not have enough ML depth",
                    "the next opening is in six to eight months",
                ),
                stems=("passed over", "ML depth"),
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
                hint="I do have a couple of worries about whether it's the right fit for me.",
                facts=(
                    "you fear the course will repeat the SQL basics you already know",
                    "restructuring rumours make you doubt data science is a safe bet",
                ),
                stems=("repeat the SQL basics", "restructuring", "safe bet"),
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
                hint="Work gets pretty hectic at times, and money matters to me too.",
                facts=(
                    "quarter-end crunches are brutal at work",
                    "you would be paying for it yourself, so you would need instalments",
                ),
                stems=("quarter-end", "crunch"),
            ),
        ),
        decision_maker="husband",
        prior_learning="SQL, Excel, Tableau and some Python at work.",
        backstory=(
            "You build Tableau dashboards and write SQL reports for business teams.",
            "You use Python for small automation scripts, nothing fancy.",
            "Your manager is friendly and your team is easygoing.",
            "You registered for an Interview Kickstart webinar after a colleague mentioned "
            "it.",
            "You like to understand the details before you decide anything.",
        ),
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
                hint="I'm weighing my options because things in academia feel uncertain.",
                facts=(
                    "your postdoc funding ends in about eight months",
                    "the academic job market looks bleak",
                ),
                stems=("funding", "eight months", "bleak"),
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
                hint=(
                    "I've talked to a couple of industry teams, and it didn't go the way I'd "
                    "hoped."
                ),
                facts=(
                    "you were rejected after an industry case round",
                    "you lack production ML, SQL and interview skills",
                    "you feel like an outsider",
                ),
                stems=("rejected", "case round", "outsider"),
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
                hint="Money is a real consideration for me, since I'm on a research salary.",
                facts=(
                    "your postdoc budget is tight",
                    "so you would need instalments",
                ),
                stems=("postdoc budget",),
            ),
        ),
        decision_maker="partner",
        prior_learning="Python, R and statistics from my research.",
        backstory=(
            "You analyse large experimental datasets with Python and R, and you enjoy the "
            "statistics.",
            "You have published a few papers and you help supervise two master's students.",
            "You went to an Interview Kickstart webinar a couple of weeks ago, out of "
            "curiosity.",
            "You are curious how data science teams actually work in industry.",
            "You are thoughtful and tend to ask careful questions.",
        ),
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
    def decider_answer(self) -> str:
        """The public answer to "who else is involved in your decision" (one person, all call)."""
        return f"I'd talk it over with my {self.persona.decision_maker} first."

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

    def hint(self, topic: str) -> str:
        return self.persona.need(topic).hint

    def facts(self, topic: str) -> tuple[str, ...]:
        return self.persona.need(topic).facts

    def stems(self, topic: str) -> tuple[str, ...]:
        return self.persona.need(topic).stems

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
        ]
        if self.persona.backstory:
            parts.append(
                "Your backstory (all true; use it in your own words for small talk or when "
                "the advisor asks about you, and never recite it):"
            )
            parts.extend(f"- {fact}" for fact in self.persona.backstory)
        parts.append("Short answers, to give only when asked and never to expand on:")
        for topic in H_TOPICS:
            parts.append(f'- {TOPIC_LABELS[topic]}: "{self.surface(topic)}"')
        parts.append(f'- what you have studied so far: "{self.persona.prior_learning}"')
        for label, answer in PUBLIC_ANSWERS:
            parts.append(f'- {label}: "{answer}"')
        parts.append(f'- who else is involved in your decision: "{self.decider_answer}"')
        parts.append(
            "Anything else about yourself that is not listed here: answer in a few vague, "
            "believable words and invent no numbers, names or dates. Anything else about "
            "the course: you do not know it, so ask the advisor."
        )
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
    # R1-Q: the present tense ("what makes you come here", "what brings you here") and the
    # "why are you looking at our programs" phrasing the owner test used (turns 25, 32, 34).
    r"\bwhat (?:makes|brings|drives|pushes|motivates|prompts|is (?:bringing|making|driving|"
    r"pushing|prompting)) you\b(?! (?:think|say|feel|believe|sure))",
    r"\bwhat(?:'s| is) (?:bringing|driving|prompting) you\b",
    r"\bwhy (?:are you|you're|you are) (?:\w+ ){0,2}(?:looking|interested|exploring|"
    r"considering|thinking|here|calling|enquiring|inquiring)\b",
    # The layoff words are ``_H1_LAYOFF`` below: they name the topic only when the clause is not
    # about the advisor's own job.
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
    # The generic worry words (concern, worry, hesitation ...) are ``_H2_GENERIC_WORRY`` below: they
    # name the topic only when nothing else in the question does.
    r"\bholding you back\b|\bheld you back\b|\bkept you from\b|\bstopp(?:ing|ed) you\b"
    r"|\bin your way\b|\bgot in the way\b|\bget in the way\b",
    r"\b(?:challenges?|struggl\w+|hurdles?|obstacles?|setbacks?|roadblocks?|frustrat\w+)\b",
    # R1-Q: "what is the friction or blocker", "what's stopping you" (owner test turns 34 and
    # 43).  The generic fear words ("scared", "stress", "anxious") are NOT here: see
    # ``_H2_FEAR_WORDS``.
    r"\b(?:blockers?|frictions?|pain[- ]?points?)\b|\bwhat(?:'s| is) stopping\b",
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
    r"\bbiggest (?:gap|challenge|hurdle|obstacle|weakness)\b",
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
# Owner test 7f2a25e6 (turns 46, 48 and 51): "If I get laid off, will you help me get a job?" is
# about the ADVISOR's job, yet it released the learner's H1 hint and then her deep need.  A layoff
# word is an H1 probe unless the clause that holds it has a first-person subject ("if I get laid
# off", "I'm going to get laid off", "layoffs at my company").  No "you" is required: "Is job
# security a concern?" and "are layoffs a worry at your end?" are probes.  The clause runs from the
# last break before the word (punctuation, a conjunction, or a verb that opens a clause: "I think
# you'll be laid off"), and its subject is the nearest subject or possessive pronoun before the
# word; with none, the clause after it decides, and it is the advisor's own only when every
# pronoun there is first person ("layoffs at my company", but "did the layoffs at our company
# affect you?" asks about the learner).  "me" and "us" are no subject.  A first-person speech act
# opens the clause too (reviewed fix): in "Can I ask about the layoffs you mentioned?", "I'm
# curious about ...", "I wanted to ask about job security" and "We've helped people worried about
# layoffs" the advisor is the one asking or helping, not the one laid off.
_H1_LAYOFF = re.compile(r"\b(?:laid off|lay[- ]?offs?|job security)\b", re.IGNORECASE)
_CLAUSE_BREAK = re.compile(
    r"[,;:()]|\s-\s|\b(?:and|but|or|so|if|whether|because|since|when|while|though|although|unless|"
    r"that|then|think|thought|know|knew|feel|felt|guess|mean|say|said|saying|hear|heard|hearing|"
    r"see|saw|seen|seeing|read|understand|wonder|wondering|imagine|bet|hope|ask|asked|asking|"
    r"curious|wanted|want to know|talk about|talking about|help|helped|helping)\b",
    re.IGNORECASE,
)
_SUBJECT_PRONOUN = re.compile(
    r"\b(?:i|we|my|our|you|your|he|she|they|his|her|their)\b", re.IGNORECASE
)
_FIRST_PERSON = frozenset({"i", "we", "my", "our"})


def _layoff_probe(lowered: str) -> bool:
    """True when a question names layoffs or job security about anyone but the advisor."""
    for match in _H1_LAYOFF.finditer(lowered):
        before = lowered[: match.start()]
        breaks = list(_CLAUSE_BREAK.finditer(before))
        subjects = _SUBJECT_PRONOUN.findall(before[breaks[-1].end() if breaks else 0 :])
        if not subjects:
            after = lowered[match.end() :]
            following = _CLAUSE_BREAK.search(after)
            clause = after[: following.start() if following else None]
            subjects = _SUBJECT_PRONOUN.findall(clause)
            if not subjects or any(word.lower() not in _FIRST_PERSON for word in subjects):
                return True
            continue
        if subjects[-1].lower() not in _FIRST_PERSON:
            return True
    return False


# "What makes you get scared of layoffs?" asks about the layoffs (H1), not about what held the
# learner back (H2): a generic fear word counts for H2 only when the same sentence has no H1
# term (R1-Q round 1: it released H2's deep need on an H1 question and gave the advisor unearned
# probing credit).
_H2_FEAR_WORDS = re.compile(r"\b(?:scared|stress\w*|anxi\w+)\b", re.IGNORECASE)
# R1-Q iteration 3.  "What's your biggest hesitation, the cost or the time?" asks about money and
# time, not about what held the learner back before (the live sweep gave the H2 deep need to it).
# The generic worry words name the H2 topic only when the question has no other topic's own words;
# next to a schedule, money or "who else" word the question is about that (H3), and next to an H1
# term (layoffs, the timeline) it is about that.
_H2_GENERIC_WORRY = re.compile(
    r"\b(?:concerns?|worr(?:y|ies|ied|ying)|hesitat\w+|doubts?|nervous|afraid|fears?|apprehens\w+|"
    r"reservations?|biggest (?:worry|concern|fear)|scared|stress\w*|anxi\w+)\b",
    re.IGNORECASE,
)
_H3_TOPIC_WORDS = re.compile(
    r"\b(?:cost|costs|price|money|budget|afford\w*|pay|paying|payment|payments|fees?|instal\w+|"
    r"time|schedule|hours?|weeks?|busy|workload|husband|wife|partner|spouse|family|kids|children|"
    r"parents?|father|mother)\b",
    re.IGNORECASE,
)
# A question that closes or checks in is not a question about the learner's situation, even when
# it names the husband or the father: "does this sound like something worth exploring with your
# father?", "would you want to aim for the upcoming cohort?" (the live sweep released the H3 need
# on one).  A request to DO something ("can you get your husband on the phone now?") is no probe
# either.
_CLOSING_QUESTION = re.compile(
    r"^\W*(?:(?:and|so|okay|ok|well|now|then)\W+)*(?:what do you think|how does (?:that|this|it) "
    r"(?:sound|feel|look)|does (?:that|this|it) (?:sound|seem|feel|look)|do you think (?:that|this"
    r"|it)|would you (?:want|like) to (?:aim|go|move|start|join|explore|look|see|set|book|"
    r"schedule|pick|enrol+)|are you ready|shall we)\b"
    r"|\b(?:does|do|would|is|are) (?:this|that|it|the program|the course) (?:sound|seem|feel|"
    r"look)(?: like)? (?:something|good|right|interesting|worth)\b"
    r"|\bworth (?:exploring|looking into|considering|discussing)\b",
    re.IGNORECASE,
)
_REQUEST_QUESTION = re.compile(
    r"^\W*(?:(?:and|so|okay|ok|well|now|then)\W+)*(?:can|could|would|will) you (?:please )?"
    r"(?:get|put|bring|ask|let|call|text|send|join|hop|connect|pass|take)\b",
    re.IGNORECASE,
)
# A follow-up asks the LEARNER to say more.  It must be a question or an imperative
# addressed to the learner: "Let me give you an example of a student like you", "I'll
# elaborate on our curriculum" and "Let me unpack the modules" are the advisor's own
# pitch and must not release a deep need.
_FOLLOWUP = re.compile(
    r"\b(?:tell me more|say more|what do you mean|how so|why is that|why's that|"
    r"why do you say that|(?:can|could|would) you (?:please )?(?:elaborate|expand|share more|"
    r"say more|tell me more|walk me through that|unpack that|give me an example|"
    r"give an example)|walk me through that|help me understand (?:that|more|this)|"
    r"what'?s behind that|what happened there|what specifically|like what(?=\s*[.?!]*\s*$)|"
    r"is there more|"
    r"how come|in what way|more about that|more on that|dig(?:ging)? (?:in|deeper)|"
    r"what does (?:that|this|it) (?:[\w-]+ ){0,3}look like)\b",
    re.IGNORECASE,
)
# A follow-up also picks up what the learner just said: "When you say it didn't work out, was it
# the technical rounds or something else?", "What specifically tripped you up?".
_FOLLOWUP_REFERENCING = re.compile(
    r"\bwhen you say\b|\byou(?:'ve| have)? (?:mentioned|said|told me)\b|\bsomething else\b"
    r"|\b(?:was|is) it (?:more|the|that|because)\b|\bwhat (?:tripped|held|stopped|kept) you\b"
    r"|\bwhat do you think (?:is|was|held|tripped|made|caused)\b|\bwhat(?:'s| is) making\b"
    r"|\bwhat(?:'s| is) really (?:driving|behind)\b|\bwhy (?:data science|that|this) "
    r"specifically\b|\band why\b|\bwhat would need to be (?:different|true)\b"
    r"|\bwhat(?:'s| is) the main thing\b|\bwhere do you feel\b",
    re.IGNORECASE,
)
# The advisor offering or suggesting something is not asking the learner about themselves:
# "Would it help if I set up a call with you and your father?", "Would a payment plan help?".
_OFFER_QUESTION = re.compile(
    r"\bwould (?:it|that|this|a|an|the|some|any)\b[^?]{0,40}\bhelp\b"
    r"|\bwould it be (?:ok|okay|better|good|helpful|useful|nice)\b|\bwould you like me to\b"
    r"|\bdo you want me to\b|\bwant me to\b|\b(?:shall|should) (?:i|we)\b"
    r"|\b(?:can|could) (?:i|we)\b(?! (?:just |quickly )?ask\b)|\bhow about\b|\bwhy don'?t we\b",
    re.IGNORECASE,
)
# A check-in on the advisor's own answer is not a probe of the learner: "Did that answer your
# concern?", "Does that ease the schedule worry?", "Would that structure work for your budget?".
_CHECKIN_ON_ANSWER = re.compile(
    r"^\W*(?:(?:and|so|okay|ok|well|now|then)\W+)*(?:did|does|do|is|was|would|will|could|can)\s+"
    r"(?:that|this|it|those|these|all (?:of )?that|all this|(?:the|a|an|our|my) [\w' -]{1,40}?)"
    r"\s+(?:\w+\s+){0,3}?(?:help|ease|address|answer|make sense|sound|feel|work|fit|resolve|"
    r"cover|clear|settle|reassure|satisfy|speak to|relieve|lighten|take|give|change)\w*\b",
    re.IGNORECASE,
)
# "Which payment plan sounds most realistic for your budget?" asks for a choice, not a situation.
_CHOICE_QUESTION = re.compile(
    r"^\W*(?:(?:and|so|okay|ok|well|now|then)\W+)*(?:which|what)\s+(?:\w+\s+){0,2}?"
    r"(?:plan|option|discount|tier|package|batch|cohort|payment plan)s?\b",
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
        if not _is_probe_shaped(lowered):
            continue
        # A proposed call is not a probe, whoever it names ("Would your husband join a short
        # call?" released the H3 need in the live sweep and the deep layer was told in reply to it).
        if call_proposal_in(sentence) is not None:
            continue
        in_sentence: set[str] = set()
        for topic, patterns in PROBE_RULES.items():
            if any(pattern.search(lowered) for pattern in patterns):
                in_sentence.add(topic)
        if _layoff_probe(lowered):
            in_sentence.add("H1")
        # A layoff word about the advisor's own job is still what the sentence is about: its fear
        # or worry word is about that, never an H2 probe ("If I get laid off I'm worried, will you
        # help me?").
        h1_term = "H1" in in_sentence or _H1_LAYOFF.search(lowered) is not None
        if not h1_term and _H2_FEAR_WORDS.search(lowered):
            in_sentence.add("H2")
        if _H2_GENERIC_WORRY.search(lowered) is not None and not h1_term:
            # The question names a worry; the topic is whatever it is a worry ABOUT.
            if "H3" in in_sentence or _H3_TOPIC_WORDS.search(lowered) is not None:
                in_sentence.add("H3")
            else:
                in_sentence.add("H2")
        found.update(in_sentence)
    return frozenset(found)


def _is_probe_shaped(lowered: str) -> bool:
    """A question that asks about the learner: no check-in, offer, choice, close or request."""
    return (
        _CHECKIN_ON_ANSWER.search(lowered) is None
        and _OFFER_QUESTION.search(lowered) is None
        and _CHOICE_QUESTION.search(lowered) is None
        and _CLOSING_QUESTION.search(lowered) is None
        and _REQUEST_QUESTION.search(lowered) is None
    )


def detect_followup(text: object) -> bool:
    """True when the candidate asks the learner to say more about what they just said.

    Only a question or an imperative addressed to the learner counts; a statement that
    happens to contain "an example" or "elaborate" is the advisor's pitch.
    """
    for sentence in split_sentences(text):
        folded = fold(sentence)
        if _FOLLOWUP_IMPERATIVE.match(folded.strip()):
            return True
        if is_question_like(folded) and (
            _FOLLOWUP.search(folded) or _FOLLOWUP_REFERENCING.search(folded)
        ):
            return True
    return False


def has_question(text: object) -> bool:
    """True when at least one sentence of ``text`` is question-like."""
    return any(is_question_like(sentence) for sentence in split_sentences(text))


# Somebody else in the learner's decision, named by a pronoun or a role ("is he more of a sounding
# board?", "what would your husband want to know?").
_THIRD_PARTY = re.compile(
    r"\b(?:he|she|they|him|her|them|his|their|your (?:husband|wife|partner|spouse|father|mother|"
    r"dad|mom|parents|family|boss|manager))\b",
    re.IGNORECASE,
)


def asks_about_learner(text: object) -> bool:
    """True when the advisor digs: a question about the learner's situation or the people in it.

    A question counts when a probe rule reads it as one (``detect_probes``), when it asks the
    learner to say more (``detect_followup``), or when it is about somebody else in the learner's
    decision ("is there anything specific he'd want to know?"), and it is not a check-in on the
    advisor's own answer, an offer or a choice between plans.  It is wider than the probe rules on
    purpose: those miss the questions about the husband and the father that two owed objections
    answered in the live sweep (R1-Q iteration 2).  The engine holds back a move that no deadline
    forces for ONE turn when this is true.
    """
    for sentence in split_sentences(text):
        if not is_question_like(sentence):
            continue
        lowered = fold(sentence).lower()
        if not _is_probe_shaped(lowered) or call_proposal_in(sentence) is not None:
            continue
        if (
            detect_probes(sentence)
            or detect_followup(sentence)
            or _THIRD_PARTY.search(lowered) is not None
            or _OPEN_QUESTION.search(lowered) is not None
        ):
            return True
    return False


# R1-Q final review round 1.  A question that digs without naming a topic: "What would help you two
# decide?", "What would make it feel right?", "What's on your mind?".  The live sweep dug the same
# released H3 need six times with questions like these and the rule probes saw none of them, so the
# deep layer was never offered.  Used only to ask for a need that is already released.
_OPEN_QUESTION = re.compile(
    r"\bwhat would (?:help|make|it take|you need|you want|need to)\b"
    r"|\bwhat (?:do|would) you (?:need|want|expect|hope)\b"
    r"|\bhow (?:do|would|does) (?:you|it|that|this) (?:feel|sit|land)\b"
    r"|\bhelp you (?:two |both )?(?:decide|feel|move|get)\b"
    r"|\bwhat(?:'s| is) (?:on your mind|the main thing|most important|really)\b"
    r"|\bwhat matters\b",
    re.IGNORECASE,
)


def asks_open_question(text: object) -> bool:
    """True when the candidate asks the learner an open question about themselves.

    "What would help you two decide?" names no topic and no keyword, so ``detect_probes`` does not
    see it; it is still a dig.  A check-in on the advisor's own answer, an offer, a choice between
    plans, a closing question and a proposed call are not (``_is_probe_shaped``,
    ``call_proposal_in``).
    """
    for sentence in split_sentences(text):
        if not is_question_like(sentence):
            continue
        lowered = fold(sentence).lower()
        if not _is_probe_shaped(lowered) or call_proposal_in(sentence) is not None:
            continue
        if _OPEN_QUESTION.search(lowered) is not None:
            return True
    return False
