"""Deterministic metrics over a rehearsal call (and over any real session export).

Everything here is a pure function of the persisted rows (the database export schema:
``turn_index`` or ``index``, ``phase``, ``speaker`` of ``bot`` or ``candidate``, ``text``,
``interrupted``) and, for a rehearsal call, of the exchange log the runner keeps.  The row
metrics therefore also run on a real session (``tests/fixtures/r1_owner_b58c7d9c.json`` is
the owner's 4/10 test).

Anti-circularity rule (research/rehearsal-harness.md 4.5): a behaviour is never scored with
the detector the engine uses to produce it.  Probes, asks and farewells come from the advisor
simulator's own intent tags; the engine's ``detect_probes`` / ``detect_ask`` /
``is_close_attempt`` are not imported here.  Repetition is measured with its own normaliser
and ``difflib``, not with ``r1_text.repeat_kind``.

IDs follow the research doc: M1 exact repeats, M2 near repeats, M3 old WEAK stall, M4
catch-all deflection, M6 need disclosure after a genuine probe, M6b unprompted dump, M7
commitment, M8 premature commit, M9 misfires, M10 fact errors, M11 reply length, M12 question
and reaction rate, M14 name fallback, M15 farewell rows, M16 repeated phrase in a row, M18
fragmentation, M19 guard and fidelity, M21 neutral acks, M22 verbal tics (R1-Q iteration 1: a
reaction word opening more than 15 % of the replies, "hmm" or "honestly" in more than 20 %; the
tic words have their own regexes here, the engine's tic detector in ``r1_text`` is not imported),
M23 phrase tics ("a stretch" and the "what would it involve" question, per call).  Iteration 2: a
"dig" (M6) is read from the advisor's own question (``dug_topics``) and an earned commitment (M7) from
the advisor's own words (``advisor_asked_next_step``), not from the simulator's tags alone.
"""
from __future__ import annotations

import difflib
import math
import re
import unicodedata
from collections import Counter
from typing import Any, Iterable, Mapping, Sequence

from r1_commitment import COMMIT_PERMITTED_R_SEC, stall_line
from r1_guard import FALLBACK_REPLIES, NEUTRAL_ACKS, REPLY_WORD_CAP
from r1_personas import H_TOPICS, deep_need_topics_in, resolve_persona
from r1_text import canonical_amounts, fuzzy_contains, split_sentences
from r1_world import DURATION_MONTHS, NET_PRICES_USD, PRICE_USD, DISCOUNTS_USD, claims_guarantee

ROLEPLAY = "roleplay"
BOT = "bot"
CANDIDATE = "candidate"
# The catch-all line the learner used to say after any question it could not answer
# (removed from r1_world by R1-Q T01; kept here as the thing to look for).
LEGACY_DEFLECTION = "I'm not sure, I haven't thought about that."
WEAK_LINE = stall_line("")
FAMILY_IDS = ("F1", "F2", "F3", "F4")
ASK_INTENTS = frozenset({"close_ask", "callback", "accept_callback"})
PROBE_INTENTS = frozenset({"probe", "followup"})
EXACT_MIN_WORDS = 4
HARD_EXACT_MIN_WORDS = 6
NEAR_JACCARD = 0.8
NEAR_RATIO = 0.85
NEAR_PREFIX_WORDS = 6
SHORT_REPLY_WORDS = 8
DEEP_WINDOW_TURNS = 2
# "Let me think about it / e-mail me / I'll get back to you" in different words still is the
# stall: more than a few learner rows in one call is the loop, however it is phrased.
STALL_PHRASE_LIMIT = 3

_STALL_FAMILY = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\blet me think (?:about it|it over|this over)\b",
        r"\bemail me\b",
        r"\bget back to you\b",
        r"\bi'?ll (?:think|be in touch)\b",
    )
)
_NAME_FALLBACK = re.compile(
    r"\b(?:thank you|thanks|today|hi|hello|dear)\b,?\s+there\b(?!\s+(?:is|are|was|were)\b)",
    re.IGNORECASE,
)
_FAREWELL_WORDS = re.compile(
    r"\b(?:goodbye|good bye|bye|have a (?:great|good|nice|lovely) (?:day|one)|take care|"
    r"thank you for your time|thanks for your time|all the best)\b",
    re.IGNORECASE,
)
_REACTION_OPENERS = frozenset(
    "okay ok oh right sure hmm mm mhm yeah yes got ah alright good great nice fair "
    "interesting honestly well wow wait thanks thank that really i see hm mmhmm".split()
)
_STOP = frozenset(
    "a an the to of and or but so in on at for with about as by from it its is are was were "
    "be been will would can could should may might do does did have has had you your yours "
    "we our i me my they them their that this these those there here not no yes if then "
    "than too very just also".split()
)
# M22 verbal tics.  Own regexes (anti-circularity): "Mm-hmm" is a back-channel, not the tic.
_HMM = re.compile(r"(?<![a-z-])hmm+\b|(?<![a-z-])hm\b", re.IGNORECASE)
_HONESTLY = re.compile(r"\b(?:honestly|to be honest|frankly)\b", re.IGNORECASE)
# M23 phrase tics (iteration 2): "still a stretch for me" (28 replies in 19 of 20 calls) and the
# question template "what would that call actually involve / cover / include" (33 in 15 calls).
_STRETCH = re.compile(r"\b(?:a|quite a|kind of a|a bit of a|a real) stretch\b", re.IGNORECASE)
_TEMPLATE_QUESTION = re.compile(
    r"\bwhat (?:would|does|will|do|did|could|is) (?:that|this|the|it|a|an|my|joining|waiting)\b"
    r"[^?.!]{0,40}?\b(?:involve|involves|cover|covers|include|includes|entail|look like|"
    r"mean for me)\b",
    re.IGNORECASE,
)
# M24 stall loops (R1-Q final review round 1): the same stall said again and again in other words.
# Own regexes (the engine's tracked phrases are not imported).  "talk it through with my father" was
# voiced in 9 of 35 replies of one terse call, "still more than I planned for" three replies in a row.
STALL_WINDOW_DECIDER = 4
STALL_WINDOW_MONEY = 3
_DECIDER_STALL = re.compile(
    r"\b(?:talk|speak|check|run|discuss|consult|go (?:over|through))\w*\b[^.?!]{0,40}?\b"
    r"(?:with|to|by|past)\s+(?:my |our )?(?:husband|wife|partner|spouse|father|mother|dad|mom|"
    r"mum|parents|him|her|them)\b",
    re.IGNORECASE,
)
_MONEY_STRAIN = re.compile(
    r"\bstill (?:more than (?:i|we)|worried about (?:the )?(?:cost|price|money)|(?:a lot|too much|"
    r"steep|pricey|expensive) for me)\b|\bmore than (?:i|we) (?:had |'d )?(?:planned|hoped|"
    r"budgeted) (?:for|on)\b",
    re.IGNORECASE,
)
# What the advisor's question must be about for a deep need told soon after it not to count as an
# unprompted dump, when the simulator did not tag the question as a probe (a permissive check:
# the simulator's tag stays the ground truth for everything else).
_PROBE_VOCAB = {
    # Iteration 3 (H3): the vocabulary missed ordinary probes of the live sweep ("what's prompting
    # you to look into data science right now?", "What got you interested?", "And why data
    # science?", "What made it not stick last time?", "Does your employer cover part of it?",
    # "Is he open to it?"), which made the reveals that answered them look like dumps and hid the
    # H3 digs of the terse level.
    "H1": re.compile(
        r"\b(?:why (?:now|this|that|are you|did you|do you|data science)|what (?:made (?:you|this|"
        r"that|now)|prompted|brought|changed|got you|is driving|'s driving|is prompting|"
        r"'s prompting|is behind|'s behind)|"
        r"prompt\w*|motivat\w+|interested|got you|brought you|bring you|timeline|timeframe|"
        r"deadline|trigger|urgency|how soon|"
        r"when (?:do|are|would) you (?:want|hope|need|plan)|looking (?:now|into)|look into|"
        r"start(?:ed)? looking|interested in)\b",
        re.IGNORECASE,
    ),
    "H2": re.compile(
        r"\b(?:concerns?|worr\w+|hesitat\w+|holding you back|held you back|stopping you|stopped you|"
        r"tried|struggl\w+|challenge\w*|obstacle|didn'?t work|not stick|didn'?t stick|stick|"
        r"went wrong|so far|biggest|afraid|nervous|doubts?|hurdle|blocker|friction|previous|"
        r"before|keep you from|missing|tripped)\b",
        re.IGNORECASE,
    ),
    "H3": re.compile(
        r"\b(?:hours?|schedule|week|budget|afford\w*|money|pay\w*|instal\w+|husband|wife|partner|"
        r"spouse|family|kids|parents|father|mother|decid\w+|anyone else|someone else|time|"
        r"commitments?|workload|finances?|help (?:with )?decisions?|cover\w* (?:part|some|any)|"
        r"employer|sponsor\w*|open to (?:it|this|that)|weigh in)\b",
        re.IGNORECASE,
    ),
}
# A question about WHEN to talk again is about the calendar, not about the learner's time or money
# ("when could you two talk?", "is there a good time later this week to reconnect?"); it is no dig
# at the H3 need (the live sweep counted two such questions as H3 digs).
_SCHEDULING_QUESTION = re.compile(
    r"\b(?:reconnect|call (?:you )?back|follow(?:ing)? up|check(?:ing)? in|touch base|"
    r"set (?:up )?a (?:time|call)|schedule a|a good time|good time to|book a|when (?:could|can|"
    r"would|do) (?:you|we|i)[^?]{0,20}\b(?:talk|chat|speak|meet|connect))\b",
    re.IGNORECASE,
)
# M9 misfire shapes added in iteration 1 (the live misfires of the sweeps).
_TIME_CUE_REVERSED = re.compile(
    r"\byou(?:'ve| have)? (?:just |only )?(?:mentioned|said|told me)\b[^.?!]{0,40}"
    r"\b(?:(?:a couple of|a few|two|five|ten|\d+) minutes\b(?! ago)|next call|another call)"
    r"|\byou(?:'ve| have|'re| are)? (?:only |just )?(?:got|have) (?:a couple of|a few) minutes\b",
    re.IGNORECASE,
)
_DECIDES_ALONE = re.compile(
    r"\b(?:it'?s|it is) (?:just|only) me\b"
    r"|\b(?:nobody|no ?one) else\b[^.?!]{0,25}\b(?:decid|involved)"
    r"|\bi (?:decide|make the decision) (?:on my own|alone|by myself)\b",
    re.IGNORECASE,
)
_ADVISOR_HEDGE = re.compile(
    r"\b(?:check|talk|speak) (?:with|to) (?:my|the) (?:manager|supervisor|boss|lead|team)\b"
    r"|\blet me (?:check|see|try)\b|\bi(?:'ll| will| can) (?:try|see|check|ask)\b|\bno promises\b",
    re.IGNORECASE,
)
_GRATITUDE_FOR_GRANT = re.compile(
    r"\b(?:thank(?:s| you)|appreciate)\b[^.?!]{0,50}\b(?:discount|reduc\w+|lower|better|"
    r"that helps|helps a lot)\b|\bbetter than i expected\b|\bgreat news\b",
    re.IGNORECASE,
)
_ANCHOR_AS_OFFER = re.compile(
    r"7,?000\b[^?]{0,60}\b(?:better than i expected|a relief|great news|good news|sounds good|"
    r"that works)\b|\bbetter than i expected\b[^?]{0,40}7,?000",
    re.IGNORECASE,
)
_QUESTION_OR_DOUBT = re.compile(
    r"\?|\b(?:hold on|not sure|worried|worry|concerns?|hesitat\w+|what if|i'?d rather)\b",
    re.IGNORECASE,
)
# A real price (not a $500 discount): the lowest net figure the course is sold at.
_NET_PRICE_FLOOR = 4500
_SURPRISE = re.compile(
    r"\b(?:nice|pleasant|lovely) surprise\b|\bpleasantly surprised\b|\bwhat a surprise\b",
    re.IGNORECASE,
)
_BEFORE_YOU_GO = re.compile(r"\bbefore (?:you go|we wrap up)\b", re.IGNORECASE)
_DISCOUNT_CUE = re.compile(
    r"\$\s?\d|\b\d{1,3}\s?%|\bdiscount\b|\boff\b|\bdown to\b|\bwaive\w*", re.IGNORECASE
)
_TIME_CUE_WORDS = re.compile(
    r"\b(?:couple|few) (?:of )?minutes\b[^.?!]{0,40}\b(?:call|meeting)\b|"
    r"\b(?:another|next) call\b",
    re.IGNORECASE,
)
_ADVISOR_FAREWELL = re.compile(
    r"\b(?:bye|goodbye|talk (?:to you )?(?:soon|later)|take care|have a (?:great|good) day|"
    r"thanks? for your time|thank you for your time)\b",
    re.IGNORECASE,
)


# ----------------------------------------------------------------------------- text helpers
def norm(text: object) -> str:
    """Lower-case alphanumerics, apostrophes dropped, single spaces (own normaliser)."""
    folded = unicodedata.normalize("NFKC", str(text or "")).lower()
    folded = folded.replace(chr(0x2019), "'").replace("'", "")
    return re.sub(r"[^a-z0-9]+", " ", folded).strip()


def words_of(text: object) -> int:
    return len(norm(text).split())


def _sentences(text: object) -> list[str]:
    return [norm(sentence) for sentence in split_sentences(text) if norm(sentence)]


def percentile(values: Sequence[float], q: float) -> float | None:
    """Nearest-rank percentile (``q`` in 0..100); None for an empty list."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100.0 * len(ordered)))
    return float(ordered[min(rank, len(ordered)) - 1])


def mean(values: Sequence[float]) -> float | None:
    return None if not values else sum(values) / len(values)


def _max_in_window(flags: Sequence[bool], window: int) -> int:
    """The most ``True`` flags in any ``window`` consecutive replies."""
    return max((sum(flags[start : start + window]) for start in range(len(flags))), default=0)


# ------------------------------------------------------------------------------- row access
def row_index(row: Mapping[str, Any]) -> int:
    value = row.get("turn_index", row.get("index"))
    return int(value) if isinstance(value, (int, float)) else 0


def ordered_rows(rows: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(rows, key=row_index)


def learner_replies(rows: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The learner's lines of the role-play after the advisor first spoke (no pickup line)."""
    replies: list[Mapping[str, Any]] = []
    advisor_spoke = False
    for row in ordered_rows(rows):
        if row.get("phase") != ROLEPLAY:
            continue
        if row.get("speaker") == CANDIDATE:
            advisor_spoke = True
        elif row.get("speaker") == BOT and advisor_spoke:
            replies.append(row)
    return replies


def reply_texts(rows: Iterable[Mapping[str, Any]]) -> list[str]:
    return [str(row.get("text", "")) for row in learner_replies(rows)]


# ------------------------------------------------------------------------------ repetition
def repeat_metrics(texts: Sequence[str]) -> dict[str, Any]:
    """M1 exact and M2 near repeats over the learner's sentences, in order.

    A sentence counts when it has at least ``EXACT_MIN_WORDS`` words.  Exact: the same
    normalised sentence again.  Near (and not exact): the same first six words, or a token
    Jaccard of at least 0.8, or a ``difflib`` ratio of at least 0.85 with an earlier one.
    """
    seen: dict[str, int] = {}
    order: list[str] = []
    near: list[dict[str, Any]] = []
    for text in texts:
        for sentence in _sentences(text):
            tokens = sentence.split()
            if len(tokens) < EXACT_MIN_WORDS:
                continue
            if sentence in seen:
                seen[sentence] += 1
                continue
            match = _near_match(sentence, order)
            if match is not None:
                near.append({"sentence": sentence, "earlier": match})
            seen[sentence] = 1
            order.append(sentence)
    repeats = [
        {"sentence": sentence, "count": count, "words": len(sentence.split())}
        for sentence, count in seen.items()
        if count >= 2
    ]
    repeats.sort(key=lambda item: (-item["count"], item["sentence"]))
    return {
        "exact_repeat_extra": sum(item["count"] - 1 for item in repeats),
        "exact_repeats": repeats,
        "long_exact_repeat": any(item["words"] >= HARD_EXACT_MIN_WORDS for item in repeats),
        "near_repeat_count": len(near),
        "near_repeats": near,
    }


def _near_match(sentence: str, earlier: Sequence[str]) -> str | None:
    tokens = sentence.split()
    token_set = set(tokens)
    padded = f" {sentence} "
    for prior in earlier:
        prior_tokens = prior.split()
        # One sentence sitting whole inside the other ("just email me the details" inside
        # "just email me the details and ill get back to you").
        if f" {prior} " in padded or padded in f" {prior} ":
            return prior
        if (
            len(tokens) >= NEAR_PREFIX_WORDS
            and len(prior_tokens) >= NEAR_PREFIX_WORDS
            and tokens[:NEAR_PREFIX_WORDS] == prior_tokens[:NEAR_PREFIX_WORDS]
        ):
            return prior
        union = token_set | set(prior_tokens)
        if union and len(token_set & set(prior_tokens)) / len(union) >= NEAR_JACCARD:
            return prior
        if difflib.SequenceMatcher(None, sentence, prior).ratio() >= NEAR_RATIO:
            return prior
    return None


# --------------------------------------------------------------------- stall and deflection
def weak_metrics(texts: Sequence[str]) -> dict[str, Any]:
    """M3 old WEAK stall rows and M3b stall-family phrases, M4 deflection rows."""
    weak_rows = [index for index, text in enumerate(texts) if fuzzy_contains(text, WEAK_LINE)]
    stall_rows = [
        index
        for index, text in enumerate(texts)
        if any(pattern.search(text) for pattern in _STALL_FAMILY)
    ]
    deflection_rows = [
        index for index, text in enumerate(texts) if fuzzy_contains(text, LEGACY_DEFLECTION)
    ]
    fallback_rows = [
        index
        for index, text in enumerate(texts)
        if any(norm(text) == norm(reply) for reply in FALLBACK_REPLIES)
    ]
    return {
        "weak_line_count": len(weak_rows),
        "weak_line_rows": weak_rows,
        "stall_family_rows": len(stall_rows),
        "deflection_count": len(deflection_rows),
        "deflection_rows": deflection_rows,
        "fallback_reply_count": len(fallback_rows),
    }


# ------------------------------------------------------------------------------ fact errors
def fact_error_metrics(
    texts: Sequence[str],
    advisor_texts: Sequence[str] = (),
    ledger_prices: Iterable[int] = (),
) -> dict[str, Any]:
    """M10: the learner contradicting the deck (price, duration, a guarantee).

    A figure the advisor said earlier, or the $7,000 anchor, is not an error: the learner is
    allowed to repeat what it heard.  The deck's own numbers are never errors.  R1-Q final review
    round 1 (H1): a price the advisor put on the table in words ("thirty-five percent off, that's
    thirty-one fifty off") is the net the worker's offer ledger computed ($5,850), so the ledger's
    prices (``ledger_prices``) and the advisor's spelled-out amounts are allowed too; the p1 pushy
    call failed as a "fact error" for repeating the advisor's own arithmetic.
    """
    allowed = {PRICE_USD, 7000, *NET_PRICES_USD, *DISCOUNTS_USD, *ledger_prices}
    for text in advisor_texts:
        allowed.update(_dollar_figures(text))
        allowed.update(_dollar_figures(canonical_amounts(text)))
    errors: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        codes: list[str] = []
        # A question asserts nothing (R1-Q iteration 3, H1): "is there any kind of guarantee behind
        # that?" was counted as the learner claiming a guarantee and failed a call as a hard fail.
        statements = [s for s in split_sentences(text) if not _is_question(s)]
        if claims_guarantee(" ".join(statements)):
            codes.append("guarantee_claim")
        for sentence in statements:
            folded = sentence.lower()
            for match in re.finditer(r"\b(\d{1,2})[\s-]*months?\b", folded):
                if int(match.group(1)) != DURATION_MONTHS and re.search(
                    r"\b(?:course|program|programme|lasts?|takes?|duration)\b", folded
                ):
                    codes.append("duration_not_deck")
            if re.search(r"\b(?:price|cost|fee|pay|paying|total)\b", folded):
                for amount in _dollar_figures(sentence):
                    if amount not in allowed:
                        codes.append("price_not_deck")
        if codes:
            errors.append({"reply": index, "codes": sorted(set(codes))})
    return {"fact_error_count": len(errors), "fact_errors": errors}


_QUESTION_START = re.compile(
    r"^\W*(?:(?:and|so|but|also|okay|well)\W+)*(?:is|are|was|were|do|does|did|can|could|will|would|"
    r"should|has|have|what|why|how|where|when|who|which)\b",
    re.IGNORECASE,
)


def _is_question(sentence: str) -> bool:
    """A sentence that asks: it ends in "?" or opens with an interrogative word."""
    return "?" in sentence or _QUESTION_START.match(sentence) is not None


def price_figures(text: object) -> list[int]:
    """The course prices (not discounts) named in ``text``, highest first."""
    return sorted(
        (value for value in _dollar_figures(text) if _NET_PRICE_FLOOR <= value <= PRICE_USD),
        reverse=True,
    )


def _dollar_figures(text: object) -> set[int]:
    figures: set[int] = set()
    for match in re.finditer(r"\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?", str(text or ""), re.IGNORECASE):
        try:
            value = float(match.group(1).replace(",", ""))
        except ValueError:
            continue
        if match.group(2):
            value *= 1000
        figures.add(int(round(value)))
    for match in re.finditer(r"(?<![\d.])(\d{1,2}),?(\d{3})(?![\d])", str(text or "")):
        figures.add(int(match.group(1) + match.group(2)))
    # "8.5" or "8.5k" said as a price means $8,500 (a decimal in thousands).
    decimal = re.compile(
        r"(?<![\d.$])(\d)\.(\d)\s?k?\b(?!\s*(?:hours?|hrs?|%|months?|weeks?|days?|years?))",
        re.IGNORECASE,
    )
    for match in decimal.finditer(str(text or "")):
        figures.add(int(match.group(1)) * 1000 + int(match.group(2)) * 100)
    return figures


# --------------------------------------------------------------------------- style and size
def style_metrics(texts: Sequence[str]) -> dict[str, Any]:
    """M11 reply length, M12 question and reaction rate, M21 neutral-ack share."""
    lengths = [words_of(text) for text in texts]
    questions = sum(1 for text in texts if "?" in text)
    reactions = 0
    for text in texts:
        tokens = norm(text).split()
        if tokens and tokens[0] in _REACTION_OPENERS:
            reactions += 1
    neutral = {norm(ack) for ack in NEUTRAL_ACKS}
    count = len(texts)
    # The LITERAL first word of every reply, whatever it is (R1-Q final review round 1): the owner's
    # rule is "no opener word on more than 15 % of the replies", and a whitelist of reaction words
    # missed the dominant opener of the third live sweep ("That's", 17 % of all replies, 23 % at two
    # levels: ``norm`` drops the apostrophe, so it read "thats" and was never counted).
    openers: Counter[str] = Counter()
    for text in texts:
        tokens = norm(text).split()
        if tokens:
            openers[tokens[0]] += 1
    top_word, top_count = openers.most_common(1)[0] if openers else ("", 0)
    hmm = sum(1 for text in texts if _HMM.search(text))
    honestly = sum(1 for text in texts if _HONESTLY.search(text))
    stretch = sum(1 for text in texts if _STRETCH.search(text))
    template = sum(1 for text in texts if _TEMPLATE_QUESTION.search(text))
    decider_flags = [_DECIDER_STALL.search(text) is not None for text in texts]
    money_flags = [_MONEY_STRAIN.search(text) is not None for text in texts]
    return {
        "decider_stall_rows": sum(decider_flags),
        "decider_stall_window_max": _max_in_window(decider_flags, STALL_WINDOW_DECIDER),
        "money_strain_rows": sum(money_flags),
        "money_strain_window_max": _max_in_window(money_flags, STALL_WINDOW_MONEY),
        "reply_stretch_count": stretch,
        "reply_template_q_count": template,
        "opener_counts": dict(openers),
        "opener_top_word": top_word or None,
        "opener_top_share": (top_count / count) if count else None,
        "reply_hmm_count": hmm,
        "reply_honestly_count": honestly,
        "hmm_share": (hmm / count) if count else None,
        "honestly_share": (honestly / count) if count else None,
        "reply_count": count,
        "reply_words_mean": mean(lengths),
        "reply_words_p90": percentile(lengths, 90),
        "reply_words_max": max(lengths) if lengths else None,
        "short_reply_share": (
            sum(1 for n in lengths if n <= SHORT_REPLY_WORDS) / count if count else None
        ),
        "over_cap_replies": sum(1 for n in lengths if n > REPLY_WORD_CAP),
        "question_rate": questions / count if count else None,
        "reaction_rate": reactions / count if count else None,
        "neutral_ack_share": (
            sum(1 for text in texts if norm(text) in neutral) / count if count else None
        ),
    }


# --------------------------------------------------------------------------- interviewer rows
def interviewer_metrics(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """M14 name fallback, M15 farewell rows, M16 repeated phrase in one row.

    Only meaningful when the interviewer phases are present (a real export, or the full-flow
    tier); a role-play-only call yields ``None`` for all three.
    """
    ordered = ordered_rows(rows)
    bot_rows = [row for row in ordered if row.get("speaker") == BOT]
    interviewer = [row for row in bot_rows if row.get("phase") != ROLEPLAY]
    closing = [row for row in bot_rows if row.get("phase") in ("wrapup", "closing")]
    if not interviewer:
        return {"name_fallback": None, "farewell_rows": None, "repeated_phrase_rows": None}
    name_rows = [
        row_index(row)
        for row in bot_rows
        if row.get("phase") != ROLEPLAY and _NAME_FALLBACK.search(str(row.get("text", "")))
    ]
    farewell_rows = [
        row_index(row) for row in closing if _FAREWELL_WORDS.search(str(row.get("text", "")))
    ]
    repeated = [row_index(row) for row in closing if _repeated_phrase(str(row.get("text", "")))]
    return {
        "name_fallback": len(name_rows),
        "name_fallback_rows": name_rows,
        "farewell_rows": len(farewell_rows),
        "farewell_row_ids": farewell_rows,
        "repeated_phrase_rows": len(repeated),
        "repeated_phrase_row_ids": repeated,
    }


def _repeated_phrase(text: str) -> str | None:
    """A pair of adjacent content words that occurs twice inside one row ("hiring team")."""
    tokens = norm(text).split()
    seen: dict[tuple[str, str], int] = {}
    for first, second in zip(tokens, tokens[1:]):
        if first in _STOP or second in _STOP or len(first) < 3 or len(second) < 3:
            continue
        seen[(first, second)] = seen.get((first, second), 0) + 1
    for pair, count in seen.items():
        if count >= 2:
            return " ".join(pair)
    return None


def fragmentation_metrics(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """M18 candidate rows per learner reply (speech-to-text fragmentation), real exports only."""
    runs: list[int] = []
    current = 0
    for row in ordered_rows(rows):
        if row.get("phase") != ROLEPLAY:
            continue
        if row.get("speaker") == CANDIDATE:
            current += 1
        elif row.get("speaker") == BOT and current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    return {
        "candidate_rows_per_reply_mean": mean(runs),
        "candidate_rows_per_reply_max": max(runs) if runs else None,
    }


def row_metrics(
    rows: Sequence[Mapping[str, Any]],
    advisor_texts: Sequence[str] = (),
    ledger_prices: Iterable[int] = (),
) -> dict[str, Any]:
    """Every metric that needs only the persisted rows (works on a real session export)."""
    texts = reply_texts(rows)
    out: dict[str, Any] = {}
    out.update(repeat_metrics(texts))
    out.update(weak_metrics(texts))
    out.update(fact_error_metrics(texts, advisor_texts, ledger_prices))
    out.update(style_metrics(texts))
    out.update(interviewer_metrics(rows))
    out.update(fragmentation_metrics(rows))
    return out


# ------------------------------------------------------------------------ exchange metrics
def _learner(ex: Mapping[str, Any]) -> Mapping[str, Any]:
    return ex.get("learner") or {}


def _advisor(ex: Mapping[str, Any]) -> Mapping[str, Any]:
    return ex.get("advisor") or {}


def disclosure_metrics(persona: Any, exchanges: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """M6 need disclosure after a genuine probe, M6b unprompted dump.

    ``probe`` / ``followup`` and their topic come from the advisor simulator (ground truth).
    A need is "dug" when its topic was probed and then followed up (or probed twice): that is
    when the deep layer is allowed.  It counts as disclosed when the persona's deep-need
    markers (persona content, not the engine's detector) appear in the learner's lines from
    the first probe to ``DEEP_WINDOW_TURNS`` after the last touch.
    """
    spoken = [str(_learner(ex).get("spoken") or "") for ex in exchanges]
    deep_by_turn = [deep_need_topics_in(persona, text) for text in spoken]
    touches: dict[str, list[tuple[int, str]]] = {topic: [] for topic in H_TOPICS}
    for index, ex in enumerate(exchanges):
        advisor = _advisor(ex)
        intent = str(advisor.get("intent") or "")
        if intent not in PROBE_INTENTS:
            continue
        for topic in dug_topics(advisor):
            touches[topic].append((index, intent))
    probed: list[str] = []
    dug: list[str] = []
    disclosed: list[str] = []
    deep_on_first_probe: list[str] = []
    for topic, marks in touches.items():
        # Iteration 3 (H3): the FIRST question the advisor really asks about a topic is the probe,
        # whatever the simulator tagged it ("followup/H2" for "what do you think held you back?"
        # was no probe to the old rule, so the next touch counted as the dig of a need that had
        # only been probed once).  Any later touch is a dig.
        if not marks:
            continue
        probed.append(topic)
        first_probe = marks[0][0]
        later = [i for i, _intent in marks if i > first_probe]
        if later:
            dug.append(topic)
            window_end = max(i for i, _intent in marks) + DEEP_WINDOW_TURNS
            if any(topic in deep_by_turn[i] for i in range(first_probe, min(window_end + 1, len(spoken)))):
                disclosed.append(topic)
        if topic in deep_by_turn[first_probe]:
            deep_on_first_probe.append(topic)
    unprompted: list[dict[str, Any]] = []
    excused = 0
    told: set[str] = set()
    for index, topics in enumerate(deep_by_turn):
        for topic in sorted(topics):
            # Said again later: repetition (the repeat metrics see it), not a new disclosure.
            if topic in told:
                continue
            told.add(topic)
            recent = [
                i for i, _intent in touches.get(topic, []) if index - DEEP_WINDOW_TURNS <= i <= index
            ]
            if recent:
                continue
            if _asked_in_window(topic, exchanges, index):
                excused += 1  # the advisor asked about it in so many words; the simulator did not tag it
                continue
            unprompted.append({"exchange": index + 1, "topic": topic})
    return {
        "unprompted_dump_excused": excused,
        "needs_probed": sorted(probed),
        "needs_dug": sorted(dug),
        "needs_disclosed_after_dig": sorted(disclosed),
        "disclosure_rate": (len(disclosed) / len(dug)) if dug else None,
        "deep_on_first_probe": sorted(deep_on_first_probe),
        "unprompted_dump_count": len(unprompted),
        "unprompted_dumps": unprompted,
        "deep_revealed_total": len({t for topics in deep_by_turn for t in topics}),
    }


# A follow-up that asks the learner to say more about what it just said, whatever the topic.
_GENERIC_FOLLOWUP = re.compile(
    r"\b(?:tell me more|say more|elaborate|expand on|what do you mean|how so|why is that|"
    r"(?:can|could|would|will) you (?:please )?(?:explain|share|walk me|give me an example|tell me)|"
    r"go on|when you say|you (?:mentioned|said)|what specifically|like what|more about that)\b",
    re.IGNORECASE,
)


def dug_topics(advisor: Mapping[str, Any]) -> list[str]:
    """The needs (H1-H3) that the advisor's turn really asks about, read from its own words.

    The simulator tags every turn with an intent and a topic, but the tag is a model's guess: "Have
    you tried anything so far ... courses or self-study?" came tagged ``followup``/``H1`` (it is an
    H2 question) and "What's your current role?" came tagged ``probe``/``H1`` (it digs at nothing),
    which made the disclosure gate fail on digs that were never made (R1-Q iteration 2).  A topic
    counts when a QUESTION sentence of the turn carries that topic's vocabulary; a ``followup`` also
    counts for its tagged topic when it plainly asks the learner to say more.  A turn with neither
    digs at nothing.
    """
    text = str(advisor.get("text") or "")
    tag = str(advisor.get("topic") or "")
    questions = [sentence for sentence in split_sentences(text) if "?" in sentence]
    found = [
        topic
        for topic in H_TOPICS
        if any(
            _PROBE_VOCAB[topic].search(question)
            and not (topic == "H3" and _SCHEDULING_QUESTION.search(question))
            for question in questions
        )
    ]
    if (
        str(advisor.get("intent") or "") == "followup"
        and tag in H_TOPICS
        and tag not in found
        and _GENERIC_FOLLOWUP.search(text) is not None
    ):
        found.append(tag)
    return found


def _asked_in_window(topic: str, exchanges: Sequence[Mapping[str, Any]], index: int) -> bool:
    """True when an advisor QUESTION about ``topic`` stands within the deep window before ``index``.

    The simulator's probe tags are the ground truth for disclosure, but they come from a model that
    sometimes asks "what is holding you back?" and tags it ``other``.  A reveal that answers such a
    question (a question sentence with the topic's own vocabulary, in this exchange or the
    ``DEEP_WINDOW_TURNS`` before it) is a prompted one.
    """
    pattern = _PROBE_VOCAB.get(topic)
    if pattern is None:
        return False
    for i in range(max(0, index - DEEP_WINDOW_TURNS), index + 1):
        for sentence in split_sentences(str(_advisor(exchanges[i]).get("text") or "")):
            if "?" in sentence and pattern.search(sentence):
                return True
    return False


def commitment_metrics(
    exchanges: Sequence[Mapping[str, Any]], admin: Mapping[str, Any]
) -> dict[str, Any]:
    """M7 commitment level (and whether the advisor earned it), M8 premature commitment."""
    commitment = admin.get("commitment") or {}
    level = commitment.get("level")
    commit_exchange = None
    for index, ex in enumerate(exchanges):
        plan = _learner(ex).get("plan") or {}
        if plan.get("resolves") and plan.get("commitment_level") and _spoke_commitment(ex):
            commit_exchange = index
            break
    earned: bool | None = None
    if level in ("MEDIUM", "STRONG") and commit_exchange is not None:
        window = range(max(0, commit_exchange - 2), commit_exchange + 1)
        earned = any(advisor_asked_next_step(_advisor(exchanges[i])) for i in window)
    premature = 0
    for ex in exchanges:
        plan = _learner(ex).get("plan") or {}
        if plan.get("commitment_level") in ("MEDIUM", "STRONG") and _spoke_commitment(ex):
            if float(ex.get("r_sec") or 0.0) < COMMIT_PERMITTED_R_SEC:
                premature += 1
    return {
        "commitment_level": level,
        "commitment_resolved": bool(commitment.get("resolved")),
        "commitment_exchange": None if commit_exchange is None else commit_exchange + 1,
        "commitment_earned": earned,
        "premature_commit_count": premature,
        "asks_seen": len(commitment.get("asks") or []),
        "stalls_before_window": commitment.get("stalls_before_window"),
    }


# The advisor asks for a next step: a call, a time, an enrolment, a seat.  Own regexes (the engine's
# ``detect_ask`` is not imported here), read on the advisor's WORDS, not on the simulator's tag.
_NEXT_STEP = re.compile(
    r"\b(?:schedul\w*|book(?:ing)?|set up|arrange|call (?:you )?back|call you|ring you|"
    r"follow[- ]?up|(?:short|quick|brief|another|a) (?:call|chat|meeting)|chat with|talk again|"
    r"enrol+\w*|sign (?:you )?up|reserve|hold (?:your|a|the) (?:seat|spot)|lock (?:in|it|your)|"
    r"payment link|enrol+ment link|get you started|move forward|next step)\b",
    re.IGNORECASE,
)
_OFFERING_VOICE = re.compile(
    r"\b(?:let'?s|i(?:'ll| will| can| could| would)|we(?:'ll| will| can| could| would)|shall|"
    r"how about|would you|do you want|want me to|can i|could i)\b",
    re.IGNORECASE,
)


def advisor_asked_next_step(advisor: Mapping[str, Any]) -> bool:
    """True when the advisor turn asks for a next step, by its tag or by its own words.

    The simulator's ``close_ask`` / ``callback`` / ``accept_callback`` tags are one source; the other is
    the text, because the tag is a model's guess ("... Does Thursday evening work for that call?" came
    tagged ``discount``, "would it make sense to schedule a short call with your partner?" came tagged
    ``answer_objection``; R1-Q iteration 2: both made a call that earned its commitment an
    "unearned_commitment" hard fail).  A sentence counts when it names a next step and is a question or
    speaks in the offering voice.
    """
    if str(advisor.get("intent") or "") in ASK_INTENTS:
        return True
    for sentence in split_sentences(str(advisor.get("text") or "")):
        if _NEXT_STEP.search(sentence) is not None and (
            "?" in sentence or _OFFERING_VOICE.search(sentence) is not None
        ):
            return True
    return False


def _spoke_commitment(ex: Mapping[str, Any]) -> bool:
    """True when the scripted commitment line was part of what the learner said."""
    plan = _learner(ex).get("plan") or {}
    return bool(plan.get("delivered_commitment"))


_GRATITUDE_FOR_PRICE = re.compile(
    r"\b(?:thank(?:s| you)|appreciate|grateful)\b[^.?!]{0,50}\b(?:discount|reduc\w+|lower price|"
    r"better price|better deal|the deal|the price|the offer)\b",
    re.IGNORECASE,
)


def _cut_nearby(exchanges: Sequence[Mapping[str, Any]], index: int) -> bool:
    """The advisor's turn at ``index`` or the one before put a price or a discount on the table.

    The words decide, not the simulator's intent tag.
    """
    for i in (index, index - 1):
        if i < 0:
            continue
        if _DISCOUNT_CUE.search(str(_advisor(exchanges[i]).get("text") or "")):
            return True
    return False


def misfire_metrics(exchanges: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """M9: lines the learner said that the preceding advisor turn did not warrant.

    Iteration 1 adds the live misfires: ``time_cue_reversed`` ("you mentioned you only have a couple
    of minutes"), ``decider_alone`` ("it's just me deciding" for a persona who decides with someone),
    ``anchor_taken_as_offer`` (pleased about the $7,000 the advisor never offered),
    ``gratitude_after_hedge`` (thanks after "I can check with my manager") and
    ``reopened_after_commit`` (a question or a doubt after a MEDIUM or STRONG line).
    """
    found: list[dict[str, Any]] = []
    committed_at: int | None = None
    for index, ex in enumerate(exchanges):
        plan = _learner(ex).get("plan") or {}
        if (
            committed_at is None
            and plan.get("commitment_level") in ("MEDIUM", "STRONG")
            and _spoke_commitment(ex)
        ):
            committed_at = index
    best_offer: int | None = None
    for index, ex in enumerate(exchanges):
        text = str(_learner(ex).get("spoken") or "")
        advisor = _advisor(ex)
        advisor_text = str(advisor.get("text") or "")
        intent = str(advisor.get("intent") or "")
        figures = [value for value in _dollar_figures(advisor_text) if value >= _NET_PRICE_FLOOR]
        if figures:
            best_offer = min([*figures, *([best_offer] if best_offer is not None else [])])
        if _TIME_CUE_REVERSED.search(text):
            found.append({"exchange": index + 1, "kind": "time_cue_reversed"})
        if _DECIDES_ALONE.search(text):
            found.append({"exchange": index + 1, "kind": "decider_alone"})
        if _ANCHOR_AS_OFFER.search(text) and not (best_offer is not None and best_offer <= 7000):
            found.append({"exchange": index + 1, "kind": "anchor_taken_as_offer"})
        if _ADVISOR_HEDGE.search(advisor_text) and not figures and _GRATITUDE_FOR_GRANT.search(text):
            found.append({"exchange": index + 1, "kind": "gratitude_after_hedge"})
        # Thanks (or a "nice surprise") for a price cut nobody made.  A cut in this advisor turn or
        # the one before is on the OFFER LEDGER (R1-Q iteration 3, H2: the judge flagged 12 thanks
        # for cuts the advisor really made); the judge's version of this kind needs this rule to
        # agree.
        if _GRATITUDE_FOR_PRICE.search(text) and not _cut_nearby(exchanges, index):
            found.append({"exchange": index + 1, "kind": "gratitude_unwarranted"})
        if committed_at is not None and index > committed_at and _QUESTION_OR_DOUBT.search(text):
            found.append({"exchange": index + 1, "kind": "reopened_after_commit"})
        # H5: the price cut may sit in a turn the simulator tagged ``answer_objection`` (it was the
        # $4,500 cut of a pushy advisor); the words of the turn decide, not the tag.
        if _SURPRISE.search(text) and not _cut_nearby(exchanges, index):
            found.append({"exchange": index + 1, "kind": "unwarranted_surprise"})
        if _BEFORE_YOU_GO.search(text) and not (
            intent == "farewell" or _ADVISOR_FAREWELL.search(advisor_text)
        ):
            found.append({"exchange": index + 1, "kind": "no_one_leaving"})
        if _TIME_CUE_WORDS.search(text) and float(ex.get("r_sec") or 0.0) < 840:
            found.append({"exchange": index + 1, "kind": "time_cue_too_early"})
        if intent in ASK_INTENTS and (
            fuzzy_contains(text, WEAK_LINE) or fuzzy_contains(text, LEGACY_DEFLECTION)
        ):
            # The one case the scripted WEAK line answers legitimately is a graded WEAK
            # resolution inside the window, which is logged as a commitment, not a stall.
            plan = _learner(ex).get("plan") or {}
            if not plan.get("resolves"):
                found.append({"exchange": index + 1, "kind": "ignored_offer"})
    return {"misfire_count": len(found), "misfires": found}


def schedule_metrics(admin: Mapping[str, Any]) -> dict[str, Any]:
    """Objection deliveries: families delivered, ``max_slip_sec`` per family, fallback rate."""
    schedule = admin.get("schedule") or {}
    families = schedule.get("families") or {}
    delivered = [f for f in FAMILY_IDS if (families.get(f) or {}).get("delivered")]
    slips = {f: (families.get(f) or {}).get("max_slip_sec") for f in FAMILY_IDS}
    known = [value for value in slips.values() if isinstance(value, (int, float))]
    intents = admin.get("intents") or {}
    handed = intents.get("handed_to_model") or {}
    fell = intents.get("fallback_appended") or {}
    handed_total = sum(handed.values())
    fell_total = sum(fell.values())
    moves = {m.get("id"): m for m in schedule.get("moves") or []}
    return {
        "families_delivered": delivered,
        "families_delivered_count": len(delivered),
        "max_slip_sec_by_family": slips,
        "max_slip_sec": max(known) if known else None,
        "exclusion_reasons": list(schedule.get("exclusion_reasons") or []),
        "time_cue_delivered_sec": schedule.get("time_cue_delivered_sec"),
        "intents_handed_to_model": handed_total,
        "intents_fallback_appended": fell_total,
        "intent_fallback_rate": (fell_total / handed_total) if handed_total else None,
        "intent_fallback_by_id": dict(fell),
        "deadline_forced_moves": sorted(
            move_id for move_id, move in moves.items() if move.get("forced") and move.get("status") == "delivered"
        ),
    }


def stall_reason_metrics(admin: Mapping[str, Any]) -> dict[str, Any]:
    """M3c: a stall reason (timing, money, the decision maker) voiced more than once in a call.

    The worker counts each time it proved a reason was raised, whether by a negotiation intent or
    by the owed F4 pair.  A second voicing is the stall loop in different words ("I'd rather wait",
    then "I'll look at the next batch"), which the stall-phrase metric cannot see because it only
    knows the old wording.  Reads the trusted admin log, so it also works on a replay.
    """
    voicings = (admin.get("negotiation") or {}).get("reason_voicings") or {}
    repeated = {
        reason: count - 1
        for reason, count in voicings.items()
        if isinstance(count, int) and count > 1
    }
    return {
        "stall_reason_voicings": dict(voicings),
        "stall_reason_repeats": sum(repeated.values()),
        "stall_reason_repeated": sorted(repeated),
    }


_FINAL_PRICE_QUESTION = re.compile(
    r"\bfinal (?:price|number|offer|amount)\b|\bbest (?:price|you can|offer|number|deal)\b"
    r"|\b(?:is|was) (?:that|this|it)\b[^.?!]{0,25}\b(?:final|last|best)\b|\blowest\b",
    re.IGNORECASE,
)
# Two "is that the final price?" questions this close are one question twice (the pleased anchor
# and the met counter used to be, with no new advisor price between them).
FINAL_PRICE_NEAR_EXCHANGES = 3


def final_price_metrics(exchanges: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """M3d: the learner asking "is that the final price?" again within a few exchanges.

    The near-repeat metric compares wording, so it cannot see the same question in different
    words ("Is that your final price?" then "Is this the final price?").  Counts the exchanges
    whose learner line asks it, and flags two within ``FINAL_PRICE_NEAR_EXCHANGES`` of each other.
    """
    asked: list[int] = []
    for index, ex in enumerate(exchanges):
        spoken = str(_learner(ex).get("spoken") or "")
        if any("?" in sentence and _FINAL_PRICE_QUESTION.search(sentence)
               for sentence in split_sentences(spoken)):
            asked.append(index + 1)
    near = [(a, b) for a, b in zip(asked, asked[1:]) if b - a <= FINAL_PRICE_NEAR_EXCHANGES]
    return {
        "final_price_questions": len(asked),
        "final_price_question_exchanges": asked,
        "final_price_asked_twice": len(near),
    }


def guard_metrics(
    admin: Mapping[str, Any],
    guard_trips: Sequence[Mapping[str, Any]],
    exchanges: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """M19: guard hits by kind, fidelity, plus commitment hits after the commitment (T04 risk)."""
    guard = admin.get("guard") or {}
    by_category = dict(guard.get("by_category") or {})
    fidelity = admin.get("fidelity") or {}
    commitment = admin.get("commitment") or {}
    turn_map = {item.get("roleplay_turn"): item.get("transcript_turn") for item in admin.get("turn_map", [])}
    commit_turn = turn_map.get(commitment.get("turn")) if commitment.get("turn") else None
    after = 0
    if commit_turn is not None:
        after = sum(
            1
            for trip in guard_trips
            if trip.get("category") == "commitment"
            and isinstance(trip.get("turn_index"), (int, float))
            and trip["turn_index"] > commit_turn
        )
    raw_over_cap = sum(
        1 for ex in exchanges if words_of(_learner(ex).get("raw") or "") > REPLY_WORD_CAP
    )
    return {
        "guard_hits_total": int(guard.get("hits") or 0),
        "guard_leak_hits": int(guard.get("leak_hits") or 0),
        "guard_hygiene_hits": int(guard.get("hygiene_hits") or 0),
        "guard_by_category": by_category,
        "guard_flagged": bool(guard.get("flagged")),
        "commitment_guard_hits": int(by_category.get("commitment", 0)),
        "concession_guard_hits": int(by_category.get("concession", 0)),
        "commitment_hits_after_commitment": after,
        "raw_replies_over_cap": raw_over_cap,
        "fidelity_passes": fidelity.get("passes"),
        "fidelity_failed_checks": sorted(
            name for name, ok in (fidelity.get("checks") or {}).items() if not ok
        ),
    }


def latency_metrics(exchanges: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """M20 (informational): learner model first-token and total time."""
    firsts = [
        float(v)
        for ex in exchanges
        if isinstance(v := (_learner(ex).get("latency") or {}).get("first_token"), (int, float))
    ]
    totals = [
        float(v)
        for ex in exchanges
        if isinstance(v := (_learner(ex).get("latency") or {}).get("total"), (int, float))
    ]
    return {
        "learner_ttft_p50": percentile(firsts, 50),
        "learner_ttft_p95": percentile(firsts, 95),
        "learner_total_p50": percentile(totals, 50),
        "learner_total_p95": percentile(totals, 95),
    }


# --------------------------------------------------------------------------------- the call
def call_metrics(record: Mapping[str, Any]) -> dict[str, Any]:
    """All deterministic metrics of one rehearsal call (``record`` as ``call.run_call`` returns)."""
    header = record.get("header") or {}
    rows = record.get("rows") or []
    exchanges = record.get("exchanges") or []
    admin = record.get("admin_log") or {}
    advisor_texts = [str(_advisor(ex).get("text") or "") for ex in exchanges]
    ledger_prices = [
        int(offer["net_usd"])
        for offer in (admin.get("negotiation") or {}).get("offers") or []
        if isinstance(offer, Mapping) and isinstance(offer.get("net_usd"), (int, float))
    ]
    out = row_metrics(rows, advisor_texts, ledger_prices)
    persona = resolve_persona(
        str(header.get("persona_id")),
        variant=str(header.get("persona_variant") or "default"),
        seed=str(header.get("seed") or ""),
        avoid_first_name=str(header.get("candidate_name") or ""),
    )
    out.update(disclosure_metrics(persona, exchanges))
    out.update(commitment_metrics(exchanges, admin))
    out.update(misfire_metrics(exchanges))
    out.update(schedule_metrics(admin))
    out.update(stall_reason_metrics(admin))
    out.update(final_price_metrics(exchanges))
    out.update(guard_metrics(admin, record.get("guard_trips") or [], exchanges))
    out.update(latency_metrics(exchanges))
    out["exchanges"] = len(exchanges)
    out["roleplay_seconds"] = record.get("roleplay_seconds")
    out["stop_reason"] = record.get("stop_reason")
    out["error"] = record.get("error")
    return out


def hard_fails(metrics: Mapping[str, Any]) -> list[str]:
    """Per-call hard fails (research 4.6): any one of these fails the call."""
    fails: list[str] = []
    if metrics.get("error"):
        fails.append("exception")
    if (metrics.get("weak_line_count") or 0) > 1:
        fails.append("weak_stall_repeated")
    if (metrics.get("stall_family_rows") or 0) > STALL_PHRASE_LIMIT:
        fails.append("stall_phrases_repeated")
    if (metrics.get("stall_reason_repeats") or 0) >= 1:
        fails.append("stall_reason_repeated")
    if (metrics.get("final_price_asked_twice") or 0) >= 1:
        fails.append("final_price_asked_twice")
    if metrics.get("long_exact_repeat"):
        fails.append("exact_repeat_sentence")
    if (metrics.get("deflection_count") or 0) >= 1:
        fails.append("catch_all_deflection")
    if (metrics.get("fact_error_count") or 0) >= 1:
        fails.append("fact_error")
    if (metrics.get("premature_commit_count") or 0) >= 1 or (
        metrics.get("concession_guard_hits") or 0
    ) >= 1:
        fails.append("premature_commit_or_concession")
    if (metrics.get("name_fallback") or 0) >= 1:
        fails.append("name_fallback")
    if (metrics.get("farewell_rows") or 0) > 1:
        fails.append("double_goodbye")
    if (metrics.get("repeated_phrase_rows") or 0) >= 1:
        fails.append("repeated_phrase_in_row")
    if metrics.get("commitment_earned") is False:
        fails.append("unearned_commitment")
    if metrics.get("guard_flagged") or (metrics.get("commitment_guard_hits") or 0) >= 1:
        fails.append("guard_flagged")
    return fails
