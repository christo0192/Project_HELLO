"""Offline analysis of recorded S0-B learner-harness results (stdlib only).

Reads the JSONL written by ``run.py`` and computes the S0-B exit-criteria
metrics from the RECORDED turns.  It never constructs a DeepSeek client, never
reads an API key and makes no network call.

Usage (from ``app/voice-livekit``; this is the command behind the 2026-10-06
results doc, revision 2)::

    python -m spikes.r1_s0b.analyze spikes/r1_s0b/results/s0b-full-2026-10-06.jsonl \
        spikes/r1_s0b/results/s0b-smoke-2026-10-06.jsonl spikes/r1_s0b/results/s0b-smoke-2026-10-06-v2.jsonl \
        --ttft-segments 1-36,37-71,1-46,47-71,51-71 --run-window-utc 2026-10-06T10:19:35Z,2026-10-06T12:09:35Z \
        --excerpts --json-out OUT.json

Conversation numbers in every output line are 1-based run order ("#1" is the
first conversation in the file).  The first version of this script printed
0-based numbers ("conv0"); add 1 to compare with it.

Harness definitions are imported, not re-implemented: the owed-move scheduler,
``fuzzy_contains`` and the persona/objection/commitment content come from
``scheduler.py`` / ``content.py``; ``PROBE_KEYWORDS``, ``FACT_CONTRADICTIONS``,
``COMMITMENT_RE``, ``CONCESSION_RE``, ``_unlocked`` and ``matrix`` from
``run.py``; ``guard_learner_output`` from ``learner.py``.  ``learner.py``
imports ``httpx`` at module level for its client; if ``httpx`` is not installed
an inert placeholder module is registered so the constants can be imported.
Nothing here calls it.

Core metric definitions (details next to each detector; search "RULE"):

* Families, literal: the recorded advisor/learner turns are replayed through
  ``OwedMoveScheduler`` in run.py's call order (observe_candidate, next_owed,
  record_learner_text).  The replay is checked against every recorded
  ``owed_summary``.  A family passes when all its moves (_family_done) are
  confirmed and each confirmed delivery's ``slip_sec`` (R at delivery minus the
  move's fixed deadline, 105 s per simulated turn) is <= 60 s.
* Owed-line adherence: an episode is one owed move from the turn it is first put
  in the reminder until fuzzy_contains confirms it.  First-attempt = confirmed
  on that first turn.  This isolates what the LLM controls from scheduler gating.
* Volunteering (first disclosure of a deep-need topic, by the marker regexes
  below), reported four ways because the plan names no denominator:
  - harness rule = run.py's SAME-TURN rule: the topic was not unlocked by
    run._unlocked on the disclosing turn.  Structurally ~0: the deep-need text
    reaches the model only in the ephemeral reminder of an unlocked turn.
  - cumulative rule (what version 1 of this script reported as "the harness
    rule"): the topic was never unlocked on this or any earlier turn.
  - same-turn question-gated rule: the disclosing turn must unlock the topic
    AND the advisor turn must contain "?".
  - manual genuine-probe labels (MANUAL_PROBE_LABELS, one analyst's reading of
    each disclosing advisor turn): "probe" / "borderline" / "none".
  Premature first-probe reveal: the disclosure came on the first turn that
  unlocked the topic (the reminder says reveal only if the advisor follows up);
  also reported ignoring the fixed turn-1 opener, which unlocks H2 in every run.
* Correct-unlock proxy: share of (conversation, topic) pairs unlocked on >= 2
  learner turns where the learner disclosed the topic on an unlocked turn.  The
  plan's probe-trigger matrix was not run, so this is a proxy, not the metric.
* Premature commitment: STRONG-level (enrol/pay) or MEDIUM-level (the MEDIUM
  line, or accepting/initiating a call booking) outside the plan's window.
* TTFT and total latency percentiles: linear interpolation (type 7).
* Cache hit %: sum(learner_usage.cache_hit_tokens) / sum(prompt_tokens); the
  harness fills cache_hit_tokens from DeepSeek ``usage.prompt_cache_hit_tokens``
  (falling back to ``prompt_tokens_details.cached_tokens``).
* Raw-file privacy check: counts of written e-mail addresses (and key-like
  strings) in the raw JSONL, never the addresses themselves.  The raw file keeps
  the learner's invented addresses, so it must not be merged (plan section 10.1).

Where the recorded fields cannot support a reliable measurement the report says
so instead of guessing.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime
import json
import math
from pathlib import Path
import re
import statistics
import sys
import types
from typing import Any, Iterable

_VOICE_ROOT = Path(__file__).resolve().parents[2]
if str(_VOICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_VOICE_ROOT))
try:  # learner.py needs httpx only for its live client, which is never used here.
    import httpx  # noqa: F401
except ImportError:  # pragma: no cover - depends on the local environment
    sys.modules["httpx"] = types.ModuleType("httpx")

from spikes.r1_s0b.content import COMMITMENT_LINES, OBJECTION_LINES, PERSONAS  # noqa: E402
from spikes.r1_s0b.learner import guard_learner_output  # noqa: E402
from spikes.r1_s0b.run import (  # noqa: E402
    COMMITMENT_RE,
    CONCESSION_RE,
    FACT_CONTRADICTIONS,
    PROBE_KEYWORDS,
    _unlocked,
    estimate_peak_cost_usd,
    matrix,
)
from spikes.r1_s0b.scheduler import OwedMoveScheduler, fuzzy_contains  # noqa: E402
from spikes.r1_s0b.sim_candidate import ADVERSARIES  # noqa: E402

PERSONA_BY_ID = {persona.id: persona for persona in PERSONAS}
FAMILIES = {
    # Same required moves as OwedMoveScheduler._family_done.
    "F3": ("F3_PRIMARY", "F3_PUSH"),
    "F2": ("F2_PRIMARY", "F2_PUSH"),
    "F1": ("F1_ANCHOR", "F1_COUNTER"),
    "F4": ("F4_PRIMARY", "F4_PUSH"),
}
SLIP_LIMIT_SEC = 60  # plan section 5.6 and scheduler.delivery_summary
COMMITMENT_R_SEC = 540  # plan 5.8 "R >= 9:00"; also run.py's premature threshold

# ---------------------------------------------------------------------------
# Pricing.  RULE: the uncached-input and output prices are the harness's own
# constants (run.estimate_peak_cost_usd: $0.30/M input, $1.20/M output, peak
# Flash).  The cache-hit input price is the value recorded in the earlier
# s0b-results doc from the DeepSeek pricing page ($0.006/M); it was NOT
# re-verified here because this analysis makes no network calls.  All three are
# CLI-overridable, and the no-cache-discount ceiling does not depend on it.
# ---------------------------------------------------------------------------
PRICE_INPUT_MISS_PER_M = 0.30
PRICE_INPUT_HIT_PER_M = 0.006
PRICE_OUTPUT_PER_M = 1.20

# ---------------------------------------------------------------------------
# Deep-need disclosure markers.  RULE: run.py counts a reveal only when the
# whole deep-need sentence appears verbatim (case-insensitive substring,
# including its final full stop), which a paraphrasing LLM almost never
# produces, so the harness's own counters are reported but are not usable.
# Instead a learner turn DISCLOSES topic Hn of its persona when any marker regex
# below matches the learner text.  Markers are distinctive facets of the
# deep-need text in content.py and were chosen so that none of them occurs in
# the learner's public card, surface answers, objection lines or commitment
# lines (instalments are deliberately NOT a marker: the public card's
# "$500-700 a month" answer overlaps it).
# ---------------------------------------------------------------------------
DEEP_NEED_MARKERS: dict[str, dict[str, tuple[str, ...]]] = {
    "P1": {
        "H1": (r"consolidat", r"stagna", r"\bplant\b"),
        "H2": (r"\bquit\b", r"\bgave up\b", r"\b(three|3) weeks\b", r"too old", r"(without|no|lack of|lacked) (any |real )?structure"),
        "H3": (r"\bkids\b", r"\bchildren\b", r"evenings? (and|&) weekends?", r"weekends? only", r"(shared|joint) finances"),
    },
    "P2": {
        "H1": (r"contract (renewal|renews|is up|ends|end)\b", r"\brenewal\b"),
        "H2": (r"(keep|kept|keeps) failing", r"fail(ing|ed)? (the |my |in )?(ml|machine[- ]learning|technical)",
               r"(isn'?t|is not|not) (really )?(working|translating|getting me)"),
        "H3": (r"student loans?",),
    },
    "P3": {
        "H1": (r"passed over", r"internal (ds |data science |data scientist |data )?(role|position|opening|job|promotion)",
               r"ml depth|depth in ml", r"next opening", r"\b(6|six)\s*(-|to|–)\s*(8|eight) months"),
        "H2": (r"repeat\w* (the |a lot of |all )?(sql|basics|stuff i|what i|things i)", r"sql 101", r"basics again", r"restructur",
               r"safe bet", r"(ds|data science) (is|isn'?t|is not|might not be) (a )?safe"),
        "H3": (r"quarter[- ]end", r"pay(ing)? (for (it|this) )?(myself|out of pocket)", r"self[- ]fund", r"my own (money|pocket)"),
    },
    "P4": {
        "H1": (r"\bfunding\b", r"academic (job )?market", r"\bbleak\b", r"\b(8|eight) months\b"),
        "H2": (r"case (round|interview|study)", r"\brejected\b", r"production (ml|machine learning|code|systems?)", r"\boutsider\b",
               r"(lack|missing|don'?t have|no|weak on) (production|sql)"),
        "H3": (r"postdoc (budget|salary|stipend|pay)", r"budget('s| is) (pretty |really |a bit |quite )?tight", r"tight budget", r"\bstipend\b"),
    },
}
_MARKER_RES = {pid: {topic: [re.compile(p, re.I) for p in pats] for topic, pats in topics.items()} for pid, topics in DEEP_NEED_MARKERS.items()}

# ---------------------------------------------------------------------------
# RULE (manual genuine-probe labels): one analyst's reading of the ADVISOR turn
# on which each first deep-need disclosure in s0b-full-2026-10-06.jsonl
# happened.  Key = (1-based conversation number, topic).  "probe" = that turn
# asks about the disclosed topic (H1 why now / dated trigger, H2 doubt or past
# setback, H3 practical constraint); "borderline" = it invites the topic only
# indirectly; "none" = no probe of that topic (a statement, a pitch, a sign-off,
# an adversary line, or a question about something else).  The labels apply
# only to that file; main() checks that the label keys equal the disclosures
# the markers find and reports any mismatch.
# ---------------------------------------------------------------------------
MANUAL_LABELS_FILE = "s0b-full-2026-10-06.jsonl"
MANUAL_PROBE_LABELS: dict[tuple[int, str], tuple[str, str]] = {
    (1, "H3"): ("borderline", "asks for an email and the best time to reach her"),
    (2, "H3"): ("probe", "what does a typical week look like"),
    (6, "H3"): ("probe", "what does a typical week look like"),
    (11, "H1"): ("probe", "what's driving your timeline"),
    (11, "H2"): ("none", "pitch statement, no question"),
    (12, "H1"): ("probe", "what's driving your timeline"),
    (13, "H2"): ("none", "statement about interview prep and cost"),
    (13, "H1"): ("borderline", "asks the decision timeline, not why now"),
    (16, "H3"): ("none", "sign-off: 'thanks again for your time'"),
    (20, "H1"): ("probe", "is there a specific trigger"),
    (25, "H2"): ("none", "curriculum list statement"),
    (26, "H2"): ("none", "pitch statement"),
    (28, "H3"): ("none", "sign-off: 'thanks for your time'"),
    (30, "H1"): ("probe", "what's driving your timeline"),
    (30, "H2"): ("none", "asks the target role"),
    (30, "H3"): ("none", "asks Thursday or Friday for a call"),
    (31, "H1"): ("probe", "how soon are you hoping to switch"),
    (33, "H1"): ("none", "'career-transition support' statement"),
    (35, "H3"): ("none", "sign-off: 'thanks for your time'"),
    (41, "H3"): ("none", "rude adversary line 'waste of time'"),
    (46, "H2"): ("none", "role-inverted product question"),
    (46, "H1"): ("none", "asks for an email and analyst vs scientist"),
    (47, "H2"): ("probe", "biggest gap in your current prep"),
    (48, "H2"): ("none", "asks the target role"),
    (50, "H1"): ("probe", "target role and timeline"),
    (51, "H1"): ("none", "'career-transition support' statement"),
    (52, "H2"): ("none", "asks whether support fits her schedule"),
    (53, "H2"): ("none", "statement about outcomes"),
    (55, "H1"): ("probe", "target timeline for switching"),
    (56, "H2"): ("none", "pricing statement"),
    (56, "H3"): ("borderline", "anything to flag about time and budget constraints"),
    (60, "H2"): ("none", "asks the target role"),
    (60, "H1"): ("probe", "follow-up: what does that longer-term goal look like"),
    (61, "H2"): ("none", "statement about class format"),
    (61, "H3"): ("none", "statement: will flag her budget range"),
    (62, "H2"): ("probe", "biggest concern about making the switch"),
    (63, "H1"): ("none", "pitch statement"),
    (64, "H3"): ("none", "asks what the program should deliver"),
    (64, "H1"): ("probe", "what's driving that timeline"),
    (65, "H1"): ("none", "target-audience statement"),
    (69, "H1"): ("borderline", "asks her biggest worry about switching (an H2-style probe)"),
    (69, "H2"): ("none", "asks which modules to focus on"),
    (69, "H3"): ("none", "sign-off: 'thanks for your time'"),
}

# RULE (premature commitment, plan 5.8): an affirmative commitment by the
# learner at STRONG level (this regex or a fuzzy_contains match of the STRONG
# line) or MEDIUM level (a fuzzy_contains match of the MEDIUM line, or
# CALL_BOOKING_RE: accepting or initiating a call booking).  The harness always
# pre-states the WEAK line, and the plan only permits a non-WEAK commitment once
# all four families are delivered AND R >= 540 s, so every hit outside that
# window is premature.  Agreeing to receive an email is the WEAK stall, not a
# commitment; agreeing to a dated call is the MEDIUM line's substance.
COMMIT_AFFIRM_RE = re.compile(
    r"let'?s do it|sign me up|count me in|i'?m sold|you'?ve convinced me|you have convinced me"
    r"|i'?ll (enrol+|sign up|register|pay (the )?deposit|pay today)"
    r"|send (me )?the (enrol+ment|payment|registration|sign-?up) link"
    r"|i'?m ready to (enrol+|sign up|join|pay|commit)|let'?s (enrol+|get (me )?started)", re.I)
_DAY = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)"
CALL_BOOKING_RE = re.compile(
    r"\b(?:call|chat|meeting)\b[^.?!]{0,40}\b(?:could|would|should|will|can|does) work\b"  # "a quick call this week could work"
    rf"|\b{_DAY}\b[^.?!]{{0,15}}\b(?:works?|is (?:good|fine|great|best)|suits)\b"           # "Thursday works better"
    rf"|\btalk (?:on |again )?{_DAY}\b"                                                       # "talk Thursday"
    r"|\b(?:let'?s|can we|could we|shall we) (?:set|book|schedule|line|lock|pencil)\b"        # "let's set something up"
    r"|\bwhat (?:times?|days?|slots?) (?:do you have|are you free|work|suits?)\b", re.I)
# RULE (premature concession, plan 5.8 "before R >= 9:00 the learner may
# acknowledge a point but never says it is resolved"): explicit resolution or
# price-acceptance phrasing while R < 540 s.  Plain acknowledgements ("that
# makes sense", "fair enough") are allowed by the plan and are not counted.
# COVERAGE: on the harness's 105 s-per-turn clock, R < 540 s is turns 1-5
# only; the same regex is therefore also run on every turn for information.
CONCESSION_PLAN_RE = re.compile(
    r"convinc|that (resolves|settles|addresses)|(resolves|addresses) my (concern|worry|question)"
    r"|no (more|other) (concerns|worries)|i'?m (sold|on board)"
    r"|(price|cost|\$ ?9,?000) (is|'s|sounds) (fine|okay|ok|reasonable|fair|worth it)"
    r"|(?<!whether )(?<!if )\b(it'?s|that'?s|it is|that is|sounds|seems) (definitely |totally |really )?worth (it|every penny|the money|the price)"
    r"|you'?ve (answered|addressed) (all|everything)", re.I)
# RULE (emitted leak, plan 5.3): the harness guard re-applied to the EMITTED
# (post-guard) learner text must find nothing, and the emitted text must not
# match these meta/control patterns (AI identity, prompts, instructions,
# role-play/test framing, reminder internals).
META_LEAK_RE = re.compile(
    r"\b(ai|a\.i\.|bot|chatbot|robot|language model|simulat\w*|role-?play|this test|the test|interviewer|instruction\w*"
    r"|system( prompt)?|prompt|reminder|unlock\w*|persona|hidden needs?|rubric|r_clock\w*|mode=\w*|owed move)\b", re.I)
# RULE (unapproved product-fact assertion; learner prefix "Never state product
# facts"): a declarative learner sentence (not ending in "?") that states the
# delivery format or class timing/weekly hours, all of which are TODO_D2 facts
# (PRODUCT_FACT_RES); OR a hedged declarative answer ("I think it's ...") to an
# advisor question about the product (PRODUCT_QUESTION_RE), which is how the
# role-inverted advisor turns elicited product claims.
PRODUCT_FACT_RES = (
    re.compile(r"^(?:i think |i believe |i heard )?(?:it'?s |it is |they'?re |they are |(?:the )?classes are |(?:the )?sessions are |the (?:course|program) is )?"
               r"(?:mostly |all |fully |partly |usually |entirely )?(?:live|recorded)\b", re.I),
    re.compile(r"\blive (?:sessions|classes) (?:plus|with|and) record", re.I),
    re.compile(r"^(?:the )?(?:classes|sessions) (?:are|run|happen) (?:on |in the )?(?:evenings|weekends|weekdays)", re.I),
    re.compile(r"^(?:it'?s|the (?:course|program) (?:is|takes|needs|requires)|it (?:takes|needs|requires)|(?:the )?classes are)[^.]*\b\d+\s*(?:-|to|–)\s*\d+\s*hours", re.I),
)
PRODUCT_QUESTION_RE = re.compile(
    r"\b(?:does|do|is|are|will)\s+(?:the|it|this|they)\b[^?]*\b(?:program|course|curriculum|capstone|career support|support|placement"
    r"|class(?:es)?|sessions?|modules?|instructors?|six months|cohort|projects?|recorded|live|hours)\b[^?]*\?", re.I)
HEDGED_DECLARATIVE_RE = re.compile(r"^\W*(?:i think|i believe|i heard|i'?m pretty sure|probably|mostly|mainly|it'?s|it is|they'?re|they are)\b", re.I)
# RULE (off-card fabrication): the learner spells out an e-mail address (written
# or spoken, e.g. "name dot surname at gmail") or a phone number.  The public
# card has neither, and says anything not on it gets "I'm not sure, I haven't
# thought about that."  The same regex masks contact details in all excerpts.
CONTACT_RE = re.compile(
    r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"
    r"|\b\w+(?: dot \w+)* at (?:gmail|yahoo|outlook|hotmail|icloud|proton\w*|example|email)(?: dot (?:com|net|org|edu|io))?\b"
    r"|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b", re.I)
# RULE (off-card fabrication, availability): the learner states her own weekly
# hours (the card has no availability answer, so the rule is "I'm not sure"),
# in a sentence that is not already a product-fact assertion.  The stated
# figure is kept so replays of the same persona can be compared (plan 5.13).
_NUM = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)"
WEEKLY_HOURS_RE = re.compile(rf"\b({_NUM}(?:\s*(?:-|to|–)\s*{_NUM})?)\s*hours?\s*(?:a|per|each)\s*week\b", re.I)
# RULE (card inconsistency, timeline): the card says the DECISION timeline is
# "within a couple of weeks" and success is "a data role within a year".  A
# learner answer of "a couple of weeks" (without "decide/decision") to an
# advisor question about switching/moving/landing a role conflates the two.
# Detector hits are listed for manual review; some are ambiguous.
CARD_TIMELINE_LEARNER_RE = re.compile(r"couple of weeks", re.I)
CARD_TIMELINE_EXCUSE_RE = re.compile(r"decid|decision", re.I)
CARD_TIMELINE_QUESTION_RE = re.compile(r"\b(?:switch\w*|move|moving|transition\w*|land\w*|role)\b", re.I)
# RULE (card-fact contradiction): any dollar amount the learner states must be
# one of the card/objection amounts (9,000; 7,000; 500; 700) or an amount the
# advisor already stated in this conversation; a stated age must equal the
# persona age; a stated lead source must be a webinar.
ALLOWED_AMOUNTS = {9000, 7000, 500, 700}
DOLLAR_RE = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?", re.I)
AGE_RE = re.compile(r"\bi'?m (\d{2})\b(?! (?:hours|months|weeks|days|percent|%))|\b(\d{2}) years old\b", re.I)
SOURCE_RE = re.compile(r"\b(?:heard|learned|found out) (?:about|of) (?:you|it|this|the course|the program|interview kickstart|ik)\b[^.?!]*?\b(?:from|through|via|on) (?!(?:a |the )?webinar)(\w+)", re.I)
# Post-close turns: the simulated advisor has started signing off.  RULE: the
# cumulative share counts every learner turn at or after the first advisor turn
# that matches; the per-turn share (version 1's figure) counts only advisor
# turns that themselves match.  The wide variant also treats "thanks for your
# time" as a sign-off.
SIGN_OFF_RE = re.compile(r"\b(take care|talk soon|good ?bye|bye)\b", re.I)
SIGN_OFF_WIDE_RE = re.compile(r"\b(take care|talk soon|good ?bye|bye)\b|\bthanks?(?: you)?(?: again)? for your time\b", re.I)
# RULE (simulated-advisor role inversion, harness-quality estimate only): the
# advisor turn repeats a learner scripted line (fuzzy_contains against the
# objection/commitment lines), speaks from the learner's position, gives the
# learner card's vague answer, or asks the learner a product question.  The
# heuristic still undercounts; it is reported as a lower bound, never as a
# learner metric.  Probable cause: sim_candidate.next_turn passes the
# learner-side history (advisor="user", learner="assistant") without swapping roles.
ADVISOR_INVERSION_RE = re.compile(
    r"\b(my (job|schedule|husband|partner|father|kids|postdoc|funding|budget)|i'?ve got to (jump|run)|i'?d rather not (give|share)"
    r"|i have a few years of|i'?m a career-changer|can'?t (really )?commit (to a call|(six|6) months)|just email me|email me (once|when|the)"
    r"|let me think (about it|it over)|i'?ll be in touch if|i'?m not sure, i haven'?t thought about that|since i work full[- ]time"
    r"|does the (curriculum|career support|six months|program|course) (cover|include))\b", re.I)
# Q-A/Q-B are excluded because an advisor may legitimately restate them.
LEARNER_LINES = tuple(text for key, text in OBJECTION_LINES.items() if key.startswith("F")) + (COMMITMENT_LINES["STRONG"], COMMITMENT_LINES["WEAK"])


def percentile(values: Iterable[float], fraction: float) -> float | None:
    """RULE: linear interpolation between closest ranks (Hyndman-Fan type 7, numpy default)."""
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def ratio(numerator: float, denominator: float) -> float | None:
    return None if not denominator else numerator / denominator


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return None if not sxx or not syy else sxy / math.sqrt(sxx * syy)


def mask(text: str, limit: int = 150) -> str:
    text = CONTACT_RE.sub("[contact]", text.replace("\n", " "))
    return text if len(text) <= limit else text[: limit - 1] + "…"


# RULE (raw-file privacy check, plan section 10.1 "only result docs merged"): the
# raw run.py JSONL keeps the learner's invented e-mail addresses verbatim (run.py's
# redact_text strips only keys).  Counts only; an address is never printed.
WRITTEN_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
KEY_LIKE_RE = re.compile(r"\bsk-[A-Za-z0-9]{16,}|\bBearer\s+\S{8,}|\bAuthorization\b", re.I)


def raw_file_privacy_counts(text: str) -> dict[str, int]:
    written = [match.lower() for match in WRITTEN_EMAIL_RE.findall(text)]
    return {
        "written_address_occurrences": len(written),
        "written_address_distinct": len(set(written)),
        "written_gmail_com_occurrences": sum(address.endswith("@gmail.com") for address in written),
        "key_like_strings": len(KEY_LIKE_RE.findall(text)),
    }


def sentences(text: str) -> list[str]:
    return [part.strip() for part in re.findall(r"[^.!?]+[.!?]?", text) if part.strip()]


def disclosed_topics(persona_id: str, text: str) -> set[str]:
    return {topic for topic, patterns in _MARKER_RES[persona_id].items() if any(p.search(text) for p in patterns)}


def dollar_amounts(text: str) -> list[float]:
    amounts = []
    for number, thousands in DOLLAR_RE.findall(text):
        try:
            value = float(number.replace(",", ""))
        except ValueError:
            continue
        amounts.append(value * 1000 if thousands else value)
    return amounts


def load_conversations(path: Path) -> list[list[dict[str, Any]]]:
    conversations: list[list[dict[str, Any]]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row["turn"] == 1 or not conversations:
                conversations.append([])
            conversations[-1].append(row)
    return conversations


def analyse_conversation(index: int, turns: list[dict[str, Any]], labels: dict[tuple[int, str], tuple[str, str]] | None = None) -> dict[str, Any]:
    """``index`` is 0-based; every reported conversation number is ``index + 1``."""
    number = index + 1
    labels = labels or {}
    meta = turns[0]["conversation"]
    persona = PERSONA_BY_ID[meta["persona"]]
    scheduler = OwedMoveScheduler(persona)
    owed_log: list[dict[str, Any]] = []
    episodes: dict[str, dict[str, Any]] = {}
    ever_unlocked: set[str] = set()
    ever_unlocked_q: set[str] = set()
    first_unlock_turn: dict[str, int] = {}
    first_unlock_turn_after_opener: dict[str, int] = {}
    disclosed_first: dict[str, dict[str, Any]] = {}
    unlock_turns: Counter[str] = Counter()
    unlock_turns_q: Counter[str] = Counter()
    reveal_on_unlock: set[str] = set()
    harness_volunteered = harness_correct = harness_opportunities = 0
    advisor_amounts: set[float] = set()
    findings: dict[str, list[dict[str, Any]]] = defaultdict(list)
    sign_off_turns = 0
    first_sign_off = first_sign_off_wide = None
    # One cell per (turn, topic) that was unlocked this turn and not yet disclosed.
    reveal_cells: list[dict[str, Any]] = []

    for row in turns:
        advisor, learner, turn = row["advisor_text"], row["learner_text"], row["turn"]
        # --- scheduler replay (exactly run.run_conversation's call order) ---
        scheduler.observe_candidate(advisor)
        owed = scheduler.next_owed()
        delivery = scheduler.record_learner_text(learner) if owed else None
        if owed:
            episode = episodes.setdefault(f"{owed.id}@{owed.opened_at_sec}", {"move": owed.id, "first_turn": turn, "confirmed_turn": None, "attempts": 0, "guarded_misses": 0})
            episode["attempts"] += 1
            if delivery and delivery.confirmed:
                episode["confirmed_turn"] = turn
                episode["slip_sec"] = delivery.slip_sec
            elif row["learner_raw_guarded"]:
                # The guard replaced the whole reply, so the owed line could not survive.
                episode["guarded_misses"] += 1
            owed_log.append({"turn": turn, "move": owed.id, "confirmed": bool(delivery and delivery.confirmed)})
        if ADVISOR_INVERSION_RE.search(advisor) or any(fuzzy_contains(advisor, line.format(decision_maker=persona.decision_maker)) for line in LEARNER_LINES):
            findings["advisor_role_inversion"].append({"turn": turn, "excerpt": mask(advisor, 110)})
        r_seconds = scheduler.r_seconds
        families_done = all(scheduler._family_done(f) for f in FAMILIES)  # noqa: SLF001 - harness definition

        # --- unlocks: harness rule (run._unlocked on the current advisor turn) ---
        unlocked = set(_unlocked(persona, advisor))
        unlocked_q = unlocked if "?" in advisor else set()
        harness_opportunities += len(unlocked)
        for topic in unlocked:
            first_unlock_turn.setdefault(topic, turn)
            if turn > 1:
                first_unlock_turn_after_opener.setdefault(topic, turn)
        for topic, need in persona.deep_needs.items():  # run.py's literal rule, reproduced for comparison
            if need.lower() in learner.lower():
                if topic in unlocked:
                    harness_correct += 1
                else:
                    harness_volunteered += 1
        for topic in unlocked:
            unlock_turns[topic] += 1
        for topic in unlocked_q:
            unlock_turns_q[topic] += 1
        topics = disclosed_topics(persona.id, learner)
        # RULE (reveal crowding, diagnostic only): for each topic unlocked this
        # turn and not yet disclosed, record whether an owed line was also
        # scheduled this turn, whether the learner disclosed it now, the turn
        # number, and whether this is the topic's first unlocking turn.
        for topic in sorted(unlocked - set(disclosed_first)):
            reveal_cells.append({"turn": turn, "topic": topic, "owed": owed is not None, "revealed": topic in topics,
                                 "first_unlock": first_unlock_turn.get(topic) == turn})
        for topic in topics:
            if topic in unlocked:
                reveal_on_unlock.add(topic)
            if topic not in disclosed_first:
                label = labels.get((number, topic))
                disclosed_first[topic] = {
                    "turn": turn,
                    "same_turn_unlocked": topic in unlocked,
                    "ever_unlocked": topic in unlocked or topic in ever_unlocked,
                    "same_turn_unlocked_q": topic in unlocked_q,
                    "ever_unlocked_q": topic in unlocked_q or topic in ever_unlocked_q,
                    "first_unlock_reveal": topic in unlocked and first_unlock_turn.get(topic) == turn,
                    "first_unlock_reveal_after_opener": topic in unlocked and first_unlock_turn_after_opener.get(topic) == turn,
                    "owed_this_turn": owed.id if owed else None,
                    "manual_label": label[0] if label else None,
                    "manual_note": label[1] if label else None,
                    "advisor": mask(advisor, 120),
                    "excerpt": mask(learner),
                }
        ever_unlocked |= unlocked
        ever_unlocked_q |= unlocked_q

        # --- commitment / concession ---
        strong = fuzzy_contains(learner, COMMITMENT_LINES["STRONG"]) or bool(COMMIT_AFFIRM_RE.search(learner))
        medium_line = fuzzy_contains(learner, COMMITMENT_LINES["MEDIUM"].format(decision_maker=persona.decision_maker))
        call_booking = CALL_BOOKING_RE.search(learner)
        if strong or medium_line or call_booking:
            permitted = families_done and r_seconds >= COMMITMENT_R_SEC
            level = "STRONG" if strong else "MEDIUM"
            kind = "enrol_or_pay" if strong else ("medium_line" if medium_line else f"call_booking:{call_booking.group(0)}")
            findings["commitment"].append({"turn": turn, "level": level, "kind": kind, "r_sec": r_seconds, "families_done": families_done,
                                           "permitted_by_plan": permitted, "advisor": mask(advisor, 110), "excerpt": mask(learner)})
        if r_seconds < COMMITMENT_R_SEC and CONCESSION_PLAN_RE.search(learner):
            findings["concession"].append({"turn": turn, "excerpt": mask(learner)})
        if CONCESSION_PLAN_RE.search(learner):
            findings["concession_any_turn"].append({"turn": turn, "r_sec": r_seconds, "excerpt": mask(learner)})
        if r_seconds < COMMITMENT_R_SEC and (COMMITMENT_RE.search(learner) or "let's do it" in learner.lower()):
            findings["harness_commitment_re"].append({"turn": turn, "excerpt": mask(learner)})
        if r_seconds < COMMITMENT_R_SEC and CONCESSION_RE.search(learner):
            findings["harness_concession_re"].append({"turn": turn, "excerpt": mask(learner)})

        # --- leaks ---
        if row["learner_raw_guarded"]:
            # The raw (pre-guard) text is not recorded, so the matched term is
            # unknown; record whether the advisor turn itself contained a guard
            # term (an echo would be a false-positive guard hit, not a leak).
            _, advisor_terms = guard_learner_output(advisor)
            findings["raw_guard_hit"].append({"turn": turn, "owed": owed.id if owed else None, "advisor_guard_terms": advisor_terms, "advisor": mask(advisor, 90)})
        _, emitted_hits = guard_learner_output(learner)
        meta_hit = META_LEAK_RE.search(learner)
        if emitted_hits or meta_hit:
            findings["emitted_leak"].append({"turn": turn, "terms": emitted_hits or [meta_hit.group(0)], "excerpt": mask(learner)})

        # --- facts ---
        for term in FACT_CONTRADICTIONS:
            if term in learner.lower():
                findings["harness_fact_learner"].append({"turn": turn, "term": term, "excerpt": mask(learner)})
            if term in advisor.lower():
                findings["harness_fact_advisor"].append({"turn": turn, "term": term})
        advisor_amounts.update(dollar_amounts(advisor))
        for amount in dollar_amounts(learner):
            if amount not in ALLOWED_AMOUNTS and amount not in advisor_amounts:
                findings["card_contradiction"].append({"turn": turn, "kind": "amount", "excerpt": mask(learner)})
        for match in AGE_RE.finditer(learner):
            age = int(match.group(1) or match.group(2))
            if age != persona.age:
                findings["card_contradiction"].append({"turn": turn, "kind": "age", "excerpt": mask(learner)})
        if SOURCE_RE.search(learner):
            findings["card_contradiction"].append({"turn": turn, "kind": "lead_source", "excerpt": mask(learner)})
        learner_sentences = sentences(learner)
        advisor_questions = [s for s in sentences(advisor) if s.endswith("?")]
        product_sentences = [s for s in learner_sentences if not s.endswith("?") and any(rx.search(s) for rx in PRODUCT_FACT_RES)]
        if product_sentences:
            findings["product_fact"].append({"turn": turn, "kind": "format_or_hours", "excerpt": mask(learner)})
        elif (learner_sentences and not learner_sentences[0].endswith("?") and HEDGED_DECLARATIVE_RE.search(learner_sentences[0])
              and any(PRODUCT_QUESTION_RE.search(q) for q in advisor_questions)):
            findings["product_fact"].append({"turn": turn, "kind": "answer_to_advisor_product_question", "advisor": mask(advisor, 110), "excerpt": mask(learner)})
        for sentence in learner_sentences:
            hours = WEEKLY_HOURS_RE.search(sentence)
            if hours and not sentence.endswith("?") and sentence not in product_sentences:
                findings["invented_availability"].append({"turn": turn, "hours": hours.group(1).lower(), "excerpt": mask(learner)})
                break
        if (CARD_TIMELINE_LEARNER_RE.search(learner) and not CARD_TIMELINE_EXCUSE_RE.search(learner)
                and any(CARD_TIMELINE_QUESTION_RE.search(q) for q in advisor_questions)):
            findings["card_timeline_conflation"].append({"turn": turn, "advisor": mask(advisor_questions[-1], 110), "excerpt": mask(learner)})
        if CONTACT_RE.search(learner):
            findings["contact_fabrication"].append({"turn": turn, "spoken_form": "@" not in learner, "excerpt": mask(learner)})
        if SIGN_OFF_RE.search(advisor):
            sign_off_turns += 1
            first_sign_off = first_sign_off or turn
        if SIGN_OFF_WIDE_RE.search(advisor):
            first_sign_off_wide = first_sign_off_wide or turn

    # --- family delivery ---
    delivered = {item.move.id: item for item in scheduler.delivered if item.confirmed}
    family_status: dict[str, dict[str, Any]] = {}
    for family, moves in FAMILIES.items():
        ever_owed = [m for m in moves if any(entry["move"] == m for entry in owed_log)]
        all_confirmed = all(m in delivered for m in moves)
        literal_on_time = all_confirmed and all(delivered[m].slip_sec <= SLIP_LIMIT_SEC for m in moves)
        lags = [e["confirmed_turn"] - e["first_turn"] for e in episodes.values() if e["move"] in moves and e["confirmed_turn"] is not None]
        if all_confirmed:
            cause = "delivered"
        elif len(ever_owed) < len(moves) and not any(e["move"] in moves and e["confirmed_turn"] is None for e in episodes.values()):
            cause = "never_owed_by_scheduler"
        else:
            cause = "owed_not_confirmed"
        family_status[family] = {
            "delivered": all_confirmed,
            "within_slip_literal": literal_on_time,
            "lag0": all_confirmed and all(lag == 0 for lag in lags),
            "max_slip_sec": max((delivered[m].slip_sec for m in moves if m in delivered), default=None),
            "cause": cause,
            "missing_moves": [m for m in moves if m not in delivered],
        }
    # RULE (F4 blocker): why F4 never opened.  F4_PRIMARY needs F1 complete AND
    # (Q-B done or projects covered) AND candidate_turns_after["Q-B"] >= 2; the
    # last count only accrues after Q-B is DELIVERED, so a skipped Q-B blocks it.
    if scheduler._family_done("F4"):  # noqa: SLF001
        f4_blocker = "delivered"
    elif not scheduler._family_done("F1"):  # noqa: SLF001
        f4_blocker = "F1_incomplete"
    elif scheduler.covered_projects and not scheduler._done("Q-B"):  # noqa: SLF001
        f4_blocker = "QB_skipped_as_covered"
    else:
        f4_blocker = "other"

    recorded = turns[-1].get("conversation_summary", {})
    replay_summary = scheduler.delivery_summary()
    usage_l = [row["learner_usage"] for row in turns]
    usage_a = [row["next_advisor_usage"] for row in turns if row.get("next_advisor_usage")]
    n_turns = len(turns)
    return {
        "index": index,
        "number": number,
        "persona": meta["persona"],
        "tier": meta["tier"],
        "adversary": meta["adversary"] or "baseline",
        "complete": len(turns) == 18 and [r["turn"] for r in turns] == list(range(1, 19)) and bool(recorded),
        "replay_matches_recorded": replay_summary == recorded.get("owed_summary"),
        "ttft": [row["learner_ttft_seconds"] for row in turns if row["learner_ttft_seconds"] is not None],
        "ttft_prompt_cache": [(row["learner_ttft_seconds"], row["learner_usage"]["prompt_tokens"] or 0, row["learner_usage"]["cache_hit_tokens"] or 0)
                              for row in turns if row["learner_ttft_seconds"] is not None],
        "latency": [row["learner_total_latency_seconds"] for row in turns],
        "generation": [row["learner_total_latency_seconds"] - row["learner_ttft_seconds"] for row in turns if row["learner_ttft_seconds"] is not None],
        "learner_models": Counter(row["learner_model"] for row in turns),
        "learner_prompt": sum(u.get("prompt_tokens") or 0 for u in usage_l),
        "learner_prompt_per_call": [u.get("prompt_tokens") or 0 for u in usage_l],
        "learner_hit": sum(u.get("cache_hit_tokens") or 0 for u in usage_l),
        "learner_completion": sum(u.get("completion_tokens") or 0 for u in usage_l),
        "learner_reasoning_tokens_reported": sum(u.get("reasoning_tokens") is not None for u in usage_l),
        "learner_reasoning_chunks": sum(u.get("reasoning_content_chunks") or 0 for u in usage_l),
        "advisor_calls": len(usage_a),
        "advisor_prompt": sum(u.get("prompt_tokens") or 0 for u in usage_a),
        "advisor_hit": sum(u.get("cache_hit_tokens") or 0 for u in usage_a),
        "advisor_completion": sum(u.get("completion_tokens") or 0 for u in usage_a),
        "advisor_reasoning_tokens_reported": sum(u.get("reasoning_tokens") is not None for u in usage_a),
        "advisor_reasoning_chunks": sum(u.get("reasoning_content_chunks") or 0 for u in usage_a),
        "per_turn_usage": [(row["turn"], row["learner_usage"]["prompt_tokens"] or 0, row["learner_usage"]["cache_hit_tokens"] or 0) for row in turns],
        "owed_log": owed_log,
        "episodes": list(episodes.values()),
        "families": family_status,
        "f4_blocker": f4_blocker,
        "disclosures": disclosed_first,
        "unlock_turns": dict(unlock_turns),
        "unlock_turns_q": dict(unlock_turns_q),
        "turn1_unlocked": sorted(_unlocked(persona, turns[0]["advisor_text"])),
        "reveal_on_unlock": sorted(reveal_on_unlock),
        "harness_volunteered": harness_volunteered,
        "harness_correct": harness_correct,
        "harness_opportunities": harness_opportunities,
        "findings": {key: value for key, value in findings.items()},
        "sign_off_turns": sign_off_turns,
        "turns_from_first_sign_off": 0 if first_sign_off is None else n_turns - first_sign_off + 1,
        "turns_from_first_sign_off_wide": 0 if first_sign_off_wide is None else n_turns - first_sign_off_wide + 1,
        "reveal_cells": reveal_cells,
        "turns_before_commitment_cutoff": sum(t * 105 < COMMITMENT_R_SEC for t in range(1, n_turns + 1)),
        "turn3_advisor": turns[2]["advisor_text"] if len(turns) > 2 else None,
        "turn3_learner": turns[2]["learner_text"] if len(turns) > 2 else None,
        "turn4_learner": turns[3]["learner_text"] if len(turns) > 3 else None,
    }


def summarise(convs: list[dict[str, Any]], prices: dict[str, float]) -> dict[str, Any]:
    ttft = [x for c in convs for x in c["ttft"]]
    latency = [x for c in convs for x in c["latency"]]
    n = len(convs)
    turns = sum(len(c["latency"]) for c in convs)
    lp, lh, lc = (sum(c[k] for c in convs) for k in ("learner_prompt", "learner_hit", "learner_completion"))
    ap, ah, ac = (sum(c[k] for c in convs) for k in ("advisor_prompt", "advisor_hit", "advisor_completion"))

    def cost(prompt: int, hit: int, completion: int, discounted: bool) -> float:
        miss = prompt - hit if discounted else prompt
        hit_cost = hit * prices["hit"] / 1e6 if discounted else 0.0
        return miss * prices["miss"] / 1e6 + hit_cost + completion * prices["output"] / 1e6

    episodes = [e for c in convs for e in c["episodes"]]
    family_eps = [e for e in episodes if any(e["move"] in moves for moves in FAMILIES.values())]
    disclosures = [d for c in convs for d in c["disclosures"].values()]
    opportunities_q = [(c, t) for c in convs for t, k in c["unlock_turns_q"].items() if k >= 2]
    opportunities = [(c, t) for c in convs for t, k in c["unlock_turns"].items() if k >= 2]
    f = lambda key: sum(len(c["findings"].get(key, [])) for c in convs)  # noqa: E731
    fc = lambda key: sum(bool(c["findings"].get(key)) for c in convs)  # noqa: E731
    commitments = [x for c in convs for x in c["findings"].get("commitment", [])]
    cells = [cell for c in convs for cell in c["reveal_cells"]]
    manual = Counter(d["manual_label"] for d in disclosures)

    def cell_rate(selected: list[dict[str, Any]]) -> dict[str, Any]:
        return {"revealed": sum(x["revealed"] for x in selected), "cells": len(selected),
                "rate": ratio(sum(x["revealed"] for x in selected), len(selected)),
                "mean_turn": statistics.fmean(x["turn"] for x in selected) if selected else None}

    return {
        "conversations": n,
        "learner_turns": turns,
        "ttft_p50": percentile(ttft, 0.50), "ttft_p95": percentile(ttft, 0.95),
        "ttft_min": percentile(ttft, 0.0), "ttft_share_le_1s": ratio(sum(x <= 1.0 for x in ttft), len(ttft)),
        "ttft_share_le_2s": ratio(sum(x <= 2.0 for x in ttft), len(ttft)),
        "latency_p50": percentile(latency, 0.50), "latency_p95": percentile(latency, 0.95),
        "learner_cache_hit_pct": ratio(lh, lp), "advisor_cache_hit_pct": ratio(ah, ap),
        "learner_prompt_tokens_per_call_min": min((p for c in convs for p in c["learner_prompt_per_call"]), default=None),
        "learner_prompt_tokens_per_call_max": max((p for c in convs for p in c["learner_prompt_per_call"]), default=None),
        "learner_prompt_tokens_per_call_mean": ratio(lp, turns),
        "tokens": {"learner_prompt": lp, "learner_cache_hit": lh, "learner_completion": lc,
                   "advisor_prompt": ap, "advisor_cache_hit": ah, "advisor_completion": ac},
        "cost_usd": {
            "learner_ceiling_no_cache_discount": cost(lp, lh, lc, False),
            "learner_with_cache_discount": cost(lp, lh, lc, True),
            "advisor_sim_ceiling_no_cache_discount": cost(ap, ah, ac, False),
            "advisor_sim_with_cache_discount": cost(ap, ah, ac, True),
        },
        "families_all4_within_slip_literal": ratio(sum(all(s["within_slip_literal"] for s in c["families"].values()) for c in convs), n),
        "families_all4_delivered_any_time": ratio(sum(all(s["delivered"] for s in c["families"].values()) for c in convs), n),
        "family_delivered_rate": {fam: ratio(sum(c["families"][fam]["delivered"] for c in convs), n) for fam in FAMILIES},
        "family_within_slip_literal_rate": {fam: ratio(sum(c["families"][fam]["within_slip_literal"] for c in convs), n) for fam in FAMILIES},
        "family_cause": {fam: dict(Counter(c["families"][fam]["cause"] for c in convs)) for fam in FAMILIES},
        "f4_blocker": dict(Counter(c["f4_blocker"] for c in convs)),
        "owed_episodes": len(episodes),
        "owed_first_attempt_rate": ratio(sum(e["confirmed_turn"] == e["first_turn"] for e in episodes), len(episodes)),
        "owed_eventually_confirmed_rate": ratio(sum(e["confirmed_turn"] is not None for e in episodes), len(episodes)),
        "family_move_first_attempt_rate": ratio(sum(e["confirmed_turn"] == e["first_turn"] for e in family_eps), len(family_eps)),
        "family_moves_owed": len(family_eps),
        "owed_turn_attempts": sum(e["attempts"] for e in episodes),
        "owed_first_attempt_misses": sum(e["confirmed_turn"] != e["first_turn"] for e in episodes),
        "owed_misses_on_guarded_turns": sum(e["guarded_misses"] for e in episodes),
        "owed_episodes_delayed_by_guard": sum(e["guarded_misses"] > 0 for e in episodes),
        "owed_first_attempt_rate_excl_guard_delays": ratio(sum(e["confirmed_turn"] == e["first_turn"] for e in episodes),
                                                           sum(e["guarded_misses"] == 0 for e in episodes)),
        "disclosures_first": len(disclosures),
        # Volunteering, four definitions (see the module docstring).
        "volunteered_harness_same_turn": sum(not d["same_turn_unlocked"] for d in disclosures),
        "volunteered_cumulative": sum(not d["ever_unlocked"] for d in disclosures),
        "volunteered_same_turn_q": sum(not d["same_turn_unlocked_q"] for d in disclosures),
        "volunteered_cumulative_q": sum(not d["ever_unlocked_q"] for d in disclosures),
        "volunteering_rate_same_turn_q": ratio(sum(not d["same_turn_unlocked_q"] for d in disclosures), len(disclosures)),
        "volunteering_rate_cumulative_q": ratio(sum(not d["ever_unlocked_q"] for d in disclosures), len(disclosures)),
        "conversations_with_volunteered_same_turn_q": sum(any(not d["same_turn_unlocked_q"] for d in c["disclosures"].values()) for c in convs),
        "conversations_with_volunteered_cumulative_q": sum(any(not d["ever_unlocked_q"] for d in c["disclosures"].values()) for c in convs),
        "manual_labels": {"probe": manual.get("probe", 0), "borderline": manual.get("borderline", 0), "none": manual.get("none", 0),
                          "unlabelled": manual.get(None, 0)},
        "volunteering_rate_manual_none": ratio(manual.get("none", 0), len(disclosures)),
        "volunteering_rate_manual_none_or_borderline": ratio(manual.get("none", 0) + manual.get("borderline", 0), len(disclosures)),
        "conversations_with_manual_unprobed_reveal": sum(any(d["manual_label"] == "none" for d in c["disclosures"].values()) for c in convs),
        "first_unlock_turn_reveals": sum(d["first_unlock_reveal"] for d in disclosures),
        "first_unlock_turn_reveals_ignoring_opener": sum(d["first_unlock_reveal_after_opener"] for d in disclosures),
        "conversations_where_turn1_opener_unlocks": dict(Counter(t for c in convs for t in c["turn1_unlocked"])),
        "unlock_proxy_opportunities": len(opportunities),
        "unlock_proxy_rate": ratio(sum(t in c["reveal_on_unlock"] for c, t in opportunities), len(opportunities)),
        "unlock_proxy_opportunities_q": len(opportunities_q),
        "unlock_proxy_rate_q": ratio(sum(t in c["reveal_on_unlock"] for c, t in opportunities_q), len(opportunities_q)),
        "harness_volunteered": sum(c["harness_volunteered"] for c in convs),
        "harness_correct_unlocks": sum(c["harness_correct"] for c in convs),
        "harness_unlock_opportunities": sum(c["harness_opportunities"] for c in convs),
        "premature_commitments": sum(not x["permitted_by_plan"] for x in commitments),
        "conversations_with_premature_commitment": sum(any(not x["permitted_by_plan"] for x in c["findings"].get("commitment", [])) for c in convs),
        "commitments_any": len(commitments),
        "commitment_levels": dict(Counter(x["level"] for x in commitments)),
        "premature_concessions": f("concession"),
        "concession_check_turns": sum(c["turns_before_commitment_cutoff"] for c in convs),
        "concession_regex_hits_any_turn": f("concession_any_turn"),
        "harness_commitment_re_hits": f("harness_commitment_re"),
        "harness_concession_re_hits": f("harness_concession_re"),
        "raw_guard_hits": f("raw_guard_hit"), "conversations_with_guard_hit": fc("raw_guard_hit"),
        "conversations_with_ge3_guard_hits": sum(len(c["findings"].get("raw_guard_hit", [])) >= 3 for c in convs),
        "emitted_leaks": f("emitted_leak"),
        "harness_fact_learner": f("harness_fact_learner"), "harness_fact_advisor": f("harness_fact_advisor"),
        "card_contradictions": f("card_contradiction"),
        "card_timeline_conflations": f("card_timeline_conflation"), "conversations_with_card_timeline_conflation": fc("card_timeline_conflation"),
        "product_fact_assertions": f("product_fact"), "conversations_with_product_fact": fc("product_fact"),
        "contact_fabrications": f("contact_fabrication"), "conversations_with_contact_fabrication": fc("contact_fabrication"),
        "contact_fabrications_spoken_form": sum(x["spoken_form"] for c in convs for x in c["findings"].get("contact_fabrication", [])),
        # What version 1's "@"-only detector could see: written addresses only.
        "contact_fabrications_written_form": sum(not x["spoken_form"] for c in convs for x in c["findings"].get("contact_fabrication", [])),
        "conversations_with_written_form_contact_fabrication": sum(any(not x["spoken_form"] for x in c["findings"].get("contact_fabrication", [])) for c in convs),
        "invented_availability_turns": f("invented_availability"), "conversations_with_invented_availability": fc("invented_availability"),
        "sign_off_turn_share_per_turn": ratio(sum(c["sign_off_turns"] for c in convs), turns),
        "sign_off_turn_share_cumulative": ratio(sum(c["turns_from_first_sign_off"] for c in convs), turns),
        "sign_off_turn_share_cumulative_wide": ratio(sum(c["turns_from_first_sign_off_wide"] for c in convs), turns),
        "advisor_role_inversion_turns_est": f("advisor_role_inversion"),
        "conversations_with_advisor_role_inversion_est": fc("advisor_role_inversion"),
        "guarded_turns_after_advisor_guard_term": sum(bool(x["advisor_guard_terms"]) for c in convs for x in c["findings"].get("raw_guard_hit", [])),
        "reveal_cells_with_owed_line": cell_rate([x for x in cells if x["owed"]]),
        "reveal_cells_without_owed_line": cell_rate([x for x in cells if not x["owed"]]),
        "reveal_cells_first_unlock_with_owed_line": cell_rate([x for x in cells if x["owed"] and x["first_unlock"]]),
        "reveal_cells_first_unlock_without_owed_line": cell_rate([x for x in cells if not x["owed"] and x["first_unlock"]]),
        "first_disclosures_by_owed_and_manual_label": {f"owed={owed},label={label}": k for (owed, label), k in sorted(
            Counter((d["owed_this_turn"] is not None, d["manual_label"]) for d in disclosures).items(), key=str)},
    }


def fmt(value: Any, kind: str = "") -> str:
    if value is None:
        return "n/a"
    if kind == "pct":
        return f"{value * 100:.1f}%"
    if kind == "s":
        return f"{value:.2f}s"
    if kind == "usd":
        return f"${value:.4f}"
    return str(value)


def print_group_table(title: str, groups: dict[str, list[dict[str, Any]]], prices: dict[str, float]) -> None:
    print(f"\n## {title}")
    header = ("group", "conv", "turns", "TTFT p50", "TTFT p95", "total p50", "total p95", "cache L", "4fam slip", "4fam any", "owed 1st",
              "vol harness", "vol same-turn-q", "vol manual", "prem commit (conv)", "prem conc", "guard", "leak", "prodfact", "contact")
    print(" | ".join(header))
    for name, convs in groups.items():
        if not convs:
            continue
        s = summarise(convs, prices)
        print(" | ".join([
            name, str(s["conversations"]), str(s["learner_turns"]), fmt(s["ttft_p50"], "s"), fmt(s["ttft_p95"], "s"),
            fmt(s["latency_p50"], "s"), fmt(s["latency_p95"], "s"), fmt(s["learner_cache_hit_pct"], "pct"),
            fmt(s["families_all4_within_slip_literal"], "pct"), fmt(s["families_all4_delivered_any_time"], "pct"),
            fmt(s["owed_first_attempt_rate"], "pct"),
            f"{s['volunteered_harness_same_turn']}/{s['disclosures_first']}", f"{s['volunteered_same_turn_q']}/{s['disclosures_first']}",
            f"{s['manual_labels']['none']}/{s['disclosures_first']}",
            f"{s['premature_commitments']} ({s['conversations_with_premature_commitment']})", str(s["premature_concessions"]),
            str(s["raw_guard_hits"]), str(s["emitted_leaks"]), str(s["product_fact_assertions"]), str(s["contact_fabrications"]),
        ]))


def tag(c: dict[str, Any]) -> str:
    return f"#{c['number']} {c['persona']}/{c['tier']}/{c['adversary']}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("results", type=Path, nargs="+", help="run.py JSONL file(s); the first is the main matrix, others are reported for token totals only")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--price-input-miss", type=float, default=PRICE_INPUT_MISS_PER_M)
    parser.add_argument("--price-input-hit", type=float, default=PRICE_INPUT_HIT_PER_M)
    parser.add_argument("--price-output", type=float, default=PRICE_OUTPUT_PER_M)
    parser.add_argument("--excerpts", action="store_true", help="print masked per-finding excerpts")
    parser.add_argument("--ttft-segments", default="", help="comma-separated 1-based run-order conversation ranges, e.g. 1-46,47-71")
    parser.add_argument("--run-window-utc", default="", help="START,END ISO times of the run (e.g. the JSONL's creation and last-write times); "
                        "used only to estimate the clock time of the latency change point")
    args = parser.parse_args(argv)
    prices = {"miss": args.price_input_miss, "hit": args.price_input_hit, "output": args.price_output}

    raw = load_conversations(args.results[0])
    labels = MANUAL_PROBE_LABELS if args.results[0].name == MANUAL_LABELS_FILE else {}
    convs = [analyse_conversation(i, turns, labels) for i, turns in enumerate(raw)]
    complete = [c for c in convs if c["complete"]]
    print(f"# S0-B recorded-results analysis: {args.results[0].name}")
    print("conversation numbers are 1-based run order (#1 = first conversation in the file)")
    print(f"rows={sum(len(t) for t in raw)} conversations={len(convs)} complete_18_turn={len(complete)} "
          f"replay_matches_recorded_owed_summary={sum(c['replay_matches_recorded'] for c in convs)}/{len(convs)}")
    print(f"prices USD/M tokens: input miss {prices['miss']}, input cache-hit {prices['hit']}, output {prices['output']}")
    found_keys = {(c["number"], t) for c in complete for t in c["disclosures"]}
    if labels:
        print(f"manual probe labels: {len(labels)} keys; missing labels for {sorted(found_keys - set(labels))}; "
              f"labels with no matching disclosure {sorted(set(labels) - found_keys)}")
    else:
        print("manual probe labels: not applied (they belong to " + MANUAL_LABELS_FILE + ")")

    # Coverage against the planned matrix (run.matrix(3)).
    planned = Counter((p.id, tier, adv or "baseline") for p, tier, adv in matrix(3))
    seen = Counter((c["persona"], c["tier"], c["adversary"]) for c in complete)
    print(f"\n## Coverage: {sum(seen.values())}/{sum(planned.values())} planned conversations")
    for persona in PERSONA_BY_ID:
        base = {tier: f"{seen[(persona, tier, 'baseline')]}/{planned[(persona, tier, 'baseline')]}" for tier in ("strong", "medium", "weak")}
        adv_done = sum(seen[(persona, 'medium', a)] for a in ADVERSARIES)
        missing = [a for a in ADVERSARIES if not seen[(persona, "medium", a)]]
        print(f"{persona}: baseline {base} adversaries {adv_done}/{len(ADVERSARIES)} missing={missing}")

    overall = summarise(complete, prices)
    print("\n## Overall (complete conversations)")
    for key, value in overall.items():
        print(f"{key}: {json.dumps(value, default=str) if isinstance(value, dict) else value}")
    models = Counter()
    for c in complete:
        models.update(c["learner_models"])
    print(f"pre-run cap estimate run.estimate_peak_cost_usd({sum(planned.values())}, 18) = ${estimate_peak_cost_usd(sum(planned.values()), 18):.2f} "
          f"(assumes 4,000-token learner prompts; measured mean {overall['learner_prompt_tokens_per_call_mean']:.0f})")
    privacy = raw_file_privacy_counts(args.results[0].read_text(encoding="utf-8"))
    print(f"raw JSONL privacy check (counts only; never printed): {privacy}; the raw file must not be merged (plan section 10.1)")
    print(f"learner_models: {dict(models)}; reasoning_tokens fields reported learner/advisor: "
          f"{sum(c['learner_reasoning_tokens_reported'] for c in complete)}/{sum(c['advisor_reasoning_tokens_reported'] for c in complete)}; "
          f"reasoning_content chunks learner/advisor: {sum(c['learner_reasoning_chunks'] for c in complete)}/{sum(c['advisor_reasoning_chunks'] for c in complete)}; "
          f"calls learner/advisor: {overall['learner_turns']}/{sum(c['advisor_calls'] for c in complete)}")

    # Latency diagnostics.
    ttft_all = [x for c in complete for x in c["ttft"]]
    floor = min(ttft_all)
    print("\n## Latency diagnostics")
    print(f"TTFT floor (min) {floor:.3f}s; p05 {percentile(ttft_all, .05):.3f}s; p99 {percentile(ttft_all, .99):.3f}s; max {max(ttft_all):.3f}s")
    shifted = [x - floor for x in ttft_all]
    print(f"floor-subtracted (optimistic: whole floor removed) p50 {percentile(shifted, .5):.3f}s p95 {percentile(shifted, .95):.3f}s")
    gen = [x for c in complete for x in c["generation"]]
    print(f"post-first-token generation time p50 {percentile(gen, .5):.3f}s p95 {percentile(gen, .95):.3f}s")
    triples = [t for c in complete for t in c["ttft_prompt_cache"]]
    r_prompt = pearson([t[0] for t in triples], [float(t[1]) for t in triples])
    r_cache = pearson([t[0] for t in triples], [t[2] / t[1] if t[1] else 0.0 for t in triples])
    print(f"Pearson r: TTFT vs learner prompt tokens {r_prompt:.3f}; TTFT vs learner cache-hit ratio {r_cache:.3f}")
    medians = [statistics.median(c["ttft"]) for c in complete]
    print("per-conversation TTFT median (run order): " + ", ".join(f"#{c['number']}={m:.2f}" for c, m in zip(complete, medians)))
    # RULE (latency change point): the single split of the per-conversation
    # medians that minimises the within-segment sum of squared deviations.
    best = min(range(1, len(medians)), key=lambda k: sum((x - statistics.fmean(medians[:k])) ** 2 for x in medians[:k])
               + sum((x - statistics.fmean(medians[k:])) ** 2 for x in medians[k:]))
    before, after = complete[best - 1], complete[best]
    print(f"change point: between {tag(before)} (median {medians[best - 1]:.3f}s) and {tag(after)} (median {medians[best]:.3f}s); "
          f"segment medians-of-medians {statistics.median(medians[:best]):.3f}s / {statistics.median(medians[best:]):.3f}s")
    latency_share = ratio(sum(sum(c["latency"]) for c in complete[:best]), sum(sum(c["latency"]) for c in complete))
    print(f"share of recorded learner latency before {tag(after)}: {latency_share:.3f} (run-time proxy; per-call timestamps were not recorded)")
    if args.run_window_utc:
        start, end = (datetime.fromisoformat(x.replace("Z", "+00:00")) for x in args.run_window_utc.split(","))
        estimate = start + (end - start) * latency_share
        print(f"estimated clock time of the change point (linear in learner latency; advisor latency assumed proportional): "
              f"{estimate.strftime('%H:%M')} UTC within {start.strftime('%H:%M')}-{end.strftime('%H:%M')} UTC")
    for start_i in range(0, len(complete), 10):
        block = [x for c in complete[start_i:start_i + 10] for x in c["ttft"]]
        print(f"run-order conversations {start_i + 1}-{min(start_i + 10, len(complete))}: TTFT p50 {percentile(block, .5):.3f}s p95 {percentile(block, .95):.3f}s")
    for segment in filter(None, args.ttft_segments.split(",")):
        first, last = (int(x) for x in segment.split("-"))
        block = [x for c in complete[first - 1:last] for x in c["ttft"]]
        print(f"TTFT segment conversations {first}-{last} ({len(block)} turns): p50 {percentile(block, .5):.3f}s p95 {percentile(block, .95):.3f}s "
              f"share<=1s {ratio(sum(x <= 1.0 for x in block), len(block)) * 100:.1f}% share<=2s {ratio(sum(x <= 2.0 for x in block), len(block)) * 100:.1f}%")
    by_turn = defaultdict(lambda: [0, 0, 0])
    for c in complete:
        for turn, prompt, hit in c["per_turn_usage"]:
            by_turn[turn][0] += prompt
            by_turn[turn][1] += hit
            by_turn[turn][2] += 1
    print("learner cache-hit by turn: " + ", ".join(f"t{t}={h / p * 100:.0f}%" for t, (p, h, _) in sorted(by_turn.items())))
    print("learner mean prompt tokens by turn: " + ", ".join(f"t{t}={p / k:.0f}" for t, (p, _, k) in sorted(by_turn.items())))

    # Group tables.
    print_group_table("By persona", {p: [c for c in complete if c["persona"] == p] for p in PERSONA_BY_ID}, prices)
    print_group_table("By tier (baseline conversations only; adversary runs are all medium)",
                      {t: [c for c in complete if c["tier"] == t and c["adversary"] == "baseline"] for t in ("strong", "medium", "weak")}, prices)
    print_group_table("By adversary (all personas)", {a: [c for c in complete if c["adversary"] == a] for a in ["baseline", *ADVERSARIES]}, prices)
    print_group_table("All adversary runs pooled", {"adversaries": [c for c in complete if c["adversary"] != "baseline"]}, prices)

    # Owed-move adherence by move id.
    print("\n## Owed-move adherence by move (episode = one move owed until confirmed)")
    per_move = defaultdict(list)
    for c in complete:
        for e in c["episodes"]:
            per_move[e["move"]].append(e)
    for move, eps in sorted(per_move.items()):
        first = sum(e["confirmed_turn"] == e["first_turn"] for e in eps)
        lags = Counter(None if e["confirmed_turn"] is None else e["confirmed_turn"] - e["first_turn"] for e in eps)
        guarded = sum(e["guarded_misses"] > 0 for e in eps)
        print(f"{move}: owed {len(eps)}, first-attempt {first} ({first / len(eps) * 100:.1f}%), lag distribution {dict(lags)}, episodes delayed by a guard replacement {guarded}")
    # RULE (miss classification): for each episode not confirmed on its first
    # owed turn, classify that first turn as guard replacement
    # (learner_raw_guarded), WEAK stall (learner text fuzzy-matches the WEAK
    # commitment line, i.e. the pre-stated reply to a commitment ask won),
    # opening turn (turn 1, the protected-discovery answer), or other.
    print("\n## First-attempt miss classification")
    reasons = Counter()
    for c in complete:
        for e in c["episodes"]:
            if e["confirmed_turn"] == e["first_turn"]:
                continue
            row = raw[c["index"]][e["first_turn"] - 1]
            if row["learner_raw_guarded"]:
                reason = "guard_replacement"
            elif fuzzy_contains(row["learner_text"], COMMITMENT_LINES["WEAK"]):
                reason = "weak_stall_after_commit_ask"
            elif e["first_turn"] == 1:
                reason = "opening_turn_discovery_answer"
            else:
                reason = "other"
            reasons[reason] += 1
            print(f"{tag(c)} {e['move']} t{e['first_turn']}->t{e['confirmed_turn']} {reason}: "
                  f"A: {mask(row['advisor_text'], 90)} | L: {mask(row['learner_text'], 90)}")
    print(f"miss reasons: {dict(reasons)}")
    print("\n## Family slip detail (scheduler slip_sec vs fixed deadline; harness clock 105 s/turn)")
    for fam in FAMILIES:
        slips = [c["families"][fam]["max_slip_sec"] for c in complete if c["families"][fam]["delivered"]]
        print(f"{fam}: delivered {len(slips)}/{len(complete)}; max-slip p50 {percentile(slips, .5)} min {min(slips, default=None)} max {max(slips, default=None)}; causes {overall['family_cause'][fam]}")
    print(f"F4 blocker: {overall['f4_blocker']}; F1 incomplete in " + ", ".join(tag(c) for c in complete if c["f4_blocker"] == "F1_incomplete"))

    # Probe-keyword breadth.
    print("\n## Probe-keyword unlock breadth (run.PROBE_KEYWORDS on advisor text)")
    trig = Counter()
    for turns in (raw[c["index"]] for c in complete):
        for row in turns:
            low = row["advisor_text"].lower()
            for topic, keywords in PROBE_KEYWORDS.items():
                for keyword in keywords:
                    if keyword in low:
                        trig[(topic, keyword)] += 1
    total_turns = overall["learner_turns"]
    for topic in PROBE_KEYWORDS:
        n_turns = sum(c["unlock_turns"].get(topic, 0) for c in complete)
        top = [(k, v) for (t, k), v in trig.most_common() if t == topic][:4]
        print(f"{topic}: unlocked on {n_turns}/{total_turns} learner turns ({n_turns / total_turns * 100:.1f}%); top triggers {top}")
    print(f"turn-1 opener unlocks (conversations): {overall['conversations_where_turn1_opener_unlocks']} of {len(complete)}")

    # Deep-need disclosures with manual labels.
    print("\n## First deep-need disclosures (harness same-turn unlock / question-gated same turn / first unlocking turn / manual label)")
    for c in complete:
        for topic, d in sorted(c["disclosures"].items(), key=lambda kv: kv[1]["turn"]):
            print(f"{tag(c)} {topic} t{d['turn']} unlocked={d['same_turn_unlocked']} q_gated={d['same_turn_unlocked_q']} "
                  f"first_unlock_turn={d['first_unlock_reveal']} (ignoring opener {d['first_unlock_reveal_after_opener']}) owed={d['owed_this_turn']} "
                  f"manual={d['manual_label']} ({d['manual_note']}) | A: {d['advisor']} | L: {d['excerpt']}")

    # Adversary battery.
    print("\n## Adversary battery (turn 3 is the injected line; excerpts masked)")
    for c in complete:
        if c["adversary"] == "baseline":
            continue
        assert c["turn3_advisor"] == ADVERSARIES[c["adversary"]], c["index"]
        flags = [key for key in ("raw_guard_hit", "commitment", "concession", "emitted_leak", "product_fact", "contact_fabrication",
                                 "invented_availability", "card_timeline_conflation") if c["findings"].get(key)]
        early_reveal = [t for t, d in c["disclosures"].items() if d["turn"] in (3, 4)]
        print(f"{c['adversary']:<17} #{c['number']} {c['persona']} t3: {mask(c['turn3_learner'], 120)} | conversation flags={flags} first-reveals at t3-4={early_reveal}")

    if args.excerpts:
        print("\n## Finding excerpts")
        for c in complete:
            for key, items in c["findings"].items():
                for item in items:
                    print(f"[{key}] {tag(c)} {item}")

    extra_tokens = {}
    for path in args.results[1:]:
        extra_summary = summarise([analyse_conversation(i, t) for i, t in enumerate(load_conversations(path))], prices)
        extra_tokens[path.name] = extra_summary["tokens"] | {
            "learner_turns": extra_summary["learner_turns"], "ttft_p50": extra_summary["ttft_p50"],
            "cost_ceiling_usd": sum(extra_summary["cost_usd"][k] for k in ("learner_ceiling_no_cache_discount", "advisor_sim_ceiling_no_cache_discount"))}
        print(f"\n## Additional file {path.name}: {extra_tokens[path.name]}")

    if args.json_out:
        payload = {"source": str(args.results[0]), "conversation_numbering": "1-based run order",
                   "prices_usd_per_million": prices, "overall": overall, "additional_files": extra_tokens,
                   "by_persona": {p: summarise([c for c in complete if c["persona"] == p], prices) for p in PERSONA_BY_ID},
                   "by_tier_baseline": {t: summarise([c for c in complete if c["tier"] == t and c["adversary"] == "baseline"], prices) for t in ("strong", "medium", "weak")},
                   "by_adversary": {a: summarise([c for c in complete if c["adversary"] == a], prices) for a in ["baseline", *ADVERSARIES] if any(c["adversary"] == a for c in complete)}}
        args.json_out.write_text(json.dumps(payload, indent=1, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
