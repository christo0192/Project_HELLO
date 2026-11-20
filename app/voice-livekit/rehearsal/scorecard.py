"""The aggregate scorecard: per advisor level, against the pass thresholds.

Thresholds are the proposals of research/rehearsal-harness.md 4.6 ("tune after the first two
sweeps"): hard-fail rate zero, objections raised and in context, needs disclosed after a genuine
probe, no unprompted dump, the commitment earned (STRONG for a strong advisor, never for a weak
one), no repeats, a human reply length and style.  A gate whose metric was not measured (the
judge gates in an offline sweep, the simulator gates with a scripted advisor, anything that needs
the full flow) is ``n/a``, never a pass: ``ready_for_owner_test`` needs every applicable gate
measured and met on a LIVE sweep.

``info`` gates (the intent fallback rate, and since R1-Q iteration 1 the reply-length gates: mean
<= 22 words, p90 <= 35, short replies >= 30 %) are reported but never block.  Wordiness is the
owner's accepted trade (2026-10-08); the verbal-tic gates (any first word opening more than 15 % of
the replies, "hmm" or "honestly" in more than 20 %) block instead.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Mapping, Sequence

from r1_commitment import COMMIT_PERMITTED_R_SEC

from rehearsal import flags
from rehearsal.metrics import mean

LEVEL_GROUP = {
    "strong": "strong",
    "average": "average",
    "weak": "other",
    "pushy": "other",
    "terse": "other",
}
ALL_GROUPS = {"strong": 0.0, "average": 0.0, "other": 0.0}
MIN_CALLS_FOR_READY = 20
# Verbal tics (owner decision 2026-10-08): the live sweep had "Hmm" opening 44 of 90 replies and
# "Honestly" in 50 of 90.
OPENER_SHARE_LIMIT = 0.15
TIC_SHARE_LIMIT = 0.20

# (id, label, metric, op, {group: threshold}, kind)
GATES: tuple[tuple[str, str, str, str, Mapping[str, float], str], ...] = (
    ("hard_fails", "Hard-fail rate", "hard_fail_rate", "<=", ALL_GROUPS, "gate"),
    (
        "families",
        "Calls reaching 13:00 that raised 3+ of the 4 objection families",
        "families_3plus_rate",
        ">=",
        {"strong": 0.9, "average": 0.8},
        "gate",
    ),
    (
        "in_context",
        "Objections in context (judge)",
        "objections_in_context_rate",
        ">=",
        {"strong": 0.9, "average": 0.85, "other": 0.8},
        "gate",
    ),
    (
        "misfires",
        "Out-of-context / misfire lines per call",
        "misfires_per_call",
        "<=",
        {"strong": 0.2, "average": 0.3, "other": 0.3},
        "gate",
    ),
    # D2-HM1: the gate caps one call's contribution at ``MISFIRE_CALL_CAP``; the uncapped mean is info.
    (
        "misfires_uncapped",
        "Misfire lines per call, uncapped (info)",
        "misfires_per_call_uncapped",
        "<=",
        {"strong": 0.2, "average": 0.3, "other": 0.3},
        "info",
    ),
    (
        "disclosure",
        "Needs disclosed within 2 turns of a genuine probe",
        "disclosure_rate",
        ">=",
        {"strong": 0.8, "average": 0.6},
        "gate",
    ),
    # D2-ND1: the same rate over the digs the engine's own needs ledger confirms, and the digs only the
    # harness counted.  Info: the gate above keeps every harness dig, since a dig the engine missed is
    # a product failure the engine's own detector cannot report.
    (
        "disclosure_confirmed",
        "Needs disclosed, engine-confirmed digs only (info)",
        "disclosure_rate_engine_confirmed",
        ">=",
        {"strong": 0.8, "average": 0.6},
        "info",
    ),
    (
        "harness_only_digs",
        "Harness-only digs (the engine saw no follow-up) (info)",
        "harness_only_digs_total",
        "<=",
        {"strong": 0, "average": 0, "other": 0},
        "info",
    ),
    (
        "dump",
        "Calls with an unprompted need dump",
        "unprompted_dump_call_rate",
        "<=",
        {"strong": 0.05, "average": 0.05, "other": 0.05},
        "gate",
    ),
    ("commit_medium", "Commitment MEDIUM or better", "medium_or_better_rate", ">=", {"strong": 0.9}, "gate"),
    # Iteration 2 (D22): info.  ``r1_commitment.grade`` caps an ask of kind CALL at MEDIUM, and every
    # persona names a decision maker, so a strong advisor correctly asks for a call with that person:
    # in two sweeps every in-window ask was a call and STRONG was 0 of 8.  Gating on it measured the
    # simulator's choice of ask, not the learner.  The blocking half is ``commit_medium`` above.
    (
        "commit_strong",
        "Commitment STRONG (info: a call ask caps at MEDIUM)",
        "strong_rate",
        ">=",
        {"strong": 0.5},
        "info",
    ),
    (
        "commit_cap",
        "Commitment MEDIUM or better (capped)",
        "medium_or_better_rate",
        "<=",
        {"average": 0.6, "other": 0.2},
        "gate",
    ),
    ("no_strong", "Commitment STRONG (must not happen)", "strong_rate", "<=", {"other": 0.0}, "gate"),
    (
        "near_repeat",
        "Near-repeat sentences per call",
        "near_repeat_per_call",
        "<=",
        {"strong": 1.0, "average": 1.0, "other": 1.0},
        "gate",
    ),
    ("weak_once", "WEAK line at most once per call (max)", "weak_line_max", "<=", {"strong": 1, "average": 1, "other": 1}, "gate"),
    (
        "post_commit",
        "Commitment guard hits after the commitment",
        "commitment_hits_after_commitment",
        "<=",
        ALL_GROUPS,
        "gate",
    ),
    # D2-HF2: a commitment the guard blocked never reached the candidate (a spoken one is a hard fail,
    # ``guard_flagged``); how often the guard had to block one is reported here.
    (
        "commit_blocked",
        "Blocked commitment attempts per call (info: the guard caught them)",
        "commitment_blocked_per_call",
        "<=",
        {"strong": 1.0, "average": 1.0, "other": 1.0},
        "info",
    ),
    # R1-Q round 2: the reworded reaction prompts are proved on a live sweep, where a reply that
    # restates a course detail is blocked as ``invented_fact``.  Offline the model is scripted, so
    # this only checks the plumbing.  The gate counts the replies the guard BLOCKED (leaks:
    # invented_fact, concession, volunteered_need ...); the repetition guard dropping a sentence
    # the learner already said (hygiene) is reported with it but never blocks.
    (
        "guard_leak",
        "Guard leak hits per call (mean; blocked replies)",
        "guard_leak_hits_per_call",
        "<=",
        {"strong": 1.0, "average": 1.0, "other": 1.0},
        "gate",
    ),
    (
        "guard_per_call",
        "Guard hits per call (mean, hygiene included) (info)",
        "guard_hits_per_call",
        "<=",
        {"strong": 1.0, "average": 1.0, "other": 1.0},
        "info",
    ),
    (
        "length_low",
        "Reply length, mean words >= 8",
        "reply_words_mean",
        ">=",
        {"strong": 8, "average": 8, "other": 8},
        "gate",
    ),
    (
        "length_high",
        "Reply length, mean words <= 22 (info: wordiness is accepted)",
        "reply_words_mean",
        "<=",
        {"strong": 22, "average": 22, "other": 22},
        "info",
    ),
    (
        "length_p90",
        "Reply length, p90 words <= 35 (info: wordiness is accepted)",
        "reply_words_p90",
        "<=",
        {"strong": 35, "average": 35, "other": 35},
        "info",
    ),
    (
        "short_share",
        "Short replies (<= 8 words) share >= 30 % (info: wordiness is accepted)",
        "short_reply_share",
        ">=",
        {"strong": 0.3, "average": 0.3, "other": 0.3},
        "info",
    ),
    (
        "opener_tic",
        "No first word opens more than 15 % of the replies",
        "opener_top_share",
        "<=",
        {"strong": OPENER_SHARE_LIMIT, "average": OPENER_SHARE_LIMIT, "other": OPENER_SHARE_LIMIT},
        "gate",
    ),
    (
        "hmm_tic",
        '"hmm" in at most 20 % of the replies',
        "hmm_share",
        "<=",
        {"strong": TIC_SHARE_LIMIT, "average": TIC_SHARE_LIMIT, "other": TIC_SHARE_LIMIT},
        "gate",
    ),
    (
        "honestly_tic",
        '"honestly" in at most 20 % of the replies',
        "honestly_share",
        "<=",
        {"strong": TIC_SHARE_LIMIT, "average": TIC_SHARE_LIMIT, "other": TIC_SHARE_LIMIT},
        "gate",
    ),
    # Phrase tics beyond the filler words (iteration 2): "a stretch" and the "what would that call
    # involve" question may be used about once per call; the guard rewrites and drops the rest.
    (
        "stretch_tic",
        'Replies with "a stretch" per call (mean)',
        "stretch_per_call",
        "<=",
        {"strong": 1.5, "average": 1.5, "other": 1.5},
        "gate",
    ),
    (
        "template_tic",
        'Replies asking "what would it involve / cover" per call (mean)',
        "template_q_per_call",
        "<=",
        {"strong": 1.5, "average": 1.5, "other": 1.5},
        "gate",
    ),
    # Stall loops (R1-Q final review round 1): the same stall in other words.  The guard keeps a
    # quota and a spacing window for the decider stall and the money line; these gates prove it live.
    (
        "decider_stall",
        'Replies stalling on the decision maker ("talk it over with my father") per call (mean)',
        "decider_stall_per_call",
        "<=",
        {"strong": 3.0, "average": 3.0, "other": 3.0},
        "gate",
    ),
    (
        "decider_stall_window",
        "Decider stall: most replies in any 4 in a row (worst call)",
        "decider_stall_window_max",
        "<=",
        {"strong": 2.0, "average": 2.0, "other": 2.0},
        "gate",
    ),
    (
        "money_strain",
        'Replies saying it is "still more than I planned for" per call (mean)',
        "money_strain_per_call",
        "<=",
        {"strong": 3.0, "average": 3.0, "other": 3.0},
        "gate",
    ),
    (
        "money_strain_window",
        "Money line: most replies in any 3 in a row (worst call)",
        "money_strain_window_max",
        "<=",
        {"strong": 2.0, "average": 2.0, "other": 2.0},
        "gate",
    ),
    (
        "style",
        "Human-style rubric, mean (judge)",
        "style_mean",
        ">=",
        {"strong": 3.8, "average": 3.8, "other": 3.8},
        "gate",
    ),
    (
        "style_min",
        "Human-style rubric, worst call (judge)",
        "style_min",
        ">=",
        {"strong": 3.0, "average": 3.0, "other": 3.0},
        "gate",
    ),
    (
        "question_low",
        "Question rate >= 25 %",
        "question_rate",
        ">=",
        {"strong": 0.25, "average": 0.25, "other": 0.25},
        "gate",
    ),
    (
        "question_high",
        "Question rate <= 60 %",
        "question_rate",
        "<=",
        {"strong": 0.6, "average": 0.6, "other": 0.6},
        "gate",
    ),
    (
        "sim_inversion",
        "Simulator role inversion <= 2 %",
        "advisor_inversion_rate",
        "<=",
        {"strong": 0.02, "average": 0.02, "other": 0.02},
        "gate",
    ),
    (
        "sim_json",
        "Simulator JSON parse failures <= 5 %",
        "advisor_parse_failure_rate",
        "<=",
        {"strong": 0.05, "average": 0.05, "other": 0.05},
        "gate",
    ),
    (
        "fallback",
        "Intents that needed the scripted variant (info)",
        "intent_fallback_rate",
        "<=",
        {"strong": 0.35, "average": 0.35, "other": 0.35},
        "info",
    ),
)

LEVELS_ORDER = ("strong", "average", "weak", "pushy", "terse", "closer", "closer_india")


def _rate(numerator: float, denominator: float) -> float | None:
    return (numerator / denominator) if denominator else None


# D2-HM1: one call adds at most this many misfires to a level's mean (a chaotic replay cannot fail a
# small level on its own; the uncapped mean is reported as info).
MISFIRE_CALL_CAP = 5
# D2-SC1: the commitment gates and the count behind each (over the calls that had a commitment window).
COMMITMENT_METRICS = {
    "medium_or_better_rate": "medium_or_better_count",
    "strong_rate": "strong_count",
}


def commitment_exclusion(record: Mapping[str, Any], m: Mapping[str, Any]) -> str | None:
    """Why a call had no commitment window (D2-SC1), or None when it had one.

    Only a call with no commitment at all is excluded: its role-play ended on an end request, on the
    abuse hang-up (D-M032-3) or before the close window opened (13:00).  A call that reached a level
    always counts, and so does a full call that reached none (that is a miss, not an exclusion).

    An end request or the abuse hang-up excludes a call only while the window was still shut: once
    the role-play passed 13:00 the learner had its chance to commit (the advisor may have asked and
    been stalled), so a late "let's stop here" (R1_LATE_END_REQUEST) leaves a miss counted.  Without
    a role-play time the reason alone excludes, as before.
    """
    if m.get("commitment_level") is not None:
        return None
    seconds = m.get("roleplay_seconds")
    opening = ((record.get("admin_log") or {}).get("close_window") or {}).get("open_r")
    threshold = opening if type(opening) is int else COMMIT_PERMITTED_R_SEC
    if isinstance(seconds, (int, float)) and seconds >= threshold:
        return None
    if m.get("stop_reason") == "end_request":
        return "end_request"
    hangups = m.get("abuse_hangups")
    if hangups is None:
        hangups = ((record.get("admin_log") or {}).get("endings") or {}).get("abuse_hangups")
    if isinstance(hangups, (int, float)) and hangups >= 1:
        return "abuse_hangup"
    if isinstance(seconds, (int, float)):
        return "ended_before_window"
    return None


def merged_metrics(record: Mapping[str, Any]) -> dict[str, Any]:
    """A call's deterministic metrics plus its judge metrics (judge keys are prefixed)."""
    out = dict(record.get("metrics") or {})
    judge = record.get("judge") or {}
    out.update(judge.get("metrics") or {})
    out["_judge_source"] = judge.get("source")
    return out


def aggregate_group(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """All aggregate metrics of the calls in one group."""
    calls = [merged_metrics(record) for record in records]
    n = len(calls)
    failing = [record for record in records if record.get("hard_fails")]
    reasons = Counter(reason for record in records for reason in record.get("hard_fails") or [])
    closing = [m for m in calls if (m.get("roleplay_seconds") or 0) >= 780]
    in_ctx = sum(m.get("judge_objections_in_context") or 0 for m in calls)
    objections = sum(m.get("judge_objections") or 0 for m in calls)
    dug = sum(len(m.get("needs_dug") or []) for m in calls)
    disclosed = sum(len(m.get("needs_disclosed_after_dig") or []) for m in calls)
    levels = Counter(m.get("commitment_level") or "NONE" for m in calls)
    exclusions = [commitment_exclusion(record, m) for record, m in zip(records, calls)]
    windowed_on = flags.on(flags.COMMIT_WINDOW)
    windowed = [m for m, why in zip(calls, exclusions) if why is None or not windowed_on]
    window_levels = Counter(m.get("commitment_level") or "NONE" for m in windowed)
    medium_count = window_levels.get("MEDIUM", 0) + window_levels.get("STRONG", 0)
    handed = sum(m.get("intents_handed_to_model") or 0 for m in calls)
    fell = sum(m.get("intents_fallback_appended") or 0 for m in calls)
    judged = [m for m in calls if m.get("judge_style_mean") is not None]
    exchanges = [ex for record in records for ex in record.get("exchanges") or []]
    live_advisor = [r for r in records if not (r.get("header") or {}).get("offline")]
    advisor_turns = [
        ex["advisor"] for r in live_advisor for ex in r.get("exchanges") or []
    ]
    guard: Counter[str] = Counter()
    for m in calls:
        guard.update(m.get("guard_by_category") or {})
    slips: dict[str, float | None] = {}
    for family in ("F1", "F2", "F3", "F4"):
        values = [
            (m.get("max_slip_sec_by_family") or {}).get(family)
            for m in calls
            if isinstance((m.get("max_slip_sec_by_family") or {}).get(family), (int, float))
        ]
        slips[family] = max(values) if values else None
    misfire_values = [
        float(m["judge_misfire_count"]) if m.get("judge_misfire_count") is not None else float(m.get("misfire_count") or 0)
        for m in calls
    ]
    capped = flags.on(flags.CITED_MISFIRES)
    gated_misfires = [min(value, float(MISFIRE_CALL_CAP)) if capped else value for value in misfire_values]
    judge_misfires = [float(m["judge_misfire_count"]) for m in calls if m.get("judge_misfire_count") is not None]
    # Tics are pooled over the group's replies (a share of all replies, not a mean of call shares).
    replies = sum(int(m.get("reply_count") or 0) for m in calls)
    openers: Counter[str] = Counter()
    for m in calls:
        openers.update(m.get("opener_counts") or {})
    top = openers.most_common(1)
    misfire_kinds: Counter[str] = Counter(
        str(item.get("kind")) for m in calls for item in m.get("misfires") or []
    )
    return {
        "opener_top_word": top[0][0] if top else None,
        "opener_top_share": _rate(top[0][1], replies) if top else (0.0 if replies else None),
        "stretch_per_call": mean([float(m.get("reply_stretch_count") or 0) for m in calls]),
        "template_q_per_call": mean([float(m.get("reply_template_q_count") or 0) for m in calls]),
        "decider_stall_per_call": mean([float(m.get("decider_stall_rows") or 0) for m in calls]),
        "decider_stall_window_max": max(
            [float(m.get("decider_stall_window_max") or 0) for m in calls], default=None
        ),
        "money_strain_per_call": mean([float(m.get("money_strain_rows") or 0) for m in calls]),
        "money_strain_window_max": max(
            [float(m.get("money_strain_window_max") or 0) for m in calls], default=None
        ),
        "hmm_share": _rate(sum(int(m.get("reply_hmm_count") or 0) for m in calls), replies),
        "honestly_share": _rate(
            sum(int(m.get("reply_honestly_count") or 0) for m in calls), replies
        ),
        "misfire_kinds": dict(misfire_kinds),
        "calls": n,
        "hard_fail_calls": len(failing),
        "hard_fail_rate": _rate(len(failing), n),
        "hard_fail_reasons": dict(reasons),
        "calls_reaching_close_window": len(closing),
        "families_3plus_rate": _rate(
            # M033 A6: a planned call raises 2-4 families; it needs min(3, planned) of them.
            sum(
                1 for m in closing
                if (m.get("families_delivered_count") or 0)
                >= min(3, m.get("families_planned_count") or 4)
            ),
            len(closing),
        ),
        "objections_in_context_rate": _rate(in_ctx, objections),
        "judge_calls": len(judged),
        "misfires_per_call": mean(gated_misfires),
        "misfires_per_call_uncapped": mean(misfire_values),
        "judge_misfires_per_call": mean(judge_misfires),
        "rule_misfires_per_call": mean([float(m.get("misfire_count") or 0) for m in calls]),
        "judge_misfires_rejected_per_call": mean(
            [float(m.get("judge_misfires_rejected") or 0) for m in calls if m.get("judge_misfire_count") is not None]
        ),
        "disclosure_rate": _rate(disclosed, dug),
        "needs_dug_total": dug,
        "disclosure_rate_engine_confirmed": _rate(
            sum(len(m.get("needs_disclosed_confirmed") or []) for m in calls),
            sum(len(m.get("needs_dug_confirmed") or []) for m in calls),
        ),
        "harness_only_digs_total": (
            sum(len(m.get("harness_only_digs") or []) for m in calls)
            if any(m.get("harness_only_digs") is not None for m in calls)
            else None
        ),
        "engine_only_digs_total": (
            sum(len(m.get("engine_only_digs") or []) for m in calls)
            if any(m.get("engine_only_digs") is not None for m in calls)
            else None
        ),
        # D4-H-DIG1: harness digs the gate did not release at that exchange (a product signal).
        "probe_unreleased_total": (
            sum(len(m.get("probe_unreleased") or []) for m in calls)
            if any(m.get("probe_unreleased") is not None for m in calls)
            else None
        ),
        "unprompted_dump_call_rate": _rate(
            sum(1 for m in calls if (m.get("unprompted_dump_count") or 0) >= 1), n
        ),
        "commitment_levels": dict(levels),
        "medium_or_better_rate": _rate(medium_count, len(windowed)),
        "strong_rate": _rate(window_levels.get("STRONG", 0), len(windowed)),
        "medium_or_better_count": medium_count,
        "strong_count": window_levels.get("STRONG", 0),
        "commitment_window_calls": len(windowed),
        "commitment_excluded": n - len(windowed),
        "commitment_excluded_reasons": dict(
            Counter(why for why in exclusions if why is not None) if windowed_on else {}
        ),
        "medium_or_better_rate_all": _rate(levels.get("MEDIUM", 0) + levels.get("STRONG", 0), n),
        "strong_rate_all": _rate(levels.get("STRONG", 0), n),
        "near_repeat_per_call": mean([float(m.get("near_repeat_count") or 0) for m in calls]),
        "exact_repeat_per_call": mean([float(m.get("exact_repeat_extra") or 0) for m in calls]),
        "weak_line_max": max([int(m.get("weak_line_count") or 0) for m in calls], default=None),
        "commitment_hits_after_commitment": sum(
            int(m.get("commitment_hits_after_commitment") or 0) for m in calls
        ),
        "commitment_blocked_per_call": mean([float(m.get("commitment_guard_hits") or 0) for m in calls]),
        "commitment_spoken_leaks": sum(int(m.get("commitment_spoken_leaks") or 0) for m in calls),
        "reply_words_mean": mean(_floats(calls, "reply_words_mean")),
        "reply_words_p90": mean(_floats(calls, "reply_words_p90")),
        "short_reply_share": mean(_floats(calls, "short_reply_share")),
        "question_rate": mean(_floats(calls, "question_rate")),
        "reaction_rate": mean(_floats(calls, "reaction_rate")),
        "style_mean": mean([float(m["judge_style_mean"]) for m in judged]),
        "style_min": min((float(m["judge_style_mean"]) for m in judged), default=None),
        "intent_fallback_rate": _rate(fell, handed),
        "max_slip_sec_by_family": slips,
        "guard_by_category": dict(guard),
        "guard_hits_per_call": mean(_floats(calls, "guard_hits_total")),
        "guard_leak_hits_per_call": mean(_floats(calls, "guard_leak_hits")),
        "guard_hygiene_hits_per_call": mean(_floats(calls, "guard_hygiene_hits")),
        "guard_hits_max_per_call": max(_floats(calls, "guard_hits_total"), default=None),
        "invented_fact_hits_per_call": (
            mean([float((m.get("guard_by_category") or {}).get("invented_fact", 0)) for m in calls])
            if any("guard_hits_total" in m for m in calls)
            else None
        ),
        "fidelity_pass_rate": _rate(sum(1 for m in calls if m.get("fidelity_passes")), n),
        "exchanges_mean": mean([float(m.get("exchanges") or 0) for m in calls]),
        "roleplay_seconds_mean": mean(_floats(calls, "roleplay_seconds")),
        "stop_reasons": dict(Counter(str(m.get("stop_reason")) for m in calls)),
        "advisor_inversion_rate": _rate(
            sum(1 for turn in advisor_turns if turn.get("inverted")), len(advisor_turns)
        ),
        "advisor_parse_failure_rate": _rate(
            sum(1 for turn in advisor_turns if not turn.get("parse_ok", True)), len(advisor_turns)
        ),
        "exchange_count": len(exchanges),
    }


def _floats(calls: Sequence[Mapping[str, Any]], key: str) -> list[float]:
    return [float(m[key]) for m in calls if isinstance(m.get(key), (int, float))]


def aggregate(records: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Aggregate by advisor level (in a fixed order) plus an ``all`` row."""
    by_level: dict[str, list[Mapping[str, Any]]] = {}
    for record in records:
        level = str((record.get("header") or {}).get("advisor_level"))
        by_level.setdefault(level, []).append(record)
    out = {level: aggregate_group(by_level[level]) for level in LEVELS_ORDER if level in by_level}
    for level in by_level:
        if level not in out:
            out[level] = aggregate_group(by_level[level])
    out["all"] = aggregate_group(records)
    return out


def _compare(op: str, value: float, threshold: float) -> bool:
    return value >= threshold if op == ">=" else value <= threshold


# Iteration 2 (D24): a cap on a rate ("MEDIUM or better in at most 20 % of the calls") cannot be met
# by a group of fewer than ``CAP_MIN_CALLS`` calls when one call is already more than the cap: with
# four pushy calls one booked call is 0.25.  A group that small may exceed a cap by that one call.
CAP_MIN_CALLS = 8
SMALL_GROUP_CAP_GATES = frozenset({"commit_cap"})


def effective_threshold(gate_id: str, op: str, threshold: float, calls: int) -> float:
    """The threshold a group is held to: a cap gets one call of slack below ``CAP_MIN_CALLS`` calls."""
    if gate_id in SMALL_GROUP_CAP_GATES and op == "<=" and 0 < calls < CAP_MIN_CALLS:
        return max(threshold, 1.0 / calls)
    return threshold


def evaluate(agg: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every gate that applies to a group, with its value and a status."""
    results: list[dict[str, Any]] = []
    for level, group in agg.items():
        if level == "all":
            continue
        kind = LEVEL_GROUP.get(level, "other")
        for gate_id, label, metric, op, thresholds, severity in GATES:
            if kind not in thresholds:
                continue
            value = group.get(metric)
            threshold = thresholds[kind]
            note = None
            denominator = int(group.get("calls") or 0)
            if metric in COMMITMENT_METRICS and flags.on(flags.COMMIT_WINDOW):
                denominator = int(group.get("commitment_window_calls") or 0)
                note = _commitment_note(group, COMMITMENT_METRICS[metric])
            held_to = effective_threshold(gate_id, op, threshold, denominator)
            if value is None:
                status = "n/a"
            else:
                passed = _compare(op, float(value), float(held_to))
                status = "pass" if passed else ("fail" if severity == "gate" else "info-fail")
            results.append(
                {
                    "level": level,
                    "gate": gate_id,
                    "label": label,
                    "metric": metric,
                    "op": op,
                    "threshold": threshold,
                    "held_to": held_to,
                    "value": None if value is None else round(float(value), 3),
                    "status": status,
                    "severity": severity,
                    "note": note,
                }
            )
    return results


def _commitment_note(group: Mapping[str, Any], count_key: str) -> str:
    """'4/6, 3 excluded (abuse_hangup 1, end_request 2)': the gate's counts beside its value."""
    excluded = int(group.get("commitment_excluded") or 0)
    note = f"{int(group.get(count_key) or 0)}/{int(group.get('commitment_window_calls') or 0)}, {excluded} excluded"
    reasons = group.get("commitment_excluded_reasons") or {}
    if reasons:
        note += " (" + ", ".join(f"{why} {count}" for why, count in sorted(reasons.items())) + ")"
    return note


def readiness(agg: Mapping[str, Mapping[str, Any]], gates: Sequence[Mapping[str, Any]], *, offline: bool) -> dict[str, Any]:
    """"Ready for an owner test": a live sweep, enough calls, every gate measured and met."""
    reasons: list[str] = []
    if offline:
        reasons.append("offline sweep: the learner model, the advisor and the judge are scripted")
    if agg.get("all", {}).get("calls", 0) < MIN_CALLS_FOR_READY:
        reasons.append(f"fewer than {MIN_CALLS_FOR_READY} calls")
    failed = [g for g in gates if g["severity"] == "gate" and g["status"] == "fail"]
    unmeasured = [g for g in gates if g["severity"] == "gate" and g["status"] == "n/a"]
    if failed:
        reasons.append(f"{len(failed)} gate(s) failed")
    if unmeasured:
        reasons.append(f"{len(unmeasured)} gate(s) not measured")
    return {"ready": not reasons, "reasons": reasons}


def build_scorecard(
    records: Sequence[Mapping[str, Any]], *, offline: bool, header: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    agg = aggregate(records)
    gates = evaluate(agg)
    return {
        "header": dict(header or {}),
        "offline": offline,
        "aggregate": agg,
        "gates": gates,
        "readiness": readiness(agg, gates, offline=offline),
    }


# --------------------------------------------------------------------------- rendering
def _fmt(value: Any, digits: int = 2) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def render_markdown(card: Mapping[str, Any], calls: Sequence[Mapping[str, Any]] = ()) -> str:
    """The scorecard as Markdown: run line, per-level metrics, the gates, the failing calls."""
    agg = card["aggregate"]
    levels = [level for level in agg if level != "all"] + ["all"]
    lines: list[str] = []
    header = card.get("header") or {}
    mode = "OFFLINE (scripted learner model, advisor and judge)" if card["offline"] else "LIVE"
    lines.append(f"# R1 rehearsal scorecard - {mode}")
    lines.append("")
    lines.append(
        f"calls {agg['all']['calls']}, content {str(header.get('content_sha256', ''))[:12]}, "
        f"git {str(header.get('git_sha', ''))[:10]}, harness v{header.get('harness_version', '?')}"
    )
    lines.append("")
    lines.append("## Metrics by advisor level")
    lines.append("")
    lines.append("| metric | " + " | ".join(levels) + " |")
    lines.append("|---|" + "---|" * len(levels))
    rows = (
        ("calls", "calls"),
        ("hard-fail calls", "hard_fail_calls"),
        ("exchanges (mean)", "exchanges_mean"),
        ("role-play seconds (mean)", "roleplay_seconds_mean"),
        ("families 3+ at 13:00", "families_3plus_rate"),
        ("objections in context (judge)", "objections_in_context_rate"),
        ("misfires / call (gate: one call adds at most 5)", "misfires_per_call"),
        ("misfires / call, uncapped", "misfires_per_call_uncapped"),
        ("judge misfires / call", "judge_misfires_per_call"),
        ("judge misfires rejected / call", "judge_misfires_rejected_per_call"),
        ("rule misfires / call", "rule_misfires_per_call"),
        ("need disclosed after a genuine probe", "disclosure_rate"),
        ("need disclosed, engine-confirmed digs", "disclosure_rate_engine_confirmed"),
        ("harness-only digs (engine saw no follow-up)", "harness_only_digs_total"),
        ("engine-only digs (harness counted none)", "engine_only_digs_total"),
        ("digs the gate did not release at that exchange", "probe_unreleased_total"),
        ("calls with an unprompted dump", "unprompted_dump_call_rate"),
        ("MEDIUM or better (calls with a commitment window)", "medium_or_better_rate"),
        ("calls with no commitment window (excluded)", "commitment_excluded"),
        ("MEDIUM or better, all calls", "medium_or_better_rate_all"),
        ("STRONG", "strong_rate"),
        ("near repeats / call", "near_repeat_per_call"),
        ("exact repeats / call", "exact_repeat_per_call"),
        ("WEAK line, max per call", "weak_line_max"),
        ("commitment guard hits after commitment", "commitment_hits_after_commitment"),
        ("blocked commitment attempts / call", "commitment_blocked_per_call"),
        ("commitments still in the spoken line", "commitment_spoken_leaks"),
        ("guard leak hits / call (mean)", "guard_leak_hits_per_call"),
        ("guard hygiene hits / call (mean)", "guard_hygiene_hits_per_call"),
        ("guard hits / call (mean)", "guard_hits_per_call"),
        ("guard hits / call (worst)", "guard_hits_max_per_call"),
        ("invented-fact hits / call", "invented_fact_hits_per_call"),
        ("reply words, mean", "reply_words_mean"),
        ("reply words, p90 (mean)", "reply_words_p90"),
        ("short replies share", "short_reply_share"),
        ("question rate", "question_rate"),
        ("reaction-opener rate", "reaction_rate"),
        ("top opener (first word) share", "opener_top_share"),
        ("replies with hmm", "hmm_share"),
        ("replies with honestly", "honestly_share"),
        ('replies with "a stretch" / call', "stretch_per_call"),
        ('"what would it involve" replies / call', "template_q_per_call"),
        ("decider-stall replies / call", "decider_stall_per_call"),
        ("decider stall, most in 4 replies (worst)", "decider_stall_window_max"),
        ('"still more than I planned" replies / call', "money_strain_per_call"),
        ("money line, most in 3 replies (worst)", "money_strain_window_max"),
        ("style mean (judge)", "style_mean"),
        ("intents needing the scripted variant", "intent_fallback_rate"),
        ("fidelity pass rate", "fidelity_pass_rate"),
    )
    for label, key in rows:
        cells = [_fmt(agg[level].get(key)) for level in levels]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("max slip seconds by family (worst call):")
    lines.append("")
    lines.append("| family | " + " | ".join(levels) + " |")
    lines.append("|---|" + "---|" * len(levels))
    for family in ("F1", "F2", "F3", "F4"):
        cells = [_fmt((agg[level].get("max_slip_sec_by_family") or {}).get(family), 1) for level in levels]
        lines.append(f"| {family} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("commitment levels / guard hits / stop reasons / misfire kinds / top opener:")
    lines.append("")
    for level in levels:
        group = agg[level]
        lines.append(
            f"- {level}: commitment {group['commitment_levels']}, guard {group['guard_by_category']}, "
            f"stop {group['stop_reasons']}, misfires {group['misfire_kinds']}, "
            f"top opener {group['opener_top_word']}"
        )
    lines.append("")
    lines.append("## Gates")
    lines.append("")
    lines.append("| level | gate | value | threshold | status |")
    lines.append("|---|---|---|---|---|")
    for gate in card["gates"]:
        held = gate.get("held_to", gate["threshold"])
        threshold = f"{gate['op']} {gate['threshold']}"
        if held != gate["threshold"]:
            threshold += f" (small group: held to {held:.2f})"
        value = _fmt(gate["value"], 3)
        if gate.get("note"):
            value += f" ({gate['note']})"
        lines.append(
            f"| {gate['level']} | {gate['label']} | {value} | "
            f"{threshold} | {gate['status']} |"
        )
    lines.append("")
    ready = card["readiness"]
    lines.append(
        "## Ready for an owner test: "
        + ("YES" if ready["ready"] else "NO - " + "; ".join(ready["reasons"]))
    )
    guarded = [
        (c, merged_metrics(c)) for c in calls if "guard_hits_total" in (c.get("metrics") or {})
    ]
    if guarded:
        lines.append("")
        lines.append("## Guard hits per call")
        lines.append("")
        lines.append("| call | level | hits | leak | hygiene | categories |")
        lines.append("|---|---|---|---|---|---|")
        for call, metrics in guarded:
            head = call.get("header") or {}
            categories = ", ".join(
                f"{name} {count}" for name, count in sorted((metrics.get("guard_by_category") or {}).items())
            )
            lines.append(
                f"| {head.get('seed')} | {head.get('advisor_level')} | "
                f"{metrics.get('guard_hits_total', 0)} | {metrics.get('guard_leak_hits', 0)} | "
                f"{metrics.get('guard_hygiene_hits', 0)} | {categories or '-'} |"
            )
    failing = [c for c in calls if c.get("hard_fails")]
    if failing:
        lines.append("")
        lines.append("## Calls with hard fails")
        lines.append("")
        for call in failing:
            head = call.get("header") or {}
            lines.append(f"- {head.get('seed')}: {', '.join(call['hard_fails'])}")
    return "\n".join(lines) + "\n"


def diff_markdown(baseline: Mapping[str, Any], current: Mapping[str, Any]) -> str:
    """A before/after table of the headline metrics per level (a merge-time attachment)."""
    keys = (
        "hard_fail_rate",
        "weak_line_max",
        "exact_repeat_per_call",
        "near_repeat_per_call",
        "disclosure_rate",
        "medium_or_better_rate",
        "strong_rate",
        "misfires_per_call",
        "reply_words_mean",
        "intent_fallback_rate",
    )
    lines = ["| level | metric | before | after |", "|---|---|---|---|"]
    for level, group in current["aggregate"].items():
        before_group = baseline["aggregate"].get(level)
        if before_group is None:
            continue
        for key in keys:
            lines.append(f"| {level} | {key} | {_fmt(before_group.get(key))} | {_fmt(group.get(key))} |")
    return "\n".join(lines) + "\n"
