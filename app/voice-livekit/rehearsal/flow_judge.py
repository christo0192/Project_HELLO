"""The conversation-flow judge of the full-interview tier (D-M032-10): one LLM call per transcript.

The per-phase checks (``rehearsal.full_metrics``) say whether a rule held; this judge says how the
whole interview sounded.  It reads the full transcript (Christy's phases and the role-play), what the
simulated candidate was set up to do (the scenario and its ground truth) and the call's facts (the
graded objections delivered, how the role-play started and ended, the end requests), and scores the
BOT on six axes, each 1 (poor) to 5 (excellent):

* ``christy_flow``: Christy's phases flow (smooth hand-offs, she answers what was asked, no loops);
* ``learner_flow``: the learner reacts to what the advisor just said and builds on it;
* ``adaptability``: the bot follows and responds to what THIS candidate actually does;
* ``objective_kept``: the objective holds (graded objections delivered, the consent rules kept);
* ``repetition``: 5 is no repeated sentences, openers or stock reactions;
* ``naturalness``: spoken English, no stock phrases, no praise of the candidate.

Each score comes with short evidence quotes copied from BOT lines only (Christy's or the learner's),
with their turn numbers; a quote that is not in a bot line is rejected (``evidence_rejected``), never
counted.  ``worst_moments`` lists the worst bot turns (turn, speaker, why).  Parsing is strict and
fail closed: a reply without all six scores is an error, never a guess.

Live only: ``ScriptedFlowJudge`` (offline) returns ``status: "n/a"``, since a scripted model's
transcript says nothing about flow.  The gates (``FLOW_GATES``): naturalness mean >= 4.3,
adaptability mean >= 4.3, objective_kept min >= 4, and no call below 3 on any axis.
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping, Sequence

AXES = ("christy_flow", "learner_flow", "adaptability", "objective_kept", "repetition", "naturalness")
FLOW_GATES = {
    "naturalness_mean": 4.3,
    "adaptability_mean": 4.3,
    "objective_kept_min": 4.0,
    "axis_floor": 3.0,
}
FLOW_MAX_TOKENS = 2600
MAX_TRANSCRIPT_CHARS = 60000
MAX_QUOTE_WORDS = 16
MAX_EVIDENCE = 3
MAX_WORST = 6
RETRYABLE = frozenset({"no_json", "bad_json", "bad_scores"})
SPEAKERS = {"christy": "CHRISTY", "learner": "LEARNER", "candidate": "CANDIDATE"}
BOT_SPEAKERS = frozenset({"CHRISTY", "LEARNER"})

RUBRIC = (
    "You review a recorded first-round job interview run by an AI. Two BOT voices speak: CHRISTY, "
    "the interviewer (opening, icebreaker questions, the role-play brief, the wrap-up and the "
    "close), and LEARNER, an AI prospective student in a sales role-play where the CANDIDATE plays "
    "the Program Advisor. The CANDIDATE is a simulated person set up to behave in a particular way "
    "(see CANDIDATE BEHAVIOUR). Judge ONLY the BOT lines. Turn numbers are in brackets.\n"
    "Score each axis from 1 (poor) to 5 (excellent):\n"
    "- christy_flow: Christy's phases flow like a good human interviewer: smooth hand-offs, she "
    "answers what was actually asked, no loops, no dead ends, no abrupt cuts, no robotic tails.\n"
    "- learner_flow: in the role-play the learner reacts to what the advisor just said, builds on "
    "the conversation, raises its worries at natural moments, never ignores a direct answer.\n"
    "- adaptability: the bot (both voices) notices what THIS candidate does and responds to it "
    "well: it redirects tangents, clears up confusion, keeps up with interruptions, draws out "
    "one-word answers, stays calm with rudeness, holds firm on absurd offers or pressure, handles "
    "a dropped line, listens to a dispute; instead of ignoring it and running its script.\n"
    "- objective_kept: the bot still reaches its objective: the learner delivers its graded "
    "objections (price, time, value, stalling) in context, the role-play starts only on a spoken "
    "'ready' or the button, there is no exit before R 14:00 without the candidate agreeing, every "
    "end request is heard and asked about, and the interview reaches its wrap-up and close. Use "
    "CALL FACTS.\n"
    "- repetition: 5 means no repeated sentences, openers or stock reactions; 1 means loops or the "
    "same line many times.\n"
    "- naturalness: spoken English as a person talks: short, varied, no stock phrases ('Great "
    "question', 'Absolutely', 'I appreciate that'), no praise of the candidate, no written style.\n"
    "For every axis give up to 3 evidence items: the turn number and a quote of at most 12 words "
    "copied exactly from a CHRISTY or LEARNER line (never a CANDIDATE line). Then list the worst "
    "moments (at most 5): the turn of a BOT line, its speaker and why it is bad (under 15 words). "
    "Reply with ONE JSON object and nothing else, exactly in the schema given."
)
SCHEMA_TEXT = (
    '{"scores":{"christy_flow":3,"learner_flow":3,"adaptability":3,"objective_kept":3,'
    '"repetition":3,"naturalness":3},"evidence":{"christy_flow":[{"turn":0,"quote":""}],'
    '"learner_flow":[],"adaptability":[],"objective_kept":[],"repetition":[],"naturalness":[]},'
    '"worst_moments":[{"turn":0,"speaker":"CHRISTY|LEARNER","why":""}]}'
)
RETRY_NUDGE = (
    "Your last reply could not be read as one complete JSON object with all six scores. Reply again "
    "with ONE complete JSON object in the schema: every score an integer 1-5, quotes under 12 words, "
    "at most 2 evidence items per axis."
)


# ------------------------------------------------------------------------------ the input
def _norm(text: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9$']+", str(text or "").lower()))


def judged_turns(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The transcript as numbered turns (1-based, in time order): phase, speaker, text, S and R."""
    rows = list(record.get("rows") or [])

    def key(item: tuple[int, Mapping[str, Any]]) -> tuple[float, int]:
        value = item[1].get("t_start")
        number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else float("inf")
        return number, item[0]

    out = []
    for order, (_index, row) in enumerate(sorted(enumerate(rows), key=key), start=1):
        voice = str(row.get("voice") or ("candidate" if row.get("speaker") == "candidate" else "christy"))
        out.append(
            {
                "turn": order,
                "phase": row.get("phase"),
                "speaker": SPEAKERS.get(voice, voice.upper()),
                "text": str(row.get("text") or ""),
                "s_sec": row.get("s_sec"),
                "r_sec": row.get("r_sec"),
                "act": row.get("act") if row.get("speaker") == "candidate" else None,
                "interrupted": bool(row.get("interrupted")),
            }
        )
    return out


def transcript_for_flow(turns: Sequence[Mapping[str, Any]]) -> str:
    lines = []
    for turn in turns:
        cut = " (cut off)" if turn.get("interrupted") else ""
        lines.append(f"[{turn['turn']}] {str(turn.get('phase') or '').upper()} {turn['speaker']}{cut}: {turn['text']}")
    text = "\n".join(lines)
    return text if len(text) <= MAX_TRANSCRIPT_CHARS else text[:MAX_TRANSCRIPT_CHARS] + "\n..."


def behaviour_text(record: Mapping[str, Any]) -> str:
    """What the simulated candidate was set up to do (the scenario and its ground truth)."""
    header = record.get("header") or {}
    truth = header.get("ground_truth") or {}
    parts = [f"Scenario '{header.get('scenario')}': {header.get('scenario_title')}"]
    if truth.get("adapt"):
        parts.append(f"Behaviour: {truth['adapt']} (tags: {', '.join(header.get('scenario_tags') or [])}).")
    acts: dict[str, int] = {}
    for turn in record.get("candidate_turns") or []:
        act = str(turn.get("act"))
        acts[act] = acts.get(act, 0) + 1
    if acts:
        parts.append("Candidate turns by purpose: " + ", ".join(f"{k} x{v}" for k, v in sorted(acts.items())))
    return "\n".join(parts)


def facts_text(record: Mapping[str, Any]) -> str:
    """The call's facts the objective axis leans on, worked out from the record (never guessed)."""
    metrics = record.get("metrics") or {}
    checks = (record.get("phase_checks") or {}).get("checks") or {}
    consent = checks.get("end_consent") or {}
    requests = consent.get("requests") or []
    delivered = metrics.get("families_delivered")
    lines = [
        f"Outcome: {record.get('outcome')}; role-play ended by: {record.get('stop_reason')} at R "
        f"{_clock(record.get('roleplay_seconds'))}; started by: {(record.get('phase_checks') or {}).get('start_by')}.",
        f"Graded objection families the learner delivered: {delivered if delivered is not None else 'unknown'}.",
        f"End requests: {len(requests)}"
        + (
            " (" + "; ".join(
                f"R {_clock(item.get('r'))}: asked={item.get('asked')}, exited_at_once={item.get('exited_at_once')}"
                for item in requests
            ) + ")"
            if requests
            else ""
        ),
        "Per-phase checks failed: " + (", ".join((record.get("phase_checks") or {}).get("failed") or []) or "none"),
    ]
    return "\n".join(lines)


def flow_messages(record: Mapping[str, Any]) -> list[dict[str, str]]:
    turns = judged_turns(record)
    user = (
        f"CANDIDATE BEHAVIOUR:\n{behaviour_text(record)}\n\nCALL FACTS:\n{facts_text(record)}\n\n"
        f"TRANSCRIPT:\n{transcript_for_flow(turns)}\n\nSCHEMA:\n{SCHEMA_TEXT}"
    )
    return [{"role": "system", "content": RUBRIC}, {"role": "user", "content": user}]


# ------------------------------------------------------------------------------ the verdict
def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_flow(raw: str) -> dict[str, Any]:
    """The judge's JSON as ``{"scores", "evidence", "worst_moments"}``; ``{"error": ...}`` when it is
    not one object with all six integer scores 1-5 (fail closed)."""
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {"error": "no_json"}
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return {"error": "bad_json"}
    if not isinstance(data, dict):
        return {"error": "not_object"}
    raw_scores = data.get("scores")
    scores: dict[str, int] = {}
    if isinstance(raw_scores, dict):
        for axis in AXES:
            value = _int(raw_scores.get(axis))
            if value is not None and 1 <= value <= 5:
                scores[axis] = value
    if len(scores) != len(AXES):
        return {"error": "bad_scores"}
    evidence: dict[str, list[dict[str, Any]]] = {axis: [] for axis in AXES}
    raw_evidence = data.get("evidence") if isinstance(data.get("evidence"), dict) else {}
    for axis in AXES:
        for item in (raw_evidence.get(axis) or [])[: MAX_EVIDENCE + 2]:
            if isinstance(item, dict):
                evidence[axis].append(
                    {"turn": _int(item.get("turn")), "quote": " ".join(str(item.get("quote") or "").split()[:MAX_QUOTE_WORDS])}
                )
    worst = []
    for item in data.get("worst_moments") or []:
        if isinstance(item, dict):
            worst.append(
                {
                    "turn": _int(item.get("turn")),
                    "speaker": str(item.get("speaker") or "").upper()[:10],
                    "why": str(item.get("why") or "")[:160],
                }
            )
    return {"scores": scores, "evidence": evidence, "worst_moments": worst}


def validate_flow(verdict: Mapping[str, Any], record: Mapping[str, Any]) -> dict[str, Any]:
    """Evidence and worst moments held to the transcript: a quote must be in a BOT line (of its turn,
    or the turn is corrected to the bot line that has it); a quote from a candidate line, or from no
    line, is rejected.  A worst moment must name a bot turn (its speaker is taken from the transcript).
    """
    if verdict.get("error"):
        return dict(verdict)
    turns = judged_turns(record)
    by_turn = {turn["turn"]: turn for turn in turns}
    bots = [turn for turn in turns if turn["speaker"] in BOT_SPEAKERS]
    kept: dict[str, list[dict[str, Any]]] = {axis: [] for axis in AXES}
    rejected: list[dict[str, Any]] = []
    for axis in AXES:
        for item in (verdict.get("evidence") or {}).get(axis) or []:
            quote = _norm(item.get("quote"))
            turn = by_turn.get(item.get("turn"))
            reason = ""
            if not quote:
                reason = "empty_quote"
            elif turn is not None and turn["speaker"] in BOT_SPEAKERS and quote in _norm(turn["text"]):
                pass
            elif turn is not None and turn["speaker"] == "CANDIDATE" and quote in _norm(turn["text"]):
                reason = "candidate_line"
            else:
                found = next((bot for bot in bots if quote in _norm(bot["text"])), None)
                if found is None:
                    reason = "not_in_a_bot_line"
                else:
                    item = {**item, "turn": found["turn"], "turn_corrected": True}
            if reason:
                rejected.append({"axis": axis, **item, "rejected": reason})
            elif len(kept[axis]) < MAX_EVIDENCE:
                turn = by_turn[item["turn"]]
                kept[axis].append({**item, "speaker": turn["speaker"]})
    worst = []
    for item in verdict.get("worst_moments") or []:
        turn = by_turn.get(item.get("turn"))
        if turn is None or turn["speaker"] not in BOT_SPEAKERS:
            rejected.append({"axis": "worst_moments", **item, "rejected": "not_a_bot_turn"})
            continue
        if len(worst) < MAX_WORST:
            worst.append(
                {
                    "turn": turn["turn"],
                    "speaker": turn["speaker"],
                    "phase": turn["phase"],
                    "s_sec": turn["s_sec"],
                    "r_sec": turn["r_sec"],
                    "why": item.get("why"),
                    "line": turn["text"][:120],
                }
            )
    return {**verdict, "evidence": kept, "evidence_rejected": rejected, "worst_moments": worst}


# ------------------------------------------------------------------------------ the judges
class FlowJudge:
    """The live judge: one JSON-mode call per whole transcript, asked once more on an unreadable one."""

    def __init__(self, client: Any, model: str) -> None:
        self.client, self.model = client, model

    async def judge(self, record: Mapping[str, Any]) -> dict[str, Any]:
        messages = flow_messages(record)
        verdict: dict[str, Any] = {"error": "no_json"}
        attempts = 0
        for attempt in range(2):
            attempts += 1
            completion = await self.client.complete(
                messages if attempt == 0 else [*messages, {"role": "user", "content": RETRY_NUDGE}],
                model=self.model,
                temperature=0.0,
                max_tokens=FLOW_MAX_TOKENS,
                json_mode=True,
                role="flow_judge",
            )
            verdict = parse_flow(completion.text)
            if verdict.get("error") not in RETRYABLE:
                break
        verdict = validate_flow(verdict, record)
        if verdict.get("error"):
            return {"source": "llm", "model": self.model, "status": "error", "attempts": attempts, "error": verdict["error"]}
        return {"source": "llm", "model": self.model, "status": "ok", "attempts": attempts, **verdict}


class ScriptedFlowJudge:
    """Offline: no verdict.  A scripted Christy and learner say nothing about conversational flow."""

    async def judge(self, record: Mapping[str, Any]) -> dict[str, Any]:
        return {"source": "offline", "status": "n/a"}


# ------------------------------------------------------------------------------ the scorecard
def flow_scores(record: Mapping[str, Any]) -> dict[str, int] | None:
    flow = record.get("flow") or {}
    return dict(flow["scores"]) if flow.get("status") == "ok" and flow.get("scores") else None


def flow_summary(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Per-axis means and minimums over the judged calls, the gates and the worst moments.

    A gate is ``ok: None`` when no call was judged (offline, or the judge was off); ``judged`` and
    ``unjudged`` count the calls with and without a verdict.
    """
    judged = [(record, flow_scores(record)) for record in records]
    scored = [(record, scores) for record, scores in judged if scores]
    unjudged = [
        str((record.get("header") or {}).get("seed"))
        for record, scores in judged
        if not scores and record.get("flow") and (record.get("flow") or {}).get("status") != "n/a"
    ]
    judge_off = sum(1 for record in records if not record.get("flow"))
    means = {axis: (sum(s[axis] for _, s in scored) / len(scored)) if scored else None for axis in AXES}
    mins = {axis: (min(s[axis] for _, s in scored)) if scored else None for axis in AXES}
    below = [
        {"call": str((record.get("header") or {}).get("seed")), "axis": axis, "score": scores[axis]}
        for record, scores in scored
        for axis in AXES
        if scores[axis] < FLOW_GATES["axis_floor"]
    ]

    def gate(value: float | None, threshold: float) -> dict[str, Any]:
        return {"value": None if value is None else round(value, 2), "threshold": threshold,
                "ok": None if value is None else value >= threshold}

    gates = {
        "naturalness_mean": gate(means["naturalness"], FLOW_GATES["naturalness_mean"]),
        "adaptability_mean": gate(means["adaptability"], FLOW_GATES["adaptability_mean"]),
        "objective_kept_min": gate(mins["objective_kept"], FLOW_GATES["objective_kept_min"]),
        "axis_floor": {
            "value": None if not scored else min(min(s.values()) for _, s in scored),
            "threshold": FLOW_GATES["axis_floor"],
            "ok": None if not scored else not below,
            "below": below,
        },
    }
    worst = []
    for record, scores in scored:
        seed = str((record.get("header") or {}).get("seed"))
        scenario = (record.get("header") or {}).get("scenario")
        for item in (record.get("flow") or {}).get("worst_moments") or []:
            worst.append({"call": seed, "scenario": scenario, **item})
    return {
        "judged": len(scored),
        "unjudged": unjudged,
        "judge_off": judge_off,
        "offline": bool(records) and all((r.get("flow") or {}).get("status") == "n/a" for r in records),
        "means": {axis: None if v is None else round(v, 2) for axis, v in means.items()},
        "mins": mins,
        "per_call": [
            {"call": str((record.get("header") or {}).get("seed")),
             "scenario": (record.get("header") or {}).get("scenario"), "scores": scores}
            for record, scores in scored
        ],
        "gates": gates,
        "gates_failed": [name for name, item in gates.items() if item["ok"] is False],
        "worst_moments": worst,
    }


def render_flow_markdown(summary: Mapping[str, Any]) -> list[str]:
    lines = ["", "## Conversation flow (LLM judge, BOT lines only)", ""]
    if not summary.get("judged"):
        if summary.get("offline"):
            reason = "offline: n/a (a scripted model says nothing about flow)"
        elif summary.get("judge_off") and not summary.get("unjudged"):
            reason = "the flow judge was off (--no-judge)"
        else:
            reason = "no call was judged"
        lines.append(f"Not scored: {reason}.")
        if summary.get("unjudged"):
            lines.append(f"Unjudged calls: {', '.join(summary['unjudged'])}")
        return lines
    head = "| call | scenario | " + " | ".join(AXES) + " |"
    lines += [head, "|" + "---|" * (len(AXES) + 2)]
    for item in summary["per_call"]:
        lines.append(f"| {item['call']} | {item['scenario']} | " + " | ".join(str(item["scores"][a]) for a in AXES) + " |")
    lines.append("| **mean** | | " + " | ".join(f"{summary['means'][a]:.2f}" for a in AXES) + " |")
    lines.append("| **min** | | " + " | ".join(str(summary["mins"][a]) for a in AXES) + " |")
    lines += ["", "| gate | value | threshold | ok |", "|---|---|---|---|"]
    for name, item in summary["gates"].items():
        mark = {True: "PASS", False: "FAIL", None: "n/a"}[item["ok"]]
        lines.append(f"| {name} | {item['value']} | {item['threshold']} | {mark} |")
    if summary.get("unjudged"):
        lines += ["", f"Unjudged calls (judge error): {', '.join(summary['unjudged'])}"]
    if summary.get("worst_moments"):
        lines += ["", "### Worst moments", ""]
        for item in summary["worst_moments"][:20]:
            lines.append(
                f"- {item['call']} turn {item['turn']} ({item['speaker']}, {item.get('phase')}, "
                f"S {_clock(item.get('s_sec'))}): {item.get('why')} -- \"{item.get('line')}\""
            )
    return lines


def _clock(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        return "-"
    value = max(0, int(seconds))
    return f"{value // 60:02d}:{value % 60:02d}"


__all__ = [
    "AXES",
    "FLOW_GATES",
    "FlowJudge",
    "ScriptedFlowJudge",
    "flow_messages",
    "flow_summary",
    "judged_turns",
    "parse_flow",
    "render_flow_markdown",
    "validate_flow",
]
