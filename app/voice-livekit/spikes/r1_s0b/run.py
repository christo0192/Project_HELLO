"""Run the isolated S0-B text-only DeepSeek persona/latency harness.

Usage from app/voice-livekit:
  python -m spikes.r1_s0b.run --output ../../docs/design/r1/s0b-raw-2026-10-06.jsonl
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import statistics
from typing import Any

from .content import PERSONAS
from .learner import DeepSeekClient, build_learner_prefix, build_turn_reminder, guard_learner_output
from .scheduler import OwedMoveScheduler
from .sim_candidate import ADVERSARIES, SimCandidate, TIERS


PROBE_KEYWORDS = {
    "H1": ("why now", "timeline", "trigger", "when", "goal", "career"),
    "H2": ("challenge", "difficult", "concern", "learning", "experience", "interview", "setback"),
    "H3": ("schedule", "time", "budget", "afford", "payment", "instalment", "installment", "decision", "family"),
}
FACT_CONTRADICTIONS = ("guaranteed job", "100% placement", "three months", "12 months", "free course")
COMMITMENT_RE = re.compile(r"\b(enrol|enroll|sign up|deposit|payment link|shall i send|can we book|are you ready to)\b", re.I)
CONCESSION_RE = re.compile(r"\$\s*(?:[2-9]\d{3}|1[6-9]\d{2}|[2-9]\d{2})|(?:[2-9]\d|1[6-9])\s*%\s*(?:off|discount)", re.I)
AUTH_RE = re.compile(r"(?i)(authorization\s*:\s*bearer\s+|bearer\s+)[A-Za-z0-9._-]+")
KEY_RE = re.compile(r"(?i)(DEEPSEEK_API_KEY\s*=\s*)[^\s]+|\bsk-[A-Za-z0-9._-]+")


def redact_text(text: str) -> str:
    """Defence in depth for raw results; request headers are never recorded."""
    text = AUTH_RE.sub(r"\1[REDACTED]", text)
    return KEY_RE.sub(lambda match: f"{match.group(1)}[REDACTED]" if match.group(1) else "[REDACTED]", text)


@dataclass
class ConversationResult:
    persona: str
    tier: str
    adversary: str | None
    learner_turns: int
    ttft_seconds: list[float]
    latency_seconds: list[float]
    prompt_tokens: int
    completion_tokens: int
    cache_hit_tokens: int
    reasoning_tokens: int
    reasoning_token_fields_reported: int
    reasoning_content_chunks: int
    models: list[str]
    owed_summary: dict[str, object]
    volunteered_deep_needs: list[str]
    correct_unlocks: int
    unlock_opportunities: int
    leaks: list[dict[str, object]]
    premature_commitments: list[str]
    premature_concessions: list[str]
    contradictions: list[str]
    turn_results: list[dict[str, object]]


def _unlocked(persona, advisor_text: str) -> dict[str, str]:
    lowered = advisor_text.lower()
    return {topic: persona.deep_needs[topic] for topic, keywords in PROBE_KEYWORDS.items() if any(word in lowered for word in keywords)}


def run_conversation(client: DeepSeekClient, persona, tier: str, adversary: str | None, turns: int) -> ConversationResult:
    scheduler = OwedMoveScheduler(persona)
    candidate = SimCandidate(client, tier, adversary)
    history: list[dict[str, str]] = []
    candidate_text = "Hi, this is the Program Advisor from Interview Kickstart. Thanks for taking my call. What made you look into data science now?"
    ttfts: list[float] = []
    latencies: list[float] = []
    prompt_tokens = completion_tokens = cache_hit_tokens = reasoning_tokens = 0
    reasoning_token_fields_reported = reasoning_content_chunks = 0
    models: list[str] = []
    volunteered: list[str] = []
    correct_unlocks = unlock_opportunities = 0
    leaks: list[dict[str, object]] = []
    premature_commitments: list[str] = []
    premature_concessions: list[str] = []
    contradictions: list[str] = []
    turn_results: list[dict[str, object]] = []
    for index in range(turns):
        scheduler.observe_candidate(candidate_text)
        unlocked = _unlocked(persona, candidate_text)
        owed = scheduler.next_owed()
        reminder = build_turn_reminder(r_seconds=scheduler.r_seconds, owed_move=owed, unlocked_deep_needs=unlocked, commitment_response=scheduler.pre_stated_commitment())
        messages = [{"role": "system", "content": build_learner_prefix(persona)}] + history + [{"role": "system", "content": reminder}, {"role": "user", "content": candidate_text}]
        completion = client.complete_with_fallback(messages)
        learner_text, guard_hits = guard_learner_output(completion.text)
        if completion.ttft_sec is not None:
            ttfts.append(completion.ttft_sec)
        latencies.append(completion.total_latency_sec)
        prompt_tokens += completion.prompt_tokens or 0
        completion_tokens += completion.completion_tokens or 0
        cache_hit_tokens += completion.prompt_cache_hit_tokens or 0
        reasoning_tokens += completion.reasoning_tokens or 0
        reasoning_token_fields_reported += int(completion.reasoning_tokens is not None)
        reasoning_content_chunks += completion.reasoning_content_chunks
        models.append(completion.response_model or completion.requested_model)
        if guard_hits:
            leaks.append({"turn": index + 1, "terms": guard_hits, "raw": completion.text})
        if owed:
            scheduler.record_learner_text(learner_text)
        for topic, need in persona.deep_needs.items():
            if need.lower() in learner_text.lower():
                if topic in unlocked:
                    correct_unlocks += 1
                else:
                    volunteered.append(topic)
        unlock_opportunities += len(unlocked)
        if scheduler.r_seconds < 540 and (COMMITMENT_RE.search(learner_text) or "let's do it" in learner_text.lower()):
            premature_commitments.append(learner_text)
        if scheduler.r_seconds < 540 and CONCESSION_RE.search(learner_text):
            premature_concessions.append(learner_text)
        contradictions.extend(term for term in FACT_CONTRADICTIONS if term in learner_text.lower())
        history.extend(({"role": "user", "content": candidate_text}, {"role": "assistant", "content": learner_text}))
        # The estimate is only meaningful with a bounded learner context.
        history = history[-12:]
        advisor_completion = None
        next_candidate_text = None
        if index + 1 < turns:
            next_candidate_text, advisor_completion = candidate.next_turn(history, index + 1)
            if advisor_completion:
                prompt_tokens += advisor_completion.prompt_tokens or 0
                completion_tokens += advisor_completion.completion_tokens or 0
                cache_hit_tokens += advisor_completion.prompt_cache_hit_tokens or 0
                reasoning_tokens += advisor_completion.reasoning_tokens or 0
                reasoning_token_fields_reported += int(advisor_completion.reasoning_tokens is not None)
                reasoning_content_chunks += advisor_completion.reasoning_content_chunks
                models.append(advisor_completion.response_model or advisor_completion.requested_model)
            contradictions.extend(term for term in FACT_CONTRADICTIONS if term in next_candidate_text.lower())
        turn_results.append({
            "conversation": {"persona": persona.id, "tier": tier, "adversary": adversary},
            "turn": index + 1,
            "advisor_text": redact_text(candidate_text),
            "learner_text": redact_text(learner_text),
            "learner_raw_guarded": bool(guard_hits),
            "learner_model": completion.response_model or completion.requested_model,
            "learner_ttft_seconds": completion.ttft_sec,
            "learner_total_latency_seconds": completion.total_latency_sec,
            "learner_usage": {"prompt_tokens": completion.prompt_tokens, "completion_tokens": completion.completion_tokens, "cache_hit_tokens": completion.prompt_cache_hit_tokens, "reasoning_tokens": completion.reasoning_tokens, "reasoning_content_chunks": completion.reasoning_content_chunks},
            "next_advisor_model": None if advisor_completion is None else (advisor_completion.response_model or advisor_completion.requested_model),
            "next_advisor_usage": None if advisor_completion is None else {"prompt_tokens": advisor_completion.prompt_tokens, "completion_tokens": advisor_completion.completion_tokens, "cache_hit_tokens": advisor_completion.prompt_cache_hit_tokens, "reasoning_tokens": advisor_completion.reasoning_tokens, "reasoning_content_chunks": advisor_completion.reasoning_content_chunks},
        })
        if next_candidate_text is not None:
            candidate_text = next_candidate_text
    return ConversationResult(persona.id, tier, adversary, turns, ttfts, latencies, prompt_tokens, completion_tokens, cache_hit_tokens,
                              reasoning_tokens, reasoning_token_fields_reported, reasoning_content_chunks, sorted(set(models)), scheduler.delivery_summary(), volunteered, correct_unlocks,
                              unlock_opportunities, leaks, premature_commitments, premature_concessions, contradictions, turn_results)


def estimate_peak_cost_usd(conversations: int, turns: int) -> float:
    """Peak-rate ceiling from bounded harness contexts, with no cache discount.

    Learner turns retain at most 12 dialogue messages (4k input, 150 output);
    advisor simulation retains the same window but has a smaller prompt (2.5k
    input, 120 output).  This is intentionally above the generated limits and
    assumes every input token is an uncached peak-rate token.
    """
    learner_turn = (4_000 / 1_000_000 * 0.30) + (150 / 1_000_000 * 1.20)
    candidate_turn = (2_500 / 1_000_000 * 0.30) + (120 / 1_000_000 * 1.20)
    return conversations * turns * (learner_turn + candidate_turn)


def matrix(repetitions: int) -> list[tuple[Any, str, str | None]]:
    work = [(persona, tier, None) for persona in PERSONAS for tier in TIERS for _ in range(repetitions)]
    work.extend((persona, "medium", adversary) for persona in PERSONAS for adversary in ADVERSARIES)
    return work


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--turns", type=int, default=18)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-estimated-usd", type=float, default=4.50)
    parser.add_argument("--smoke", action="store_true", help="run only P1/medium baseline (for credential and protocol preflight)")
    parser.add_argument("--resume", action="store_true", help="append after complete 18-turn conversations already in --output")
    args = parser.parse_args()
    work = matrix(args.repetitions)
    if args.smoke:
        work = [(PERSONAS[0], "medium", None)]
    completed = 0
    if args.resume and args.output.exists():
        with args.output.open("r", encoding="utf-8") as handle:
            completed = sum(1 for line in handle if line.strip())
        if completed % args.turns:
            raise SystemExit(f"refusing resume: {args.output} has {completed} records, not a whole number of {args.turns}-turn conversations")
        completed //= args.turns
        if completed > len(work):
            raise SystemExit(f"refusing resume: {completed} completed conversations exceeds planned {len(work)}")
        work = work[completed:]
    estimate = estimate_peak_cost_usd(len(work), args.turns)
    if estimate > args.max_estimated_usd:
        raise SystemExit(f"refusing run: conservative estimate ${estimate:.2f} exceeds cap ${args.max_estimated_usd:.2f}")
    client = DeepSeekClient()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("a" if args.resume else "w", encoding="utf-8") as handle:
        for position, (persona, tier, adversary) in enumerate(work, start=1):
            result = run_conversation(client, persona, tier, adversary, args.turns)
            result.turn_results[-1]["conversation_summary"] = {
                "learner_turns": result.learner_turns,
                "ttft_seconds": result.ttft_seconds,
                "latency_seconds": result.latency_seconds,
                "prompt_tokens": result.prompt_tokens,
                "completion_tokens": result.completion_tokens,
                "cache_hit_tokens": result.cache_hit_tokens,
                "reasoning_tokens": result.reasoning_tokens,
                "reasoning_token_fields_reported": result.reasoning_token_fields_reported,
                "reasoning_content_chunks": result.reasoning_content_chunks,
                "models": result.models,
                "owed_summary": result.owed_summary,
                "volunteered_deep_needs": result.volunteered_deep_needs,
                "correct_unlocks": result.correct_unlocks,
                "unlock_opportunities": result.unlock_opportunities,
                "leak_count": len(result.leaks),
                "premature_commitment_count": len(result.premature_commitments),
                "premature_concession_count": len(result.premature_concessions),
                "contradictions": result.contradictions,
            }
            for turn_result in result.turn_results:
                handle.write(json.dumps(turn_result, ensure_ascii=False) + "\n")
            handle.flush()
            print(f"completed {completed + position}/{completed + len(work)} {persona.id} {tier} {adversary or 'baseline'}")
    print(json.dumps({"conversations_run": len(work), "previously_completed": completed, "conservative_peak_estimate_usd": round(estimate, 2), "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
