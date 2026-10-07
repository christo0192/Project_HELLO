"""Live runner for the gate judge evaluation bank (M013 S01 T11).

NOT a unit test: the filename has no ``test_`` prefix, so discovery skips it,
and it refuses to run unless ``PHONE_GATE_EVAL_LIVE=1``. It calls the real
judge endpoint (DeepSeek, ``PHONE_JUDGE_URL``, default the official one) with
the key from ``PHONE_JUDGE_API_KEY`` or ``DEEPSEEK_API_KEY``. The key is never
printed or written.

Every item goes through the same code the CI replay drives
(``tests/gate_bank.evaluate_item``: the real wiring, guards and route tables);
only the HTTP transport is live. Calls are sequential, one at a time, on one
keep-alive connection (as the worker's warmed pool is), so each latency is one
round trip.

Usage (from app/voice-livekit)::

    PHONE_GATE_EVAL_LIVE=1 python tests/eval_gate_bank_live.py --record
        Re-record every synthetic item's judge response into
        tests/fixtures/gate_bank_synthetic.json, tagged with the current
        gate_judge.PROMPT_VERSION. Needed after ANY prompt change (CI fails
        otherwise).

    PHONE_GATE_EVAL_LIVE=1 python tests/eval_gate_bank_live.py \\
        --real C:/tmp/m013/bank_items.json --real-gold C:/tmp/m013/real_gold.json \\
        --scrub C:/tmp/m013/scrub_names.json --out C:/tmp/m013/bank_live_results.json

        Also evaluate the REAL bank, which never enters the repo. Before
        anything is sent, each real item is scrubbed: every name in the scrub
        map (candidate names, and any name inside an utterance) is replaced by
        a synthetic one, and digit runs longer than 4 are masked. The results
        file and stdout carry ids, labels, intents, latencies and pass/fail
        only, never text.

    --passes N   run every item N times in all (latency samples; only the
                 first pass is recorded into the bank).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from tests import gate_bank as gb  # noqa: E402 — installs the SDK stub first

import gate_judge  # noqa: E402

#: A real row whose text is exactly this is the retired generation seed
#: (T10), model context and not speech: never an item, never context.
_SEED_TEXT = "Hello?"
_DIGITS_RE = re.compile(r"\d{5,}")
_REAL_FIRST_NAME = "Asha"


# ── the live transport ──────────────────────────────────────────────────


class LiveTransport:
    """One item's judge calls over a shared httpx client, each recorded."""

    def __init__(self, client: Any, model: str) -> None:
        self.client = client
        self.model = model
        self.records: list[dict[str, Any]] = []
        self.responses: list[tuple[Any, Optional[str]]] = []

    async def request(self, *, method: str, url: str, json: dict[str, Any], headers: Any) -> Any:  # noqa: A002
        payload = gb.request_payload(json)
        record: dict[str, Any] = {
            "source": "live", "prompt_version": gb.sent_prompt_version(json),
            "model": self.model, "recorded_at": date.today().isoformat(),
            "payload_sha": gb.payload_sha(payload),
        }
        started = time.perf_counter()
        try:
            response = await self.client.request(method=method, url=url, json=json, headers=headers)
        except asyncio.CancelledError:
            record.update(status="timeout", content=None,
                          latency_ms=int(round((time.perf_counter() - started) * 1000)))
            self._keep(record)
            raise
        except Exception as exc:  # noqa: BLE001
            record.update(status=f"error:{type(exc).__name__}", content=None,
                          latency_ms=int(round((time.perf_counter() - started) * 1000)))
            self._keep(record)
            raise
        record["latency_ms"] = int(round((time.perf_counter() - started) * 1000))
        record["status"] = response.status_code
        content = None
        if response.status_code == 200:
            try:
                content = response.json()["choices"][0]["message"]["content"]
            except Exception:  # noqa: BLE001
                content = None
        record["content"] = content
        self._keep(record)
        return response

    def _keep(self, record: dict[str, Any]) -> None:
        self.records.append(record)
        self.responses.append((record["status"], record.get("content")))


# ── the real bank, converted in memory ──────────────────────────────────


def _scrub(text: str, names: dict[str, str]) -> str:
    out = text or ""
    for real, fake in sorted(names.items(), key=lambda kv: -len(kv[0])):
        out = re.sub(rf"\b{re.escape(real)}\b", fake, out, flags=re.IGNORECASE)
    return _DIGITS_RE.sub("#####", out)


def _phase_for(ctx: str) -> str:
    if ctx == "identity":
        return gate_judge.PHASE_IDENTITY
    if ctx == "consent_reask":
        return gate_judge.PHASE_CONSENT_RETRY
    return gate_judge.PHASE_CONSENT


def real_items(items_path: Path, gold_path: Path, scrub_path: Path) -> list[dict[str, Any]]:
    """The labelled real rows as bank items, scrubbed. Context: the session's
    earlier candidate rows that answered a DIFFERENT bot line, as pre-question
    speech (earlier rows to the same line are separate replies with their own
    gold, so they are left out)."""
    rows = json.loads(items_path.read_text(encoding="utf-8"))
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    names = json.loads(scrub_path.read_text(encoding="utf-8"))
    by_session: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_session.setdefault(row["sess"], []).append(row)
    out = []
    for key, label in gold.items():
        sess, ti = key.split(":")
        session = sorted(by_session.get(sess, []), key=lambda r: r["ti"])
        row = next((r for r in session if r["ti"] == int(ti)), None)
        if row is None or row["text"] == _SEED_TEXT:
            raise SystemExit(f"gold row {key} missing from the real bank")
        raw_bot = row.get("bot") or ""
        interrupted = raw_bot.startswith("[interrupted question]")
        bot = re.sub(r"^\[interrupted question\]\s*", "", raw_bot)
        # The only timing the real bank holds: a line the reply interrupted.
        # The recording sentence ("This call is recorded ...") was heard only
        # if the line got as far as starting it; otherwise the reply began
        # before it (the split line's anchor is part B's first audio).
        heard_recording = not interrupted or "this call" in bot.lower()
        context = [
            r for r in session
            if r["ti"] < row["ti"] and r["text"] != _SEED_TEXT and r.get("bot") != row.get("bot")
        ][-5:]
        utterances = []
        for j, r in enumerate(context):
            start = -8000 + 1500 * j
            utterances.append({"text": _scrub(r["text"], names), "start_ms": start,
                               "end_ms": start + 700, "speech_ms": 700})
        utterances.append({"text": _scrub(row["text"], names), "start_ms": 600,
                           "end_ms": 1300, "speech_ms": 700})
        phase = _phase_for(row["ctx"])
        out.append({
            "id": key, "family": "real", "phase": phase,
            "bot_line": _scrub(bot, names), "first_name": _REAL_FIRST_NAME,
            "spoke_before": bool(context), "human": bool(label.get("human", True)),
            "recording_anchor_ms": (
                (0 if heard_recording else 2000) if phase in gb.CONSENT_PHASES else None),
            "utterances": utterances, "gold": label["gold"],
            "gold_alt": label.get("alt", []),
        })
    for item in out:
        gb.validate_item(item, synthetic=False)
    return out


# ── running ─────────────────────────────────────────────────────────────


async def _run(items: list[dict[str, Any]], client: Any, config: Any) -> tuple[list[Any], list[LiveTransport]]:
    results, transports = [], []
    for item in items:
        transport = LiveTransport(client, config.model)
        results.append(await gb.evaluate_item(item, transport, config=config))
        transports.append(transport)
    return results, transports


def _real_row(result: Any) -> dict[str, Any]:
    """A real item's result: ids, labels, intents, latency, pass/fail. No text."""
    return {
        "id": result.id, "phase": result.phase, "human": result.human, "gold": result.gold,
        "outcome": result.outcome, "legacy_outcome": result.legacy_outcome,
        "judge_intent": result.judge_intent, "judge_status": result.judge_status,
        "unavailable_reason": result.unavailable_reason, "latency_ms": result.latency_ms,
        "guard_rejected": result.guard_rejected, "correct": result.correct,
        "false_grant": result.false_grant, "legacy_false_grant": result.legacy_false_grant,
        "machine_on_human": result.machine_on_human,
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--record", action="store_true",
                        help="write the synthetic responses into the bank file")
    parser.add_argument("--bank", default=str(gb.BANK_PATH))
    parser.add_argument("--real", help="the real bank (outside the repo)")
    parser.add_argument("--real-gold", help="gold labels for the real bank")
    parser.add_argument("--scrub", help="name scrub map for the real bank")
    parser.add_argument("--out", help="results file (no utterance text for real items)")
    parser.add_argument("--passes", type=int, default=1)
    parser.add_argument("--only-real", action="store_true")
    args = parser.parse_args(argv)

    if os.getenv("PHONE_GATE_EVAL_LIVE") != "1":
        print("skipped: set PHONE_GATE_EVAL_LIVE=1 to call the live judge endpoint")
        return 0
    key = (os.getenv("PHONE_JUDGE_API_KEY") or os.getenv("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        print("no PHONE_JUDGE_API_KEY / DEEPSEEK_API_KEY in the environment")
        return 2
    url = (os.getenv("PHONE_JUDGE_URL") or gb.DEEPSEEK_URL).strip()
    model = (os.getenv("PHONE_GATE_JUDGE_MODEL") or gate_judge.GATE_JUDGE_DEFAULT_MODEL).strip()
    config = gb.judge_config(api_key=key, model=model, url=url)

    bank_path = Path(args.bank)
    bank = json.loads(bank_path.read_text(encoding="utf-8"))
    gb.validate_bank(bank)
    synthetic = [] if args.only_real else bank["items"]
    real = []
    if args.real:
        if not (args.real_gold and args.scrub):
            print("--real needs --real-gold and --scrub")
            return 2
        real = real_items(Path(args.real), Path(args.real_gold), Path(args.scrub))

    import httpx  # noqa: PLC0415

    async def _go() -> dict[str, Any]:
        limits = httpx.Limits(max_connections=1, max_keepalive_connections=1)
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), limits=limits) as client:
            # One warm-up call (the worker warms its pool during the ring).
            await gb.evaluate_item(synthetic[0] if synthetic else real[0],
                                   LiveTransport(client, model), config=config)
            passes = []
            for _ in range(max(1, args.passes)):
                syn = await _run(synthetic, client, config)
                rea = await _run(real, client, config)
                passes.append((syn, rea))
            return {"passes": passes}

    gate_judge._reset_for_tests()  # noqa: SLF001
    outcome = asyncio.run(_go())
    passes = outcome["passes"]
    (syn_results, syn_transports), (real_results, real_transports) = passes[0]
    for transports, results in ((syn_transports, syn_results), (real_transports, real_results)):
        for transport, result in zip(transports, results):
            if transport.records:
                result.latency_ms = transport.records[0].get("latency_ms")

    report: dict[str, Any] = {
        "prompt_version": gate_judge.PROMPT_VERSION, "model": model,
        "run_date": date.today().isoformat(), "passes": len(passes),
    }
    if synthetic:
        summary = gb.summarize(syn_results)
        report["synthetic"] = {"summary": summary, "gate_failures": gb.gate_failures(summary)}
    if real:
        summary = gb.summarize(real_results)
        report["real"] = {
            "summary": summary, "gate_failures": gb.gate_failures(summary),
            "items": [_real_row(r) for r in real_results],
        }

    latency_records = []
    stability: dict[str, set] = {}
    for syn, rea in passes:
        for results, transports in ((syn[0], syn[1]), (rea[0], rea[1])):
            for result, transport in zip(results, transports):
                stability.setdefault(result.id, set()).add(result.judge_intent)
                for rec in transport.records:
                    latency_records.append((result.phase, rec["status"], rec.get("latency_ms")))
    report["latency"] = gb.latency_by_phase(latency_records)
    report["unstable_items"] = sorted(k for k, v in stability.items() if len(v) > 1)

    if args.record and synthetic:
        for item, transport in zip(bank["items"], syn_transports):
            item["recorded"] = transport.records
        bank["prompt_version"] = gate_judge.PROMPT_VERSION
        bank["recorded_model"] = model
        bank["recorded_at"] = date.today().isoformat()
        _write_bank(bank_path, bank)
        report["recorded_into"] = str(bank_path)

    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=1, default=list), encoding="utf-8")
    _print_report(report)
    return 0


def _write_bank(path: Path, bank: dict[str, Any]) -> None:
    """One item per line, so a re-record is a reviewable diff."""
    head = {k: v for k, v in bank.items() if k != "items"}
    lines = ["{"]
    for k, v in head.items():
        lines.append(f" {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},")
    lines.append(' "items": [')
    items = bank["items"]
    for i, item in enumerate(items):
        sep = "," if i + 1 < len(items) else ""
        lines.append("  " + json.dumps(item, ensure_ascii=False) + sep)
    lines.append(" ]")
    lines.append("}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _print_report(report: dict[str, Any]) -> None:
    for name in ("synthetic", "real"):
        part = report.get(name)
        if not part:
            continue
        s = part["summary"]
        print(f"== {name}: n={s['n']} correct={s['correct']} "
              f"false_grants={len(s['false_grants'])} legacy_false_grants={len(s['legacy_false_grants'])} "
              f"grants {s['true_grants']}/{s['gold_grants']} (legacy {s['legacy_true_grants']}) "
              f"machine_on_human={len(s['machine_on_human'])} "
              f"valid_json={s['judge_valid_json']}/{s['judge_calls_completed']} "
              f"timeouts={s['judge_timeouts']}")
        print(f"   gate_failures={part['gate_failures']}")
        print(f"   by_phase={s['by_phase']}")
        print(f"   wrong={s['wrong']}")
    print("latency:", json.dumps(report["latency"]))
    print("unstable:", report["unstable_items"])


if __name__ == "__main__":
    raise SystemExit(main())
