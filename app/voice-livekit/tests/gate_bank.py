"""The gate judge evaluation bank (M013 S01 T11). Tests only.

Shared by the CI replay (``tests/test_phone_gate_bank.py``) and the live runner
(``tests/eval_gate_bank_live.py``). Nothing here is imported by the worker.

THE BANK. ``tests/fixtures/gate_bank_synthetic.json`` holds synthetic items
(no candidate text, no real names). Each item is one reply window at one gate
phase: the bot line, the candidate's utterances with synthetic VAD timing
(milliseconds relative to the moment the question was heard), the recording
anchor for consent phases, and a gold label in the vocabulary of the code that
ACTS on the verdict. Each item also carries the judge response(s) the live
runner recorded from the production endpoint, tagged with the
``gate_judge.PROMPT_VERSION`` they were recorded under. Hand-written judge
responses belong in ``tests/test_phone_gate_judge.py`` (parser tests), never
here.

THE PIPELINE. ``evaluate_item`` drives the same code the call does, with only
the judge's HTTP transport swapped:

* identity: ``agent._GateJudgeWiring.decide`` then the identity route table
  (``phone._IDENTITY_VERDICT_FOR_INTENT``, the terminal intents and the
  record-name backstop), as ``phone.run_phone_gate`` applies them;
* consent / consent_retry: the consent reader's choice of the first fresh turn
  (stale and untimed-grant turns skipped, as ``agent._classify_phone_answer``
  does), then ``agent._judge_consent_reply`` (judge, guards, quiescence,
  legacy fallback and the intent -> classification table);
* callback_time: ``agent._GateJudgeWiring.decide`` and
  ``phone._judge_callback_spans`` (the verbatim-span rule);
* post_consent: ``agent._RevocationWindow`` (``on_final`` then ``read_turn``);
* qna_close: ``agent._QnaCloseWindow`` (``on_final`` then ``read_qna``).

The LEGACY baseline for consent is the reader's first fresh turn classified by
``agent.classify_answer_text`` (what ``PHONE_GATE_JUDGE=legacy`` does: no
acoustic guard, no recording-anchor guard). For qna_close it is
``phone.phone_qna_decline``. Identity has no regex baseline (its legacy path is
itself a model call), nor do callback_time and post_consent.

PRIVACY. Real items are never stored here. The live runner converts the real
bank (outside the repo) into this item shape in memory, scrubbed, and writes
only ids, labels, intents, latencies and pass/fail for them.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

from tests import test_phone_gate as _stub  # noqa: F401 — installs the SDK stub first

import agent as agent_mod  # noqa: E402
import gate_judge  # noqa: E402
import phone  # noqa: E402
from provider_resilience import CircuitBreaker, CircuitBreakerConfig  # noqa: E402

BANK_PATH = Path(__file__).resolve().parent / "fixtures" / "gate_bank_synthetic.json"

#: The families the plan requires the synthetic bank to cover.
FAMILIES = (
    "consent", "identity", "busy_time", "hinglish", "voicemail", "question",
    "unclear", "revocation", "qna_close", "injection",
)
MIN_ITEMS = 150

#: The only first names a synthetic item may carry.
SYNTHETIC_NAMES = frozenset({
    "Asha", "Neha", "Ravi", "Meera", "Arjun", "Kavya", "Rohan", "Isha", "Vikram",
    "Tara", "Dev", "Nisha",
})

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

#: Absolute epoch-ms the relative item timings are shifted onto (a plausible
#: wall clock, so the staleness rule's sanity window treats them as real).
BASE_MS = 1_767_600_000_000

#: Judge timeout used while evaluating. Replays answer instantly; the live
#: runner wants the verdict even from a slow call (latency is reported apart).
EVAL_TIMEOUT_SEC = 10.0

CONSENT_PHASES = (gate_judge.PHASE_CONSENT, gate_judge.PHASE_CONSENT_RETRY)

#: Consent-phase outcome labels (the gate's classification, or a re-ask).
_CONSENT_LABEL = {
    phone.CLASSIFY_HUMAN: "granted",
    phone.CLASSIFY_REFUSED: "declined",
    phone.CLASSIFY_OPT_OUT: "opt_out",
    phone.CLASSIFY_CALLBACK_REQUESTED: "busy",
    phone.CLASSIFY_END_REQUESTED: "end_call",
    phone.CLASSIFY_WRONG_NUMBER: "wrong_person",
    phone.CLASSIFY_MACHINE: "machine",
    None: "reask",
}

OUTCOMES = {
    gate_judge.PHASE_IDENTITY: (
        phone.PHONE_IDENTITY_SELF, phone.PHONE_IDENTITY_OTHER,
        phone.PHONE_IDENTITY_UNAVAILABLE, phone.PHONE_IDENTITY_UNCLEAR,
        "opt_out", "end_call"),
    gate_judge.PHASE_CONSENT: tuple(_CONSENT_LABEL.values()),
    gate_judge.PHASE_CONSENT_RETRY: tuple(_CONSENT_LABEL.values()),
    gate_judge.PHASE_CALLBACK_TIME: gate_judge.INTENTS,
    gate_judge.PHASE_POST_CONSENT: ("revocation", "answer"),
    gate_judge.PHASE_QNA_CLOSE: (
        agent_mod.QNA_KIND_DECLINE, agent_mod.QNA_KIND_QUESTION, agent_mod.QNA_KIND_OTHER),
}

_DIGIT_RUN_RE = re.compile(r"\d{5,}")


class BankError(AssertionError):
    """The bank is malformed, or a replay asked for something not recorded."""


# ── loading and validation ──────────────────────────────────────────────


def load_bank(path: Path | str = BANK_PATH) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_bank(data)
    return data


def validate_item(item: dict[str, Any], *, synthetic: bool = True) -> None:
    """Schema and privacy checks for one item. Raises ``BankError``."""
    iid = item.get("id")
    if not isinstance(iid, str) or not iid:
        raise BankError(f"item without an id: {item!r:.80}")
    phase = item.get("phase")
    if phase not in OUTCOMES:
        raise BankError(f"{iid}: unknown phase {phase!r}")
    gold = item.get("gold")
    allowed = OUTCOMES[phase]
    for label in [gold, *item.get("gold_alt", [])]:
        if label not in allowed:
            raise BankError(f"{iid}: gold {label!r} is not a {phase} outcome")
    utterances = item.get("utterances")
    if not isinstance(utterances, list) or not utterances:
        raise BankError(f"{iid}: no utterances")
    for u in utterances:
        if not isinstance(u.get("text"), str) or not u["text"].strip():
            raise BankError(f"{iid}: empty utterance")
        start = u.get("start_ms")
        if start is not None:
            for key in ("end_ms", "speech_ms"):
                if not isinstance(u.get(key), int):
                    raise BankError(f"{iid}: timed utterance without {key}")
    if phase in (gate_judge.PHASE_POST_CONSENT, gate_judge.PHASE_QNA_CLOSE) and len(utterances) != 1:
        raise BankError(f"{iid}: a window item is one STT final")
    if not isinstance(item.get("human"), bool):
        raise BankError(f"{iid}: human must be true or false")
    if synthetic:
        if item.get("family") not in FAMILIES:
            raise BankError(f"{iid}: unknown family {item.get('family')!r}")
        if item.get("first_name") not in SYNTHETIC_NAMES:
            raise BankError(f"{iid}: first_name must be one of the synthetic names")
        texts = [u["text"] for u in utterances] + [str(item.get("bot_line") or "")]
        if any(_DIGIT_RUN_RE.search(t) for t in texts):
            raise BankError(f"{iid}: a digit run of 5+ (a phone number?) in synthetic text")


def validate_bank(data: dict[str, Any]) -> None:
    if not isinstance(data, dict) or data.get("synthetic") is not True:
        raise BankError("the committed bank must declare synthetic: true")
    items = data.get("items")
    if not isinstance(items, list):
        raise BankError("bank has no items list")
    seen: set[str] = set()
    for item in items:
        validate_item(item, synthetic=True)
        if item["id"] in seen:
            raise BankError(f"duplicate id {item['id']}")
        seen.add(item["id"])


# ── the request each judge call carries ─────────────────────────────────


def request_payload(body: dict[str, Any]) -> dict[str, Any]:
    """The DATA payload of one judge request body, minus ``now_ist`` (a
    replay runs at a different wall time than the recording did)."""
    content = body["messages"][1]["content"]
    if not content.startswith("DATA "):
        raise BankError("judge request without a DATA payload")
    payload = json.loads(content[len("DATA "):])
    payload.pop("now_ist", None)
    return payload


def sent_prompt_version(body: dict[str, Any]) -> str:
    """``gate_judge.PROMPT_VERSION`` computed from the prompt actually SENT."""
    system = body["messages"][0]["content"]
    template = gate_judge._JUDGE_USER_TEMPLATE  # noqa: SLF001
    return hashlib.sha256((system + "\x00" + template).encode("utf-8")).hexdigest()[:12]


def payload_sha(payload: dict[str, Any]) -> str:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _ok_response(content: str) -> Any:
    return types.SimpleNamespace(
        status_code=200,
        json=lambda: {"choices": [{"message": {"content": content}}]},
    )


class RecordedTransport:
    """Answers an item's judge calls from its recorded live responses.

    Each request must equal the one recorded (same payload, minus the wall
    time, and the system prompt must be the current one, which the recorded
    ``prompt_version`` pins). Mismatches are collected in ``errors`` (an
    exception raised here would be swallowed by the judge as "unavailable").
    """

    def __init__(self, item: dict[str, Any]) -> None:
        self.item = item
        self._queue = list(item.get("recorded") or [])
        self.errors: list[str] = []
        self.responses: list[tuple[Any, Optional[str]]] = []

    @property
    def unused(self) -> int:
        return len(self._queue)

    async def request(self, *, method: str, url: str, json: dict[str, Any], headers: Any) -> Any:  # noqa: A002
        await asyncio.sleep(0)
        iid = self.item.get("id")
        payload = request_payload(json)
        if not self._queue:
            self.errors.append(f"{iid}: more judge calls than recorded responses")
            return types.SimpleNamespace(status_code=503, json=lambda: {})
        rec = self._queue.pop(0)
        if sent_prompt_version(json) != rec.get("prompt_version"):
            self.errors.append(f"{iid}: system prompt differs from the recorded one")
        if rec.get("payload_sha") != payload_sha(payload):
            self.errors.append(f"{iid}: request differs from the recorded one")
        status = rec.get("status")
        self.responses.append((status, rec.get("content")))
        if status == "timeout":
            raise asyncio.TimeoutError
        if isinstance(status, int) and status != 200:
            return types.SimpleNamespace(status_code=status, json=lambda: {})
        if status != 200:
            raise ConnectionError(str(status))  # a transport error, recorded live
        return _ok_response(rec.get("content") or "")


def judge_config(api_key: str = "bank-replay", model: str = gate_judge.GATE_JUDGE_DEFAULT_MODEL,
                 url: str = DEEPSEEK_URL) -> Any:
    return gate_judge.JudgeConfig(enabled=True, url=url, model=model, api_key=api_key)


def fresh_breaker() -> Any:
    # Per item, so one item's failures never open the breaker for the next.
    return CircuitBreaker(CircuitBreakerConfig(
        failure_threshold=1000, cooldown_sec=1.0, timeout_sec=0))


class _FixedBudget:
    """The slice of `phone.GateBudget` the wiring reads, at a fixed bound."""

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds

    def judge_timeout_sec(self) -> float:
        return self.seconds

    def bound(self, value: float) -> float:
        return min(float(value), self.seconds)


# ── one item through the real pipeline ──────────────────────────────────


@dataclass
class ItemResult:
    id: str
    family: str
    phase: str
    human: bool
    gold: str
    gold_alt: tuple[str, ...]
    outcome: Optional[str]
    legacy_outcome: Optional[str]
    judge_intent: Optional[str] = None
    judge_valid: bool = False
    judge_status: Any = None
    unavailable_reason: Optional[str] = None
    latency_ms: Optional[int] = None
    spans_ok: Optional[bool] = None
    guard_rejected: Optional[str] = None
    notes: dict[str, Any] = field(default_factory=dict)

    @property
    def correct(self) -> bool:
        return self.outcome == self.gold or self.outcome in self.gold_alt

    @property
    def consent(self) -> bool:
        return self.phase in CONSENT_PHASES

    @property
    def false_grant(self) -> bool:
        return self.consent and self.outcome == "granted" and self.gold != "granted"

    @property
    def legacy_false_grant(self) -> bool:
        return self.consent and self.legacy_outcome == "granted" and self.gold != "granted"

    @property
    def gold_grant(self) -> bool:
        return self.consent and self.gold == "granted"

    @property
    def machine_on_human(self) -> bool:
        return self.human and (
            self.judge_intent == gate_judge.INTENT_VOICEMAIL or self.outcome == "machine")


def _utterance(idx: int, u: dict[str, Any]) -> Any:
    start = u.get("start_ms")
    if start is None:
        return gate_judge.GateUtterance(
            idx=idx, text=u["text"], final_arrival_ms=BASE_MS + 500 * (idx + 1),
            segment_start_ms=None, segment_end_ms=None, segment_speech_ms=None,
        )
    end = BASE_MS + int(u["end_ms"])
    return gate_judge.GateUtterance(
        idx=idx, text=u["text"], final_arrival_ms=end + 300,
        segment_start_ms=BASE_MS + int(start), segment_end_ms=end,
        segment_speech_ms=int(u["speech_ms"]), segment_first_end_ms=end,
    )


def _turn(u: Any) -> Any:
    """The closed turn the reader receives for one utterance (SDK-committed)."""
    return gate_judge.GateTurn(
        text=u.text, utterance_idxs=(u.idx,), segment_start_ms=u.segment_start_ms,
        segment_end_ms=u.segment_end_ms, segment_speech_ms=u.segment_speech_ms,
        final_arrival_ms=u.final_arrival_ms, committed=True, closed_by="commit",
        sdk_anchor_ms=None, vad_observed=True, segment_first_end_ms=u.segment_first_end_ms,
    )


def _capture(utterances: Iterable[Any]) -> Any:
    capture = gate_judge.GateTurnCapture(
        emit=lambda turn: None,
        # Far after every item's speech: nothing is still awaiting its final.
        now_ms=lambda: BASE_MS + 3_600_000,
        settle_ms=lambda: 1_250,
    )
    for u in utterances:
        assert capture.utterances.next_idx() == u.idx
        capture.utterances.append(u)
    return capture


def _reader_choice(turns: list[Any], spoke_before: bool) -> Optional[Any]:
    """The consent reader's first usable turn (`_classify_phone_answer`)."""
    question_ms = BASE_MS
    for turn in turns:
        _, anchor = agent_mod._queued_turn(turn)  # noqa: SLF001
        if agent_mod._queued_turn_is_stale(anchor, question_ms):  # noqa: SLF001
            continue
        if (not gate_judge.turn_is_grant_evidence(turn)
                and agent_mod.classify_answer_text(
                    turn.text, candidate_spoke=spoke_before) == phone.CLASSIFY_HUMAN):
            continue
        return turn
    return None


def _first_raw(transport: Any) -> tuple[Any, Optional[str]]:
    responses = getattr(transport, "responses", None) or []
    return responses[0] if responses else (None, None)


async def evaluate_item(
    item: dict[str, Any], transport: Any, *, config: Any = None,
    timeout_sec: float = EVAL_TIMEOUT_SEC,
) -> ItemResult:
    """Drive one item through the real gate code with ``transport``."""
    cfg = config if config is not None else judge_config()
    phase = item["phase"]
    utterances = [_utterance(i, u) for i, u in enumerate(item["utterances"])]
    bot_line = str(item.get("bot_line") or "")
    first_name = item.get("first_name") or ""
    spoke_before = bool(item.get("spoke_before", True))
    logs: list[dict[str, Any]] = []
    result = ItemResult(
        id=item["id"], family=str(item.get("family") or "real"), phase=phase,
        human=bool(item["human"]), gold=item["gold"],
        gold_alt=tuple(item.get("gold_alt") or ()), outcome=None, legacy_outcome=None,
    )

    if phase in (gate_judge.PHASE_POST_CONSENT, gate_judge.PHASE_QNA_CLOSE):
        text = utterances[0].text
        common = dict(
            first_name=first_name, mode=gate_judge.GATE_JUDGE_MODE_LLM, config=cfg,
            transport=transport, breaker=fresh_breaker(),
            log=lambda **f: logs.append(f), timeout_sec=lambda: timeout_sec,
        )
        if phase == gate_judge.PHASE_POST_CONSENT:
            window = agent_mod._RevocationWindow(bot_line=lambda: bot_line, **common)  # noqa: SLF001
            window.arm()
            window.on_final(text)
            route, decision, _ = await window.read_turn(text)
            result.outcome = "revocation" if route == "revocation" else (
                "answer" if route == "answer" else None)
            result.notes["route"] = route
        else:
            window = agent_mod._QnaCloseWindow(**common)  # noqa: SLF001
            window.bind_bot_line(lambda: bot_line)
            window.arm()
            window.on_final(text)
            kind, decision = await window.read_qna(text)
            result.outcome = kind if kind in OUTCOMES[phase] else None
            result.legacy_outcome = (
                agent_mod.QNA_KIND_DECLINE if phone.phone_qna_decline(text) else "open")
        window.close("bank_done")
        for entry in logs:
            if entry.get("error_type") == "phone_gate_decision" and entry.get("rejection_reason"):
                result.guard_rejected = str(entry["rejection_reason"])
    else:
        capture = _capture(utterances)
        latch = gate_judge.HumanSpeechLatch()
        if spoke_before:
            latch.mark(gate_judge.SPOKE_SOURCE_IDENTITY)
        rec = item.get("recording_anchor_ms")
        wiring = agent_mod._GateJudgeWiring(  # noqa: SLF001
            capture=capture, latch=latch, question_anchor=lambda: BASE_MS,
            recording_anchor=(lambda: BASE_MS + int(rec)) if rec is not None else None,
            budget=_FixedBudget(timeout_sec), first_name=first_name,
            mode=gate_judge.GATE_JUDGE_MODE_LLM, config=cfg, transport=transport,
            breaker=fresh_breaker(), log=lambda **f: logs.append(f),
        )
        if phase in CONSENT_PHASES:
            turns = [_turn(u) for u in utterances]
            chosen = _reader_choice(turns, spoke_before)
            if chosen is None:
                raise BankError(f"{item['id']}: the consent reader would read no turn")
            result.legacy_outcome = _CONSENT_LABEL.get(
                agent_mod.classify_answer_text(chosen.text, candidate_spoke=spoke_before),
                "reask")
            judged = await agent_mod._judge_consent_reply(  # noqa: SLF001
                wiring, phase, bot_line, text=chosen.text, chosen=chosen,
                turns=asyncio.Queue(), question_anchor=lambda: BASE_MS, budget=None,
                spoke_before=spoke_before,
            )
            result.outcome = _CONSENT_LABEL.get(judged.decision, str(judged.decision))
            decision = wiring.last_decision
            if judged.faq_kind:
                result.notes["question_kind"] = judged.faq_kind
        elif phase == gate_judge.PHASE_IDENTITY:
            decision = await wiring.decide(phase, bot_line, legacy=lambda: None)
            result.outcome = _identity_route(decision, utterances, first_name)
        else:  # callback_time
            decision = await wiring.decide(phase, bot_line, legacy=lambda: None)
            result.outcome = decision.intent if decision.source == gate_judge.SOURCE_LLM else None
            expected = item.get("spans")
            if expected is not None:
                spans = phone._judge_callback_spans(  # noqa: SLF001
                    decision, [u.text for u in utterances])
                result.spans_ok = bool(
                    spans is not None
                    and (not expected.get("day") or spans.day_text)
                    and (not expected.get("time") or spans.time_text))
        if decision is not None and decision.guard_rejected_reason:
            result.guard_rejected = decision.guard_rejected_reason

    status, content = _first_raw(transport)
    result.judge_status = status
    if status == 200:
        parsed = gate_judge.parse_judge_output(content)
        if isinstance(parsed, gate_judge.JudgeVerdict):
            result.judge_valid = True
            result.judge_intent = parsed.intent
        else:
            result.unavailable_reason = parsed.reason
    elif status is not None:
        result.unavailable_reason = str(status)
    return result


def _identity_route(decision: Any, utterances: list[Any], first_name: str) -> Optional[str]:
    """`phone.run_phone_gate`'s `_identity_route` for a judged reply."""
    intent = decision.intent if decision.source == gate_judge.SOURCE_LLM else None
    if intent is None:
        return None
    if intent == gate_judge.INTENT_OPT_OUT:
        return "opt_out"
    if intent in (gate_judge.INTENT_END_CALL, gate_judge.INTENT_CONSENT_DECLINED):
        return "end_call"
    verdict = phone._IDENTITY_VERDICT_FOR_INTENT.get(intent, phone.PHONE_IDENTITY_UNCLEAR)  # noqa: SLF001
    reply = " ".join(u.text for u in utterances
                     if u.segment_start_ms is None or u.segment_start_ms >= BASE_MS)
    if verdict == phone.PHONE_IDENTITY_OTHER and phone._identity_reply_names_the_record(  # noqa: SLF001
            reply, first_name):
        verdict = phone.PHONE_IDENTITY_SELF
    return verdict


def run_items(items: Iterable[dict[str, Any]], make_transport: Any, **kwargs: Any) -> list[ItemResult]:
    """Evaluate items one after another (sequential: latency is per call)."""
    async def _all() -> list[ItemResult]:
        out = []
        for item in items:
            out.append(await evaluate_item(item, make_transport(item), **kwargs))
        return out

    gate_judge._reset_for_tests()  # noqa: SLF001
    return asyncio.run(_all())


# ── the pass rules ──────────────────────────────────────────────────────


def percentile(values: list[float], pct: float) -> Optional[float]:
    """Nearest-rank percentile (no interpolation): an observed value."""
    data = sorted(values)
    if not data:
        return None
    rank = max(1, math.ceil(pct / 100.0 * len(data)))
    return data[rank - 1]


def summarize(results: list[ItemResult]) -> dict[str, Any]:
    consent = [r for r in results if r.consent]
    gold_grants = [r for r in consent if r.gold_grant]
    completed = [r for r in results if r.judge_status == 200]
    by_phase: dict[str, dict[str, int]] = {}
    for r in results:
        bucket = by_phase.setdefault(r.phase, {"n": 0, "correct": 0})
        bucket["n"] += 1
        bucket["correct"] += int(r.correct)
    by_family: dict[str, dict[str, int]] = {}
    for r in results:
        bucket = by_family.setdefault(r.family, {"n": 0, "correct": 0})
        bucket["n"] += 1
        bucket["correct"] += int(r.correct)
    qna = [r for r in results if r.phase == gate_judge.PHASE_QNA_CLOSE]
    post = [r for r in results if r.phase == gate_judge.PHASE_POST_CONSENT]
    spans = [r for r in results if r.spans_ok is not None]
    return {
        "n": len(results),
        "correct": sum(int(r.correct) for r in results),
        "by_phase": by_phase,
        "by_family": by_family,
        "consent_items": len(consent),
        "false_grants": sorted(r.id for r in consent if r.false_grant),
        "legacy_false_grants": sorted(r.id for r in consent if r.legacy_false_grant),
        "gold_grants": len(gold_grants),
        "true_grants": sum(1 for r in gold_grants if r.outcome == "granted"),
        "legacy_true_grants": sum(1 for r in gold_grants if r.legacy_outcome == "granted"),
        "machine_on_human": sorted(r.id for r in results if r.machine_on_human),
        "judge_calls_completed": len(completed),
        "judge_valid_json": sum(1 for r in completed if r.judge_valid),
        "judge_timeouts": sum(1 for r in results if r.judge_status == "timeout"),
        "judge_http_errors": sum(
            1 for r in results if r.judge_status not in (200, "timeout", None)),
        "qna_declines_on_questions": sorted(
            r.id for r in qna if r.gold == agent_mod.QNA_KIND_QUESTION
            and r.outcome == agent_mod.QNA_KIND_DECLINE),
        "post_consent_revocations_on_answers": sorted(
            r.id for r in post if r.gold == "answer" and r.outcome == "revocation"),
        "spans_checked": len(spans),
        "spans_ok": sum(1 for r in spans if r.spans_ok),
        "wrong": sorted(r.id for r in results if not r.correct),
    }


def recall(true_grants: int, gold_grants: int) -> float:
    return (true_grants / gold_grants) if gold_grants else 1.0


def gate_failures(summary: dict[str, Any]) -> list[str]:
    """The plan's pass rules; an empty list means the gate passes."""
    failures = []
    if summary["false_grants"]:
        failures.append(f"false grants: {summary['false_grants']}")
    if len(summary["false_grants"]) > len(summary["legacy_false_grants"]):
        failures.append("more false grants than legacy")
    if summary["machine_on_human"]:
        failures.append(f"machine verdicts on human items: {summary['machine_on_human']}")
    llm_recall = recall(summary["true_grants"], summary["gold_grants"])
    legacy_recall = recall(summary["legacy_true_grants"], summary["gold_grants"])
    if llm_recall < legacy_recall:
        failures.append(f"true-grant recall {llm_recall:.3f} below legacy {legacy_recall:.3f}")
    done = summary["judge_calls_completed"]
    if done and summary["judge_valid_json"] / done < 0.995:
        failures.append(
            f"valid JSON {summary['judge_valid_json']}/{done} is below 99.5%")
    return failures


def latency_by_phase(records: Iterable[tuple[str, Any, Optional[int]]]) -> dict[str, dict[str, Any]]:
    """``(phase, status, latency_ms)`` triples -> p50/p95 per phase (completed
    calls only; timeouts counted apart)."""
    groups: dict[str, list[float]] = {}
    timeouts: dict[str, int] = {}
    for phase, status, latency in records:
        key = "consent" if phase in CONSENT_PHASES else phase
        if status == 200 and isinstance(latency, (int, float)):
            groups.setdefault(key, []).append(float(latency))
        elif status == "timeout":
            timeouts[key] = timeouts.get(key, 0) + 1
    out = {}
    for key in sorted(set(groups) | set(timeouts)):
        values = groups.get(key, [])
        out[key] = {
            "n": len(values), "p50_ms": percentile(values, 50),
            "p95_ms": percentile(values, 95), "max_ms": max(values) if values else None,
            "timeouts": timeouts.get(key, 0),
        }
    return out


def now_ms() -> int:
    return int(time.time() * 1000)
