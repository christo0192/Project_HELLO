"""The rubric judge: the part of the learner's quality a regex cannot see.

One call per transcript (batched), a stronger model than the one under test (it limits
self-preference), temperature 0.  The judge is allowed to see what the learner may not (the
persona's hidden needs, the deck facts) and must return ONE JSON object::

    {"objections":  [{"family": "F1|F2|F3|F4", "turn": N, "in_context": bool,
                      "canned_verbatim": bool, "why": "..."}],
     "disclosures": [{"need": "H1|H2|H3", "probe_turn": N, "reveal_turn": N|null,
                      "emotional": bool}],
     "misfires":    [{"turn": N, "kind": "unwarranted_gratitude|no_one_leaving|ignored_offer|
                                           repeat|off_card_fact|other"}],
     "stall_loop": bool,
     "style": {"reactions": 1-5, "followups": 1-5, "hesitation": 1-5, "continuity": 1-5,
               "variety": 1-5},
     "ignored_advisor_offers": [{"turn": N, "offer": "..."}]}

``ignored_advisor_offers`` is the owner test's turn 63 to 66 failure (a concrete callback offer
that got no reaction).  ``parse_verdict`` is strict and fail-closed: anything malformed is an
error, never a guess.  ``judge_metrics`` turns a verdict into the numbers the scorecard uses.

``ScriptedRubricJudge`` is the offline stand-in: a deterministic heuristic over the same record,
so the plumbing (prompt, parsing, metrics, scorecard) is exercised without a network.  Its numbers
say nothing about model quality and the scorecard marks them as offline.

Validation before a verdict gates anything (research 4.7): the judge must flag the owner session's
turns 52 and 57 as out of context and 35/41 as duplicates and score it <= 2.5, and must score a
good transcript >= 4; run each rubric twice with shuffled order and trust it only above 85 %
agreement.  That needs a funded key and is the first live job once the account is topped up.
"""
from __future__ import annotations

import json
from typing import Any, Mapping, Sequence

from rehearsal.advisor import deck_brief
from rehearsal.metrics import mean
from r1_personas import H_TOPICS, resolve_persona

JUDGE_MODEL_DEFAULT = "deepseek-v4-pro"
FAMILIES = ("F1", "F2", "F3", "F4")
MISFIRE_KINDS = (
    "unwarranted_gratitude",
    "no_one_leaving",
    "ignored_offer",
    "repeat",
    "off_card_fact",
    "other",
)
STYLE_KEYS = ("reactions", "followups", "hesitation", "continuity", "variety")
MAX_TRANSCRIPT_CHARS = 14000

RUBRIC = (
    "You are a strict reviewer of a sales role-play. ADVISOR is a job candidate playing a "
    "Program Advisor; LEARNER is a simulated prospective learner (an AI character). Judge ONLY "
    "the LEARNER's lines. Turn numbers are in brackets.\n"
    "1. objections: every time the LEARNER raises a worry about price, time or schedule, the value "
    "of the course versus free material or job outcomes, or needing to think or ask someone "
    "(families F1 price, F2 time, F3 value, F4 stalling). in_context is true when the objection "
    "follows naturally from what the ADVISOR just said (an answer to it would make sense); false "
    "when it comes out of nowhere or ignores a direct answer the advisor just gave. canned_verbatim "
    "is true when it sounds like a fixed script line rather than the learner's own words.\n"
    "2. disclosures: for each hidden need (H1 why now, H2 what held them back, H3 schedule, money "
    "or who decides) that the ADVISOR genuinely asked about, give the ADVISOR's probe turn and the "
    "LEARNER's turn where the real need came out (null if never), and whether it was said with "
    "feeling (emotional). A need the learner volunteers with no question about it is a reveal "
    "with probe_turn null.\n"
    "3. misfires: LEARNER lines that the conversation did not warrant. unwarranted_gratitude: "
    "thanking or being pleasantly surprised about a discount nobody offered. no_one_leaving: "
    "'before you go' when the advisor was not ending the call. ignored_offer: the advisor made a "
    "concrete offer (a call time, an e-mail, a price) and the learner did not react to it. repeat: "
    "the learner repeats something it already said. off_card_fact: the learner states a course "
    "fact it could not know.\n"
    "4. stall_loop: true when the learner answers different questions with the same 'let me think "
    "about it, e-mail me' reply.\n"
    "5. style, each 1 (poor) to 5 (excellent): reactions (reacts to what was just said before "
    "answering), followups (asks natural questions), hesitation (believable hesitation and "
    "interest, not robotic), continuity (remembers what was said), variety (does not repeat "
    "phrases or openers).\n"
    "6. ignored_advisor_offers: concrete offers by the ADVISOR that the LEARNER never reacted to.\n"
    "The scripted commitment lines (let me think about it / send me the enrolment link / let's "
    "book a call) are produced by the system and must not be judged as style. Reply with ONE JSON "
    "object and nothing else, exactly in the schema given."
)
SCHEMA_TEXT = (
    '{"objections":[{"family":"F1|F2|F3|F4","turn":0,"in_context":true,"canned_verbatim":false,'
    '"why":""}],"disclosures":[{"need":"H1|H2|H3","probe_turn":null,"reveal_turn":null,'
    '"emotional":false}],"misfires":[{"turn":0,"kind":"other"}],"stall_loop":false,'
    '"style":{"reactions":3,"followups":3,"hesitation":3,"continuity":3,"variety":3},'
    '"ignored_advisor_offers":[{"turn":0,"offer":""}]}'
)


def transcript_for_judge(record: Mapping[str, Any]) -> str:
    """The role-play as numbered lines (turn = exchange number), advisor first in each pair."""
    lines: list[str] = []
    for exchange in record.get("exchanges") or []:
        number = exchange.get("n")
        lines.append(f"[{number}] ADVISOR: {exchange['advisor']['text']}")
        spoken = (exchange.get("learner") or {}).get("spoken")
        lines.append(f"[{number}] LEARNER: {spoken if spoken is not None else '(no reply)'}")
    text = "\n".join(lines)
    return text if len(text) <= MAX_TRANSCRIPT_CHARS else text[:MAX_TRANSCRIPT_CHARS] + "\n..."


def persona_brief(record: Mapping[str, Any]) -> str:
    """What the judge may know about the learner: the surface answers and the hidden needs."""
    header = record.get("header") or {}
    persona = resolve_persona(
        str(header.get("persona_id")),
        variant=str(header.get("persona_variant") or "default"),
        seed=str(header.get("seed") or ""),
        avoid_first_name=str(header.get("candidate_name") or ""),
    )
    parts = [f"Learner: {persona.lead_name}. {persona.profile}"]
    for topic in H_TOPICS:
        parts.append(f"{topic} surface answer: {persona.surface(topic)} | hidden need: {persona.deep(topic)}")
    return "\n".join(parts)


def judge_messages(record: Mapping[str, Any]) -> list[dict[str, str]]:
    user = (
        f"LEARNER CARD (the learner does not tell the advisor the hidden needs unless probed):\n"
        f"{persona_brief(record)}\n\nCOURSE FACTS:\n{deck_brief()}\n\n"
        f"TRANSCRIPT:\n{transcript_for_judge(record)}\n\nSCHEMA:\n{SCHEMA_TEXT}"
    )
    return [{"role": "system", "content": RUBRIC}, {"role": "user", "content": user}]


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_verdict(raw: str) -> dict[str, Any]:
    """Validate the judge's JSON; ``{"error": ...}`` on anything malformed (fail closed)."""
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
    out: dict[str, Any] = {"objections": [], "disclosures": [], "misfires": [], "ignored_advisor_offers": []}
    for item in data.get("objections") or []:
        if isinstance(item, dict) and item.get("family") in FAMILIES:
            out["objections"].append(
                {
                    "family": item["family"],
                    "turn": _int(item.get("turn")),
                    "in_context": bool(item.get("in_context")),
                    "canned_verbatim": bool(item.get("canned_verbatim")),
                    "why": str(item.get("why") or "")[:200],
                }
            )
    for item in data.get("disclosures") or []:
        if isinstance(item, dict) and item.get("need") in H_TOPICS:
            out["disclosures"].append(
                {
                    "need": item["need"],
                    "probe_turn": _int(item.get("probe_turn")),
                    "reveal_turn": _int(item.get("reveal_turn")),
                    "emotional": bool(item.get("emotional")),
                }
            )
    for item in data.get("misfires") or []:
        if isinstance(item, dict):
            kind = item.get("kind") if item.get("kind") in MISFIRE_KINDS else "other"
            out["misfires"].append({"turn": _int(item.get("turn")), "kind": kind})
    for item in data.get("ignored_advisor_offers") or []:
        if isinstance(item, dict):
            out["ignored_advisor_offers"].append(
                {"turn": _int(item.get("turn")), "offer": str(item.get("offer") or "")[:160]}
            )
    out["stall_loop"] = bool(data.get("stall_loop"))
    style = data.get("style")
    scores: dict[str, int] = {}
    if isinstance(style, dict):
        for key in STYLE_KEYS:
            value = _int(style.get(key))
            if value is not None and 1 <= value <= 5:
                scores[key] = value
    if len(scores) != len(STYLE_KEYS):
        return {"error": "bad_style"}
    out["style"] = scores
    return out


def judge_metrics(verdict: Mapping[str, Any]) -> dict[str, Any]:
    """Numbers from a verdict (empty when the verdict is an error)."""
    if verdict.get("error"):
        return {}
    objections = verdict.get("objections") or []
    in_context = sum(1 for item in objections if item["in_context"])
    disclosures = verdict.get("disclosures") or []
    probed = [item for item in disclosures if item["probe_turn"] is not None]
    revealed = [
        item
        for item in probed
        if item["reveal_turn"] is not None and item["reveal_turn"] >= item["probe_turn"]
    ]
    style = verdict.get("style") or {}
    return {
        "judge_objections": len(objections),
        "judge_objections_in_context": in_context,
        "judge_objections_in_context_rate": (in_context / len(objections)) if objections else None,
        "judge_canned_verbatim": sum(1 for item in objections if item["canned_verbatim"]),
        "judge_disclosures_probed": len(probed),
        "judge_disclosures_revealed": len(revealed),
        "judge_emotional_reveals": sum(1 for item in revealed if item["emotional"]),
        "judge_unprompted_reveals": sum(
            1 for item in disclosures if item["probe_turn"] is None and item["reveal_turn"] is not None
        ),
        "judge_misfire_count": len(verdict.get("misfires") or []),
        "judge_ignored_offers": len(verdict.get("ignored_advisor_offers") or []),
        "judge_stall_loop": bool(verdict.get("stall_loop")),
        "judge_style_mean": mean([float(v) for v in style.values()]) if style else None,
    }


class RubricJudge:
    """The live judge: one JSON-mode call per transcript."""

    def __init__(self, client: Any, model: str = JUDGE_MODEL_DEFAULT) -> None:
        self.client, self.model = client, model

    async def judge(self, record: Mapping[str, Any]) -> dict[str, Any]:
        completion = await self.client.complete(
            judge_messages(record),
            model=self.model,
            temperature=0.0,
            max_tokens=1200,
            json_mode=True,
            role="rubric_judge",
        )
        verdict = parse_verdict(completion.text)
        return {
            "source": "llm",
            "model": self.model,
            "verdict": verdict,
            "metrics": judge_metrics(verdict),
        }


class ScriptedRubricJudge:
    """Offline stand-in: a deterministic read of the record, same output shape."""

    async def judge(self, record: Mapping[str, Any]) -> dict[str, Any]:
        exchanges = record.get("exchanges") or []
        objections: list[dict[str, Any]] = []
        for index, exchange in enumerate(exchanges):
            plan = (exchange.get("learner") or {}).get("plan") or {}
            move = plan.get("move_id") or ""
            if move[:2] in FAMILIES:
                previous = exchanges[index - 1]["advisor"]["text"] if index else ""
                current = exchange["advisor"]["text"]
                touched = _touches(move[:2], current) or _touches(move[:2], previous)
                objections.append(
                    {
                        "family": move[:2],
                        "turn": exchange.get("n"),
                        "in_context": bool(touched or plan.get("intent_forced")),
                        "canned_verbatim": bool(plan.get("fallback_appended")),
                        "why": "offline heuristic",
                    }
                )
        metrics = record.get("metrics") or {}
        reaction = float(metrics.get("reaction_rate") or 0.0)
        questions = float(metrics.get("question_rate") or 0.0)
        near = float(metrics.get("near_repeat_count") or 0.0)
        base = max(1, min(5, round(1 + 4 * reaction)))
        follow = max(1, min(5, round(1 + 4 * min(1.0, questions / 0.4))))
        variety = max(1, min(5, round(5 - near - 4 * float(metrics.get("neutral_ack_share") or 0.0))))
        verdict = {
            "objections": objections,
            "disclosures": [],
            "misfires": [
                {"turn": item.get("exchange"), "kind": "other"} for item in (metrics.get("misfires") or [])
            ],
            "stall_loop": int(metrics.get("weak_line_count") or 0) > 1,
            "style": {
                "reactions": base,
                "followups": follow,
                "hesitation": 3,
                "continuity": 3,
                "variety": variety,
            },
            "ignored_advisor_offers": [],
        }
        return {"source": "scripted", "model": "offline", "verdict": verdict, "metrics": judge_metrics(verdict)}


_TOPIC_WORDS = {
    "F1": ("price", "$", "discount", "cost", "afford", "payment"),
    "F2": ("time", "schedule", "flexible", "weeks", "months", "busy", "recording", "catch up"),
    "F3": ("free", "value", "job", "career", "mentor", "curriculum", "alumni"),
    "F4": ("decide", "think", "cohort", "seats", "ready", "call", "husband", "wife", "father", "partner"),
}


def _touches(family: str, advisor_text: str) -> bool:
    lowered = advisor_text.lower()
    return any(word in lowered for word in _TOPIC_WORDS[family])
