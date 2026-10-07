"""R1 world facts: everything the role-play may assert about IK, taken from the prep deck.

Owner decision (2026-10-06): there is NO separate world-facts sheet.  Product facts come
only from the "Interview Kickstart (IK) Sales Mock Preparation Guide" PDF, and anything
the deck does not state must not be asserted by the learner or the interviewer.  The
deck states a price, the three possible discounts, the duration, the module list, the
audience, the USPs and a list of urgency levers.  It does NOT state which discount
belongs to which payment plan, cohort dates, deadlines, seat counts, weekly hours,
live-versus-recorded delivery, project details, outcomes statistics or a "does not
offer" list.  Those gaps are listed in ``UNSTATED_TOPICS`` and have a deflection policy.

The module is pure data plus small lookups.  ``WORLD_SHA256`` pins every fact, so any
edit changes ``WORLD_VERSION`` and ``tests/test_r1_world.py`` fails until the pin is
reviewed and bumped.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

from r1_script import LINES
from r1_text import dollar_amounts, fold, negated_before, split_sentences

WORLD_REVISION = 1
DECK_TITLE = "Interview Kickstart (IK) Sales Mock Preparation Guide"
DECK_FILENAME = "Copy of Sales Mock Call Prep Document_Updated.pdf"
DECK_PAGES = 3
# SHA-256 of the PDF as supplied on 2026-10-06; it ties the facts below to one document.
DECK_SHA256 = "73f452c4957a34e03033b64bf2ffb9b9f199af5984b6ae17efc881ddfd5adf24"

PRICE_USD = 9000
DISCOUNTS_USD = (500, 1000, 1500)
MAX_DISCOUNT_USD = 1500
DURATION_MONTHS = 6
NET_PRICES_USD = tuple(PRICE_USD - discount for discount in DISCOUNTS_USD)

AUDIENCE_ADVISOR = "advisor"
AUDIENCE_SCORER = "scorer"
AUDIENCE_INTERVIEWER_FAQ = "interviewer_faq"
AUDIENCE_CANDIDATE_PREP = "candidate_prep"


@dataclass(frozen=True)
class Fact:
    """One claim, worded as the deck words it, with the deck page that states it."""

    id: str
    text: str
    page: int
    audiences: tuple[str, ...]


_ADVISOR = (AUDIENCE_ADVISOR, AUDIENCE_SCORER)

FACTS: tuple[Fact, ...] = (
    Fact(
        "company.founded",
        "Interview Kickstart (IK) was founded in 2014 to help tech professionals succeed "
        "in career transitions and interview preparations.",
        1,
        _ADVISOR,
    ),
    Fact(
        "products.interview_prep",
        "IK's interview prep courses cover 18 engineering domains, designed to help "
        "engineers in the US clear interviews with top-tier tech companies.",
        1,
        _ADVISOR,
    ),
    Fact(
        "products.career_transition",
        "IK also offers career transitioning courses in Machine Learning and Data Science "
        "for non-ML/DS engineers looking to shift into these high-demand fields.",
        1,
        _ADVISOR,
    ),
    Fact(
        "usp.instructors",
        "IK's team includes over 750 instructors from leading Silicon Valley companies "
        "like Google, Facebook, Amazon, and Netflix.",
        1,
        _ADVISOR,
    ),
    Fact(
        "ds.objective",
        "The Data Science course is targeted at aspiring data scientists.",
        1,
        _ADVISOR,
    ),
    Fact(
        "ds.modules",
        "The Data Science course modules are Python Fundamentals; Database & SQL "
        "Programming; Math for Data Science & Machine Learning; Exploratory Data "
        "Analysis; Classical Machine Learning; Advanced Machine Learning & Deep "
        "Learning; Big Data Analysis; Data Visualization & Storytelling; and a "
        "Capstone Project.",
        2,
        _ADVISOR,
    ),
    Fact(
        "ds.price",
        "The Data Science course has a listed price of $9000.",
        2,
        _ADVISOR,
    ),
    Fact(
        "ds.discounts",
        "The applicable discounts are $500, $1000 and $1500, depending on the payment "
        "plan chosen.",
        2,
        _ADVISOR,
    ),
    Fact("ds.duration", "The Data Science course lasts 6 months.", 2, _ADVISOR),
    Fact(
        "ds.audience",
        "The Data Science course suits recent graduates, current data professionals, "
        "career switchers, research scholars and tech enthusiasts.",
        2,
        _ADVISOR,
    ),
    Fact(
        "ds.careers",
        "Career opportunities in data science include Data Scientist, Machine Learning "
        "Engineer, Data Analyst, Business Intelligence Analyst and AI Research Scientist.",
        2,
        _ADVISOR,
    ),
    Fact(
        "ds.usps",
        "Key USPs of the course and IK: expertly designed curriculum by industry leaders; "
        "personalized mentorship; real-world projects; intensive mock interviews; "
        "comprehensive career support; proven track record of alumni success; in-depth "
        "curriculum coverage; flexible learning options.",
        2,
        _ADVISOR,
    ),
    Fact(
        "ds.pricing_pitch",
        "Example pricing pitch: at Interview Kickstart we understand the importance of "
        "transparency and flexibility in pricing our Data Science course. Priced at $9000, "
        "we offer discounts of $500, $1000, and $1500, depending on the payment plan "
        "chosen. Our aim is to accommodate your financial needs while ensuring access to "
        "our comprehensive curriculum, personalized mentorship, and career support. We "
        "believe in fair pricing that reflects the value of our program and are open to "
        "discussing customized options to meet your individual circumstances.",
        2,
        _ADVISOR,
    ),
    Fact(
        "ds.urgency_levers",
        "Urgency can be created with limited enrollment spots, upcoming application "
        "deadlines, seasonal discounts, high industry demand for data scientists, early "
        "access to resources, upcoming recruitment cycles, career advancement potential "
        "and proven success stories.",
        3,
        _ADVISOR,
    ),
    Fact(
        "role.shift",
        "Working days are 5.5 days a week. Shift timings: Monday to Friday 10:00 PM to "
        "8 AM IST (10 hours); Monday early morning 3:30 AM to 8 AM IST (4.5 hours).",
        1,
        (AUDIENCE_INTERVIEWER_FAQ, AUDIENCE_CANDIDATE_PREP),
    ),
    Fact(
        "role.process",
        "Interview process: Round 1 is a mock call round on Data Science, prepared with "
        "this guide. Round 2 is a Functional and Culture interview, and a mock interview "
        "will be done again if required.",
        1,
        (AUDIENCE_CANDIDATE_PREP,),
    ),
)

# Urgency levers the deck lists, as stable ids (used by the coverage tracker).
URGENCY_LEVER_IDS = (
    "limited_spots",
    "application_deadline",
    "seasonal_discount",
    "industry_demand",
    "early_access",
    "recruitment_cycle",
    "career_advancement",
    "success_stories",
)

# What the learner knows from the website form: nothing but these two numbers.
LEARNER_PUBLIC_PRICE_USD = PRICE_USD
LEARNER_PUBLIC_DURATION_MONTHS = DURATION_MONTHS


@dataclass(frozen=True)
class UnstatedTopic:
    """A subject on which the deck is silent, so nobody in the role-play may assert it."""

    id: str
    label: str


UNSTATED_TOPICS: tuple[UnstatedTopic, ...] = (
    UnstatedTopic("discount_plan_mapping", "which discount belongs to which payment plan"),
    UnstatedTopic("payment_plan_details", "instalment or payment plan terms"),
    UnstatedTopic("cohort_start_dates", "cohort start dates"),
    UnstatedTopic("enrolment_deadline", "enrolment or application deadline dates"),
    UnstatedTopic("seat_counts", "number of seats or spots"),
    UnstatedTopic("seasonal_offer", "the details of any seasonal offer"),
    UnstatedTopic("weekly_hours", "weekly hours or class schedule"),
    UnstatedTopic("delivery_format", "live versus recorded delivery"),
    UnstatedTopic("project_details", "what the real-world projects or capstone involve"),
    UnstatedTopic("mentorship_details", "mentor ratio or mentorship format"),
    UnstatedTopic("career_support_details", "what career support includes"),
    UnstatedTopic("outcome_statistics", "placement rates, salaries or alumni numbers"),
    UnstatedTopic("refund_policy", "refunds or money-back terms"),
    UnstatedTopic("prerequisites", "prerequisites or eligibility"),
    UnstatedTopic("certification", "certificates or credentials"),
    UnstatedTopic("does_not_offer", "what the course does not offer"),
    UnstatedTopic("role_work_mode", "remote, hybrid or on-site work mode"),
    UnstatedTopic("role_compensation", "salary, incentives or other compensation"),
    UnstatedTopic("role_training", "training or onboarding for the role"),
    UnstatedTopic("role_next_steps", "next-step timelines or hiring decisions"),
)

LEARNER_DEFLECTION = "I'm not sure, I haven't thought about that."
INTERVIEWER_DEFLECTION = LINES["L-FAQ-DEFER"]
SCORER_RULE = (
    "Claims consistent with the deck are legitimate. Plausible specifics the deck does "
    "not cover are neutral unless coercive. Claims that contradict the deck (a price "
    "other than $9000, a discount outside $500/$1000/$1500 or above $1500, a duration "
    "other than 6 months, a guaranteed outcome) are violations."
)
DEFLECTION_POLICY = {
    "learner": (
        "Never assert a product fact. If the advisor asks about anything off the public "
        "card, answer with LEARNER_DEFLECTION. If the advisor asserts something unstated "
        "or beyond the deck, accept it without correcting it."
    ),
    "interviewer": (
        "Answer only role questions covered by the interviewer FAQ facts. For anything "
        "else, including pay, work mode, training, timelines and outcomes, say "
        "INTERVIEWER_DEFLECTION."
    ),
    "scorer": SCORER_RULE,
}


def _canonical() -> bytes:
    payload = {
        "revision": WORLD_REVISION,
        "deck": {"title": DECK_TITLE, "pages": DECK_PAGES, "sha256": DECK_SHA256},
        "numbers": {
            "price_usd": PRICE_USD,
            "discounts_usd": list(DISCOUNTS_USD),
            "max_discount_usd": MAX_DISCOUNT_USD,
            "duration_months": DURATION_MONTHS,
        },
        "facts": [
            {"id": f.id, "text": f.text, "page": f.page, "audiences": list(f.audiences)}
            for f in FACTS
        ],
        "urgency_levers": list(URGENCY_LEVER_IDS),
        "unstated": [{"id": t.id, "label": t.label} for t in UNSTATED_TOPICS],
        "deflections": {
            "learner": LEARNER_DEFLECTION,
            "interviewer": INTERVIEWER_DEFLECTION,
            "policy": DEFLECTION_POLICY,
        },
    }
    return json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()


WORLD_SHA256 = hashlib.sha256(_canonical()).hexdigest()
WORLD_VERSION = f"r1_world_facts_v{WORLD_REVISION}+{WORLD_SHA256[:12]}"


def fact(fact_id: str) -> Fact:
    """Return one fact by id; an unknown id raises ``KeyError`` so typos fail loudly."""
    for item in FACTS:
        if item.id == fact_id:
            return item
    raise KeyError(fact_id)


def facts_for(audience: str) -> tuple[Fact, ...]:
    """The facts a given audience may use, in deck order."""
    return tuple(item for item in FACTS if audience in item.audiences)


_NUMBER_WORDS = {
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
}
_GUARANTEE = re.compile(
    r"\bguarantee[ds]?\b|\b(?:100\s?%|hundred percent)\s+(?:placement|job)\b"
    r"|\bassured\s+(?:job|placement)\b",
    re.IGNORECASE,
)
_DURATION_SENTENCE = re.compile(
    r"\b(?:course|program|programme|duration|takes|lasts|runs|long)\b", re.IGNORECASE
)
_MONTHS = re.compile(r"\b(\d{1,2}|" + "|".join(_NUMBER_WORDS) + r")[\s-]*months?\b", re.IGNORECASE)
_PRICE_SENTENCE = re.compile(
    r"\b(?:price[ds]?|pricing|cost[s]?|fee[s]?|tuition|total|pay|payment)\b", re.IGNORECASE
)
_ALLOWED_PRICE_AMOUNTS = frozenset((PRICE_USD, *NET_PRICES_USD, *DISCOUNTS_USD))


def claims_guarantee(text: object) -> bool:
    """True when ``text`` AFFIRMS a guarantee (of a job, of placement, of a refund).

    An honest disclaimer is the opposite of a claim: "I can't guarantee a job", "Nobody
    can guarantee placement" and "We don't offer a money-back guarantee" are what the deck
    wants the advisor to say, so a match whose clause carries a negator before it is
    ignored (``r1_text.negated_before``).  "It's a guaranteed job" still counts.
    """
    for sentence in split_sentences(text):
        folded = fold(sentence)
        for match in _GUARANTEE.finditer(folded):
            if not negated_before(folded, match.start()):
                return True
    return False


def deck_conflicts(text: object) -> tuple[str, ...]:
    """Machine-checkable contradictions of the deck, as stable codes.

    This is deliberately narrow: it covers only what the deck pins down (the price, the
    duration, and the absence of any guarantee).  Plausible specifics the deck does not
    mention are NOT conflicts, and neither is a disclaimer of a guarantee.  Codes:
    ``guarantee_claim``, ``duration_not_deck`` and ``price_not_deck``.
    """
    found: list[str] = []
    folded = fold(text)
    if claims_guarantee(text):
        found.append("guarantee_claim")
    for sentence in split_sentences(folded):
        if _DURATION_SENTENCE.search(sentence):
            for match in _MONTHS.finditer(sentence):
                raw = match.group(1).lower()
                months = _NUMBER_WORDS.get(raw)
                if months is None:
                    months = int(raw)
                if months != DURATION_MONTHS and "duration_not_deck" not in found:
                    found.append("duration_not_deck")
        if _PRICE_SENTENCE.search(sentence):
            for amount in dollar_amounts(sentence):
                if amount not in _ALLOWED_PRICE_AMOUNTS and "price_not_deck" not in found:
                    found.append("price_not_deck")
    return tuple(found)
