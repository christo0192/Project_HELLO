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

Diagnosis 4 (``REHEARSAL_FLOW_DESIGN_RULES``, default ON): the rubric carries the DESIGN RULES fixed by
policy (the judge scores their wording and timing, never that they exist), the facts say who ended the
role-play (farewell, the candidate's agreed or at-once end request, an agreed wrap-up, the time cap or a
hang-up after abuse) and which
graded families came before that, and evidence is asked only for the axes below 5.  With
``REHEARSAL_FLOW_NA_AXES`` (default ON) a call with no learner line (no role-play) has learner_flow and
objective_kept scored null: n/a, left out of the means, the minimums and the axis floor.

Diagnosis 5 (D5-JUDGE1): ``REHEARSAL_FLOW_AGENDA_RULES`` (default ON) adds two design rules: the
agenda's thirty minutes (interview) and twenty (role-play) are both right, and Christy's one confirming
ask on an end request, her wrap-up offer and her early-end note are policy.  ``REHEARSAL_FLOW_MIN_REPS``
(default ON) counts judged calls per scenario; a live scenario judged once is a readiness reason, since
one call is noise.  ``rehearsal.rejudge`` judges saved records again under the current rubric.

Live only: ``ScriptedFlowJudge`` (offline) returns ``status: "n/a"``, since a scripted model's
transcript says nothing about flow.  The gates (``FLOW_GATES``): naturalness mean >= 4.3,
adaptability mean >= 4.3, objective_kept min >= 4, and no call below 3 on any axis.
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping, Sequence

from rehearsal import flags

AXES = ("christy_flow", "learner_flow", "adaptability", "objective_kept", "repetition", "naturalness")
# The axes a call with no role-play (no learner line) cannot be scored on (D4-H-SILENT1).
NO_ROLEPLAY_AXES = ("learner_flow", "objective_kept")
FAMILY_IDS = ("F1", "F2", "F3", "F4")
FLOW_GATES = {
    "naturalness_mean": 4.3,
    "adaptability_mean": 4.3,
    "objective_kept_min": 4.0,
    "axis_floor": 3.0,
}
# D5-JUDGE1 (``REHEARSAL_FLOW_MIN_REPS``): judged calls of each scenario the gates want.
FLOW_MIN_REPS = 2
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
# D4-H-POLICY1: the rules the product is built to follow are not the judge's to mark down.
DESIGN_RULES = (
    "DESIGN RULES (fixed by policy, so judge only their wording and timing, never that they exist):\n"
    "- Christy never gives performance feedback or hiring details in the interview: she declines, and "
    "the hiring team is named once.\n"
    "- The brief must give the learner's name, city, the course, 'up to twenty minutes', the "
    "preparation guide, the cue 'Let's pause the role-play here' and the instruction to say 'ready'.\n"
    "- The role-play starts only on a spoken 'ready' or the button.\n"
    "- When the candidate asks to end the role-play and agrees when asked, or the request itself names the "
    "end, the role-play ends at once: that keeps the objective, and objections not reached because the "
    "candidate ended are no failure.\n"
    "- When Christy offers to wrap up and the candidate agrees, the role-play ends there: objections not "
    "reached are no failure.\n"
    "- After abuse from the candidate the learner hangs up: that keeps the objective, and objections not "
    "reached are no failure.\n"
    "- Christy steps out of the role-play with the cue phrase 'Let's pause the role-play here'.\n"
)
_EVIDENCE_V1 = (
    "For every axis give up to 3 evidence items: the turn number and a quote of at most 12 words "
    "copied exactly from a CHRISTY or LEARNER line (never a CANDIDATE line). "
)
_EVIDENCE_V2 = (
    "Evidence only for deductions: for each axis below 5, quote the BOT line(s) that cost the point; "
    "for a 5 give no evidence. Each item is the turn number and a quote of at most 12 words copied "
    "exactly from a CHRISTY or LEARNER line (never a CANDIDATE line), at most 3 per axis. "
)
_SCORE_HEAD = "Score each axis from 1 (poor) to 5 (excellent):\n"
assert _EVIDENCE_V1 in RUBRIC and _SCORE_HEAD in RUBRIC
RUBRIC_V2 = RUBRIC.replace(_SCORE_HEAD, DESIGN_RULES + _SCORE_HEAD).replace(_EVIDENCE_V1, _EVIDENCE_V2)
# D5-JUDGE1 (``REHEARSAL_FLOW_AGENDA_RULES``): once the rules named 'up to twenty minutes', the agenda's
# "about thirty minutes" (the whole interview) read as a contradiction in 28 of 40 calls; and the one
# confirming ask on an end request, the wrap-up offer and the early-end note are policy too.
AGENDA_RULES = (
    "- The opening agenda says the whole interview takes about thirty minutes and the role-play up to "
    "twenty: both are correct.\n"
    "- Christy asks once to confirm an end request that does not name the end, and may offer to wrap up "
    "or note an early end; these asides are policy.\n"
)
RUBRIC_V3 = RUBRIC_V2.replace(DESIGN_RULES, DESIGN_RULES + AGENDA_RULES)
assert RUBRIC_V3 != RUBRIC_V2
SCHEMA_TEXT_NA = SCHEMA_TEXT.replace('"learner_flow":3', '"learner_flow":null').replace(
    '"objective_kept":3', '"objective_kept":null'
)
NO_ROLEPLAY_NOTE = (
    "No role-play took place: score learner_flow and objective_kept as null (there is no learner line "
    "to judge); score the other four axes as usual."
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
    label = "stop reason" if flags.on(flags.FLOW_DESIGN_RULES) else "role-play ended by"
    lines = [
        f"Outcome: {record.get('outcome')}; {label}: {record.get('stop_reason')} at R "
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


def _requests(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    checks = (record.get("phase_checks") or {}).get("checks") or {}
    return list((checks.get("end_consent") or {}).get("requests") or [])


def _act_r(record: Mapping[str, Any], act: str) -> float | None:
    """The R of the candidate's last turn with this act (from its turns, else from its rows)."""
    found = None
    for item in list(record.get("candidate_turns") or []) + [
        row for row in record.get("rows") or [] if row.get("speaker") == "candidate"
    ]:
        value = item.get("r_sec")
        if item.get("act") == act and isinstance(value, (int, float)) and not isinstance(value, bool):
            found = float(value)
    return found


def ended_by(record: Mapping[str, Any]) -> str:
    """Who ended the role-play, in words the judge reads (D4-H-POLICY1)."""
    checks = (record.get("phase_checks") or {}).get("checks") or {}
    abuse = checks.get("abuse") or {}
    endings = ((record.get("session_facts") or {}).get("learner_endings") or {})
    hung_up = endings.get("abuse_hangups") if isinstance(endings, Mapping) else None
    stop = record.get("stop_reason")
    # The product's own hang-up count is the truth; an exit within two learner lines of an insult is a
    # hang-up only when nothing else ended the role-play (review FLOW-RULES-GAPS: "... you idiot, just
    # end the interview" is an end request, and the time cap is the time cap).
    near_insult = bool(abuse.get("exited_within_two_learner_lines")) and stop not in (
        "end_request", "time_cap", "wrap_accepted"
    )
    if (isinstance(hung_up, int) and hung_up > 0) or near_insult:
        at = abuse.get("r")
        return "hang-up after abuse" + (f" at R {_clock(at)}" if isinstance(at, (int, float)) else "")
    if stop == "end_request":
        agreed = _act_r(record, "end_agree")
        if agreed is not None:
            return f"candidate end request, agreed at R {_clock(agreed)}"
        at_once = next((item for item in _requests(record) if item.get("exited_at_once") and not item.get("asked")), None)
        if at_once is not None:
            why = {"names_the_end": " (the request named the end)", "asked_before": " (Christy had asked before)"}
            return (
                f"candidate end request at R {_clock(at_once.get('r'))}, ended at once"
                + why.get(str(at_once.get("exit_basis")), "")
            )
        return f"candidate end request at R {_clock(_act_r(record, 'end_request'))}"
    if stop == "wrap_accepted":
        agreed = _act_r(record, "wrap_accept")
        return "wrap-up offer, candidate agreed" + (f" at R {_clock(agreed)}" if agreed is not None else "")
    return {
        "farewell_exit": "farewell",
        "time_cap": "time cap",
        "no_roleplay": "no role-play",
    }.get(str(stop), str(stop))


def _families_line(record: Mapping[str, Any]) -> str:
    delivered = (record.get("metrics") or {}).get("families_delivered")
    if delivered is None:
        return "Graded objection families delivered before the end: unknown."
    missing = [family for family in FAMILY_IDS if family not in delivered]
    return (
        f"Graded objection families delivered before the end: {', '.join(delivered) or 'none'}; "
        f"not reached: {', '.join(missing) or 'none'}."
    )


def na_axes(record: Mapping[str, Any]) -> tuple[str, ...]:
    """The axes this call cannot be scored on: learner_flow and objective_kept with no learner line."""
    if not flags.on(flags.FLOW_NA_AXES):
        return ()
    has_learner = any(str(row.get("voice") or "") == "learner" for row in record.get("rows") or [])
    return () if has_learner else NO_ROLEPLAY_AXES


def flow_messages(record: Mapping[str, Any]) -> list[dict[str, str]]:
    turns = judged_turns(record)
    rules = flags.on(flags.FLOW_DESIGN_RULES)
    facts = facts_text(record)
    if rules:
        facts += f"\nRole-play ended by: {ended_by(record)}.\n{_families_line(record)}"
    na = na_axes(record)
    note = f"{NO_ROLEPLAY_NOTE}\n\n" if na else ""
    user = (
        f"CANDIDATE BEHAVIOUR:\n{behaviour_text(record)}\n\nCALL FACTS:\n{facts}\n\n{note}"
        f"TRANSCRIPT:\n{transcript_for_flow(turns)}\n\nSCHEMA:\n{SCHEMA_TEXT_NA if na else SCHEMA_TEXT}"
    )
    return [{"role": "system", "content": rubric_text()}, {"role": "user", "content": user}]


def rubric_text() -> str:
    """The system prompt the switches choose: the first rubric, the round-5 one or the agenda rules."""
    if not flags.on(flags.FLOW_DESIGN_RULES):
        return RUBRIC
    return RUBRIC_V3 if flags.on(flags.FLOW_AGENDA_RULES) else RUBRIC_V2


# ------------------------------------------------------------------------------ the verdict
def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_flow(raw: str, na_axes: Sequence[str] = ()) -> dict[str, Any]:
    """The judge's JSON as ``{"scores", "evidence", "worst_moments"}``; ``{"error": ...}`` when it is
    not one object with all six integer scores 1-5 (fail closed).  Only the axes in ``na_axes`` (a call
    with no role-play) may be null instead."""
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
    scores: dict[str, int | None] = {}
    if isinstance(raw_scores, dict):
        for axis in AXES:
            value = _int(raw_scores.get(axis))
            if value is not None and 1 <= value <= 5:
                scores[axis] = value
            elif axis in na_axes and axis in raw_scores and raw_scores.get(axis) is None:
                scores[axis] = None
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
        na = na_axes(record)
        nudge = RETRY_NUDGE + (f" Score {' and '.join(na)} as null." if na else "")
        verdict: dict[str, Any] = {"error": "no_json"}
        attempts = 0
        for attempt in range(2):
            attempts += 1
            completion = await self.client.complete(
                messages if attempt == 0 else [*messages, {"role": "user", "content": nudge}],
                model=self.model,
                temperature=0.0,
                max_tokens=FLOW_MAX_TOKENS,
                json_mode=True,
                role="flow_judge",
            )
            verdict = parse_flow(completion.text, na_axes=na)
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
def flow_scores(record: Mapping[str, Any]) -> dict[str, int | None] | None:
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
    # A null score (an axis n/a for that call, D4-H-SILENT1) stays out of the means, mins and floor.
    values = {axis: [s[axis] for _, s in scored if s.get(axis) is not None] for axis in AXES}
    means = {axis: (sum(values[axis]) / len(values[axis])) if values[axis] else None for axis in AXES}
    mins = {axis: min(values[axis]) if values[axis] else None for axis in AXES}
    below = [
        {"call": str((record.get("header") or {}).get("seed")), "axis": axis, "score": scores[axis]}
        for record, scores in scored
        for axis in AXES
        if scores.get(axis) is not None and scores[axis] < FLOW_GATES["axis_floor"]
    ]
    known = [value for axis in AXES for value in values[axis]]

    def gate(value: float | None, threshold: float) -> dict[str, Any]:
        return {"value": None if value is None else round(value, 2), "threshold": threshold,
                "ok": None if value is None else value >= threshold}

    gates = {
        "naturalness_mean": gate(means["naturalness"], FLOW_GATES["naturalness_mean"]),
        "adaptability_mean": gate(means["adaptability"], FLOW_GATES["adaptability_mean"]),
        "objective_kept_min": gate(mins["objective_kept"], FLOW_GATES["objective_kept_min"]),
        "axis_floor": {
            "value": min(known) if known else None,
            "threshold": FLOW_GATES["axis_floor"],
            "ok": None if not known else not below,
            "below": below,
        },
    }
    worst = []
    for record, scores in scored:
        seed = str((record.get("header") or {}).get("seed"))
        scenario = (record.get("header") or {}).get("scenario")
        for item in (record.get("flow") or {}).get("worst_moments") or []:
            worst.append({"call": seed, "scenario": scenario, **item})
    extra: dict[str, Any] = {}
    if flags.on(flags.FLOW_MIN_REPS):
        extra["reps"] = reps_summary(scored)
    return {
        **extra,
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


def reps_summary(scored: Sequence[tuple[Mapping[str, Any], Any]]) -> dict[str, Any]:
    """D5-JUDGE1: judged calls per scenario.  One call moves an axis mean by a whole point's share and
    a byte-identical call swung by a point between two runs, so a gate wants ``FLOW_MIN_REPS``
    judged calls of each scenario."""
    counts: dict[str, int] = {}
    for record, _scores in scored:
        name = str((record.get("header") or {}).get("scenario"))
        counts[name] = counts.get(name, 0) + 1
    return {
        "min_per_scenario": min(counts.values()) if counts else None,
        "per_scenario": dict(sorted(counts.items())),
        "single_call_scenarios": sorted(name for name, count in counts.items() if count < FLOW_MIN_REPS),
        "wanted": FLOW_MIN_REPS,
    }


def single_call_reason(summary: Mapping[str, Any]) -> str | None:
    """The readiness reason for a live run whose flow gates rest on one judged call of a scenario."""
    thin = (summary.get("reps") or {}).get("single_call_scenarios") or []
    if not thin:
        return None
    return (
        f"flow gates rest on one judged call for {len(thin)} scenario(s) ({', '.join(thin)}): "
        f"run at least {FLOW_MIN_REPS} per scenario"
    )


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
        lines.append(f"| {item['call']} | {item['scenario']} | " + " | ".join(_cell(item["scores"].get(a)) for a in AXES) + " |")
    lines.append("| **mean** | | " + " | ".join(_cell(summary["means"][a], "{:.2f}") for a in AXES) + " |")
    lines.append("| **min** | | " + " | ".join(_cell(summary["mins"][a]) for a in AXES) + " |")
    lines += ["", "| gate | value | threshold | ok |", "|---|---|---|---|"]
    for name, item in summary["gates"].items():
        mark = {True: "PASS", False: "FAIL", None: "n/a"}[item["ok"]]
        lines.append(f"| {name} | {item['value']} | {item['threshold']} | {mark} |")
    thin = (summary.get("reps") or {}).get("single_call_scenarios") or []
    if thin:
        lines += ["", f"The gates rest on one judged call for: {', '.join(thin)} "
                      f"(one call is noise; run at least {FLOW_MIN_REPS} per scenario)."]
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


def _cell(value: Any, form: str = "{}") -> str:
    return "n/a" if value is None else form.format(value)


def _clock(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        return "-"
    value = max(0, int(seconds))
    return f"{value // 60:02d}:{value % 60:02d}"


__all__ = [
    "AXES",
    "FLOW_GATES",
    "FLOW_MIN_REPS",
    "FlowJudge",
    "ScriptedFlowJudge",
    "flow_messages",
    "ended_by",
    "flow_summary",
    "judged_turns",
    "na_axes",
    "parse_flow",
    "render_flow_markdown",
    "reps_summary",
    "rubric_text",
    "single_call_reason",
    "validate_flow",
]
