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
fragmentation, M19 guard and fidelity, M21 neutral acks.
"""
from __future__ import annotations

import difflib
import math
import re
import unicodedata
from typing import Any, Iterable, Mapping, Sequence

from r1_commitment import COMMIT_PERMITTED_R_SEC, stall_line
from r1_guard import FALLBACK_REPLIES, NEUTRAL_ACKS, REPLY_WORD_CAP
from r1_personas import H_TOPICS, deep_need_topics_in, resolve_persona
from r1_text import fuzzy_contains, split_sentences
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
def fact_error_metrics(texts: Sequence[str], advisor_texts: Sequence[str] = ()) -> dict[str, Any]:
    """M10: the learner contradicting the deck (price, duration, a guarantee).

    A figure the advisor said earlier, or the $7,000 anchor, is not an error: the learner is
    allowed to repeat what it heard.  The deck's own numbers are never errors.
    """
    allowed = {PRICE_USD, 7000, *NET_PRICES_USD, *DISCOUNTS_USD}
    for text in advisor_texts:
        allowed.update(_dollar_figures(text))
    errors: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        codes: list[str] = []
        if claims_guarantee(text):
            codes.append("guarantee_claim")
        for sentence in split_sentences(text):
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
    return {
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


def row_metrics(rows: Sequence[Mapping[str, Any]], advisor_texts: Sequence[str] = ()) -> dict[str, Any]:
    """Every metric that needs only the persisted rows (works on a real session export)."""
    texts = reply_texts(rows)
    out: dict[str, Any] = {}
    out.update(repeat_metrics(texts))
    out.update(weak_metrics(texts))
    out.update(fact_error_metrics(texts, advisor_texts))
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
        topic = str(advisor.get("topic") or "")
        intent = str(advisor.get("intent") or "")
        if topic in touches and intent in PROBE_INTENTS:
            touches[topic].append((index, intent))
    probed: list[str] = []
    dug: list[str] = []
    disclosed: list[str] = []
    deep_on_first_probe: list[str] = []
    for topic, marks in touches.items():
        if not any(intent == "probe" for _i, intent in marks):
            continue
        probed.append(topic)
        first_probe = next(i for i, intent in marks if intent == "probe")
        later = [i for i, _intent in marks if i > first_probe]
        if later or sum(1 for _i, intent in marks if intent == "probe") >= 2:
            dug.append(topic)
            window_end = max(i for i, _intent in marks) + DEEP_WINDOW_TURNS
            if any(topic in deep_by_turn[i] for i in range(first_probe, min(window_end + 1, len(spoken)))):
                disclosed.append(topic)
        if topic in deep_by_turn[first_probe]:
            deep_on_first_probe.append(topic)
    unprompted: list[dict[str, Any]] = []
    for index, topics in enumerate(deep_by_turn):
        for topic in sorted(topics):
            recent = [
                i for i, _intent in touches.get(topic, []) if index - DEEP_WINDOW_TURNS <= i <= index
            ]
            if not recent:
                unprompted.append({"exchange": index + 1, "topic": topic})
    return {
        "needs_probed": sorted(probed),
        "needs_dug": sorted(dug),
        "needs_disclosed_after_dig": sorted(disclosed),
        "disclosure_rate": (len(disclosed) / len(dug)) if dug else None,
        "deep_on_first_probe": sorted(deep_on_first_probe),
        "unprompted_dump_count": len(unprompted),
        "unprompted_dumps": unprompted,
        "deep_revealed_total": len({t for topics in deep_by_turn for t in topics}),
    }


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
        earned = any(str(_advisor(exchanges[i]).get("intent") or "") in ASK_INTENTS for i in window)
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


def _spoke_commitment(ex: Mapping[str, Any]) -> bool:
    """True when the scripted commitment line was part of what the learner said."""
    plan = _learner(ex).get("plan") or {}
    return bool(plan.get("delivered_commitment"))


def misfire_metrics(exchanges: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """M9: lines the learner said that the preceding advisor turn did not warrant."""
    found: list[dict[str, Any]] = []
    for index, ex in enumerate(exchanges):
        text = str(_learner(ex).get("spoken") or "")
        advisor = _advisor(ex)
        advisor_text = str(advisor.get("text") or "")
        intent = str(advisor.get("intent") or "")
        if _SURPRISE.search(text) and not (
            intent in ("discount", "price") and _DISCOUNT_CUE.search(advisor_text)
        ):
            found.append({"exchange": index + 1, "kind": "unwarranted_surprise"})
        if _BEFORE_YOU_GO.search(text) and not (
            intent == "farewell" or _ADVISOR_FAREWELL.search(advisor_text)
        ):
            found.append({"exchange": index + 1, "kind": "no_one_leaving"})
        if _TIME_CUE_WORDS.search(text) and float(ex.get("r_sec") or 0.0) < 600:
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
    out = row_metrics(rows, advisor_texts)
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
