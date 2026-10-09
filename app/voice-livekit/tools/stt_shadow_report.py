#!/usr/bin/env python3
"""Summarise `phone_stt_shadow` log lines into the M015 PR-2 go/no-go metrics.

Offline and stdlib-only: it never reads the environment, never touches the
network and is never imported by the worker (it is not in the image).

Input: text saved from

    fly logs -a project-hello-phone-voice --no-tail | grep phone_stt_shadow > shadow-YYYYMMDD.log

(filter on save: the raw dump holds every worker line; only the filtered file or
this report's output belongs in .gsd/milestones/M015/)

(run it promptly after the calls; Fly's log buffer is short), either the plain
form (``<ts> app[<id>] <region> [info]{json}``) or the ``--json`` form (a JSON
object whose ``message`` holds the inner JSON line and ``instance`` the machine).

Calls are told apart WITHOUT the correlation id (the phone lane never sets one,
so it is null on every line): per Fly machine, a new call starts at each
``config`` line (or at a second ``armed``). If a log has neither machine ids nor
correlation ids, everything is one call and the report says so.

Usage:
    python app/voice-livekit/tools/stt_shadow_report.py LOG [LOG ...]
        [--json] [--min-calls 5] [--min-segments 100]

Exit code 0 normally, 2 when there are no shadow lines (or a file cannot be read).

The shadow logs NUMBERS only (never text), so neither does this report. Times are
offsets from a segment's local VAD start; the "how much earlier" differences are
computed here. Thresholds are research section 5, "Go criteria for PR-2":

    G1 median partial lead (first partial word after VAD start) <= 0.6 s
    G2 median 3rd-word saving (legacy final time - 3rd-word time) >= 0.8 s
    G3 noise partials / non-silent segments <= 5 %
    G4 false 3-word (3rd partial word but legacy final < 3 words) / non-silent <= 5 %
    G5 final word counts agree (+-20 %, research section 5) on >= 90 % of segments
       (the looser "+-1 word or +-20 %" rate is shown next to it, informational only)
    G6 unrecovered socket deaths = 0

GO needs G1-G6 all passing AND at least --min-calls calls with at least
--min-segments non-silent segments; otherwise NO-GO (failing criteria named) or
INSUFFICIENT DATA.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from typing import Any, Iterable, Optional

G1_MAX = 0.6
G2_MIN = 0.8
G3_MAX = 0.05
G4_MAX = 0.05
G5_MIN = 0.90
AGREE_REL = 0.20
LAG_WARN_MS = 1000


# ── parsing ──────────────────────────────────────────────────────────────────

_MACHINE_RE = re.compile(r"\bapp\[([A-Za-z0-9]{4,32})\]")
_MACHINE_ID_RE = re.compile(r"^[A-Za-z0-9]{4,32}$")


def parse_line(line: str) -> Optional[dict]:
    """The shadow log object in `line` (plus ``_machine`` when known), or None
    (not a shadow line / malformed)."""
    start = line.find("{")
    if start < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(line[start:])
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    machine: Optional[str] = None
    m = _MACHINE_RE.search(line[:start])
    if m:
        machine = m.group(1)
    inst = obj.get("instance")
    if machine is None and isinstance(inst, str) and _MACHINE_ID_RE.match(inst):
        machine = inst
    msg = obj.get("message")
    if isinstance(msg, str) and "{" in msg:
        try:
            inner, _ = json.JSONDecoder().raw_decode(msg[msg.find("{"):])
        except ValueError:
            return None
        if isinstance(inner, dict):
            obj = inner
    if obj.get("error_type") != "phone_stt_shadow":
        return None
    if machine is not None:
        obj["_machine"] = machine
    return obj


def read_lines(paths: Iterable[str]) -> tuple[list[dict], int, int]:
    rows: list[dict] = []
    skipped = 0
    total = 0
    for path in paths:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                total += 1
                row = parse_line(line)
                if row is None:
                    skipped += 1
                else:
                    rows.append(row)
    return rows, skipped, total


# ── reconstruction ───────────────────────────────────────────────────────────

class Seg:
    __slots__ = ("p1", "p3", "f", "lw", "rf", "rw", "klass", "pmax", "phase")

    def __init__(self) -> None:
        self.p1 = self.p3 = self.f = self.rf = None
        self.lw = self.rw = self.pmax = 0
        self.klass = None
        self.phase = None

    @property
    def nonsilent(self) -> bool:
        return self.klass is not None and self.klass != "silent"


class Call:
    def __init__(self, cid: str, label: Optional[str] = None) -> None:
        self.cid = cid
        self.label = label if label is not None else cid[:8]
        self.armed = False
        self.ended = False
        self.segs: dict[int, Seg] = {}
        self.summary: dict[str, int] = {}
        self.connect_sec: Optional[float] = None
        self.begin_sec: Optional[float] = None
        self.billed: Optional[float] = None
        self.derived_death = False
        self.errors: Counter = Counter()

    def seg(self, k: int) -> Seg:
        return self.segs.setdefault(k, Seg())

    @property
    def deaths(self) -> int:
        # The summary is written when the call ends, BEFORE the graceful close,
        # so a death logged after it (e.g. a 1011 on close) only shows up in the
        # derived value: take the larger of the two.
        return max(int(self.summary.get("unrecovered_death", 0)),
                   1 if self.derived_death else 0)


def _num(row: dict, key: str) -> Optional[float]:
    v = row.get(key)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def build_calls(rows: list[dict]) -> dict[str, Call]:
    calls: dict[str, Call] = {}
    current: dict[str, Call] = {}     # machine -> its current call (null-cid lines)
    seq: Counter = Counter()
    for row in rows:
        cid = row.get("correlationId")
        cat = row.get("error_category")
        k = row.get("turn_index")
        if isinstance(cid, str) and cid:
            call = calls.setdefault(cid, Call(cid))
        else:
            machine = row.get("_machine") or "unknown"
            call = current.get(machine)
            if (call is None or cat == "config"
                    or (cat == "armed" and (call.armed or call.ended))):
                seq[machine] += 1
                call = Call(f"m:{machine}#{seq[machine]}", f"{machine[:8]}#{seq[machine]}")
                calls[call.cid] = call
                current[machine] = call
        if cat == "armed":
            call.armed = True
        elif cat == "closed_unarmed":
            call.ended = True
        elif cat == "seg_partial_lead" and isinstance(k, int):
            call.seg(k).p1 = _num(row, "duration_sec")
        elif cat == "seg_three_word" and isinstance(k, int):
            call.seg(k).p3 = _num(row, "duration_sec")
        elif cat == "seg_legacy_final" and isinstance(k, int):
            s = call.seg(k)
            s.f = _num(row, "duration_sec")
            s.lw = int(_num(row, "option_count") or 0)
        elif cat == "seg_rt_final" and isinstance(k, int):
            s = call.seg(k)
            s.rf = _num(row, "duration_sec")
            s.rw = int(_num(row, "option_count") or 0)
        elif cat == "seg_summary" and isinstance(k, int):
            s = call.seg(k)
            s.klass = row.get("schema")
            s.pmax = int(_num(row, "option_count") or 0)
            s.phase = row.get("phase")
        elif cat == "call_summary":
            call.ended = True
            name = row.get("schema")
            if isinstance(name, str):
                call.summary[name] = int(_num(row, "option_count") or 0)
        elif cat == "socket_open":
            call.connect_sec = _num(row, "duration_sec")
        elif cat == "session_begin":
            call.begin_sec = _num(row, "duration_sec")
        elif cat == "session_end":
            call.billed = _num(row, "duration_sec")
        elif cat == "connect_failed":
            call.derived_death = True
            call.errors["connect_failed:" + str(row.get("schema"))] += 1
        elif cat == "socket_error":
            call.errors["error:" + str(row.get("schema"))] += 1
            if row.get("phase") == "fatal":
                call.derived_death = True
        elif cat == "socket_closed":
            call.errors["closed:" + str(row.get("schema")) + ":" + str(row.get("phase"))] += 1
            if row.get("phase") == "unexpected":
                call.derived_death = True
        elif cat in ("send_stalled", "shadow_failed"):
            call.errors[cat] += 1
            call.derived_death = True
    return calls


# ── metrics ──────────────────────────────────────────────────────────────────

def percentile(values: list[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round(q * (len(ordered) - 1)))))
    return ordered[idx]


def median(values: list[float]) -> Optional[float]:
    return statistics.median(values) if values else None


def agrees(lw: int, rw: int) -> bool:
    """Research section 5: word counts within +-20 % (G5, gated)."""
    return abs(rw - lw) / max(lw, rw) <= AGREE_REL


def agrees_loose(lw: int, rw: int) -> bool:
    """Informational only: also accept a one-word difference."""
    return abs(rw - lw) <= 1 or agrees(lw, rw)


def call_metrics(call: Call) -> dict[str, Any]:
    segs = list(call.segs.values())
    nonsilent = [s for s in segs if s.nonsilent]
    leads = [s.p1 for s in segs if s.p1 is not None]
    savings = [s.f - s.p3 for s in segs if s.f is not None and s.p3 is not None]
    noise = sum(1 for s in nonsilent if s.klass == "noise_partial")
    false3 = sum(1 for s in nonsilent if s.p3 is not None and s.lw < 3)
    pairs = [s for s in segs if s.lw >= 1 and s.rf is not None]
    agree = sum(1 for s in pairs if agrees(s.lw, s.rw))
    agree_loose = sum(1 for s in pairs if agrees_loose(s.lw, s.rw))
    return {
        "cid": call.label,
        "segments": len(segs),
        "non_silent": len(nonsilent),
        "g1_median": median(leads),
        "g2_median": median(savings),
        "noise": noise,
        "false3": false3,
        "agree": agree,
        "agree_loose": agree_loose,
        "agree_n": len(pairs),
        "rt_missed": sum(1 for s in segs if s.klass == "rt_missed"),
        "deaths": call.deaths,
        "frames_dropped": call.summary.get("frames_dropped", 0),
        "queue_lag_max_ms": call.summary.get("queue_lag_max_ms", 0),
        "silence_partials": call.summary.get("silence_partials", 0),
        "billed_audio_sec": call.billed,
        "_leads": leads, "_savings": savings,
    }


def _ratio(num: int, den: int) -> Optional[float]:
    return num / den if den else None


def aggregate(calls: dict[str, Call], min_calls: int, min_segments: int) -> dict[str, Any]:
    used = [c for c in calls.values() if c.armed or c.segs]
    per_call = [call_metrics(c) for c in used]
    leads = [v for m in per_call for v in m["_leads"]]
    savings = [v for m in per_call for v in m["_savings"]]
    nonsilent = sum(m["non_silent"] for m in per_call)
    g1 = median(leads)
    g2 = median(savings)
    g3 = _ratio(sum(m["noise"] for m in per_call), nonsilent)
    g4 = _ratio(sum(m["false3"] for m in per_call), nonsilent)
    g5 = _ratio(sum(m["agree"] for m in per_call), sum(m["agree_n"] for m in per_call))
    g6 = sum(m["deaths"] for m in per_call)

    def ok(value: Optional[float], test) -> bool:
        return value is not None and test(value)

    criteria = {
        "G1": {"name": "median partial lead (s)", "value": g1, "threshold": f"<= {G1_MAX}",
               "pass": ok(g1, lambda v: v <= G1_MAX), "p90": percentile(leads, 0.9)},
        "G2": {"name": "median 3rd-word saving (s)", "value": g2, "threshold": f">= {G2_MIN}",
               "pass": ok(g2, lambda v: v >= G2_MIN), "p90": percentile(savings, 0.9)},
        "G3": {"name": "noise partials / non-silent", "value": g3, "threshold": f"<= {G3_MAX}",
               "pass": ok(g3, lambda v: v <= G3_MAX)},
        "G4": {"name": "false 3-word / non-silent", "value": g4, "threshold": f"<= {G4_MAX}",
               "pass": ok(g4, lambda v: v <= G4_MAX)},
        "G5": {"name": "final word agreement", "value": g5, "threshold": f">= {G5_MIN}",
               "pass": ok(g5, lambda v: v >= G5_MIN)},
        "G6": {"name": "unrecovered socket deaths", "value": g6, "threshold": "== 0",
               "pass": g6 == 0},
    }
    failing = [k for k, v in criteria.items() if not v["pass"]]
    sufficient = len(used) >= min_calls and nonsilent >= min_segments
    if not sufficient:
        verdict = "INSUFFICIENT DATA"
    elif failing:
        verdict = "NO-GO (" + ", ".join(failing) + ")"
    else:
        verdict = "GO"
    errors: Counter = Counter()
    for c in used:
        errors.update(c.errors)
    connect = [c.connect_sec for c in used if c.connect_sec is not None]
    begin = [c.begin_sec for c in used if c.begin_sec is not None]
    for m in per_call:
        m.pop("_leads", None)
        m.pop("_savings", None)
    warnings = []
    if any(c.cid.startswith("m:unknown#") for c in used):
        warnings.append("some lines carry neither a correlation id nor a machine id: "
                        "they are grouped as one call per `config` line, which may merge "
                        "concurrent calls; save the logs in the plain or --json form")
    lag = max([m["queue_lag_max_ms"] for m in per_call] or [0])
    if lag > LAG_WARN_MS:
        warnings.append(f"the shadow fell up to {lag} ms behind real time in at least one call "
                        "(queue lag): its latency metrics (G1, G2) are inflated by that lag")
    return {
        "warnings": warnings,
        "verdict": verdict,
        "calls": len(used),
        "non_silent_segments": nonsilent,
        "min_calls": min_calls,
        "min_segments": min_segments,
        "criteria": criteria,
        "also": {
            "silence_partials_per_call": _ratio(sum(m["silence_partials"] for m in per_call), len(used)),
            "g5_loose_pm1_word": _ratio(sum(m["agree_loose"] for m in per_call),
                                        sum(m["agree_n"] for m in per_call)),
            "rt_missed_rate": _ratio(sum(m["rt_missed"] for m in per_call), nonsilent),
            "frames_dropped": sum(m["frames_dropped"] for m in per_call),
            "queue_lag_max_ms": max([m["queue_lag_max_ms"] for m in per_call] or [0]),
            "billed_audio_sec": sum(m["billed_audio_sec"] or 0 for m in per_call),
            "connect_sec_median": median(connect),
            "begin_sec_median": median(begin),
            "errors": dict(sorted(errors.items())),
        },
        "per_call": per_call,
    }


# ── output ───────────────────────────────────────────────────────────────────

def _fmt(value: Any, kind: str = "s") -> str:
    if value is None:
        return "n/a"
    if kind == "pct":
        return f"{value * 100:.1f}%"
    if kind == "int":
        return str(int(value))
    return f"{value:.2f}"


def render(report: dict[str, Any], skipped: int, total: int) -> str:
    out: list[str] = []
    out.append(f"STT shadow report: {report['calls']} calls, "
               f"{report['non_silent_segments']} non-silent segments "
               f"({skipped} of {total} input lines were not shadow lines)")
    out.append("")
    head = ("call", "segs", "nonsil", "G1 med", "G2 med", "noise", "false3w", "agree",
            "deaths", "drops", "billed_s")
    rows = [head]
    for m in report["per_call"]:
        rows.append((
            m["cid"], str(m["segments"]), str(m["non_silent"]), _fmt(m["g1_median"]),
            _fmt(m["g2_median"]),
            _fmt(_ratio(m["noise"], m["non_silent"]), "pct"),
            _fmt(_ratio(m["false3"], m["non_silent"]), "pct"),
            _fmt(_ratio(m["agree"], m["agree_n"]), "pct"),
            str(m["deaths"]), str(m["frames_dropped"]), _fmt(m["billed_audio_sec"], "s")))
    widths = [max(len(r[i]) for r in rows) for i in range(len(head))]
    for r in rows:
        out.append("  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip())
    out.append("")
    for key, c in report["criteria"].items():
        kind = "pct" if key in ("G3", "G4", "G5") else ("int" if key == "G6" else "s")
        extra = f"  (p90 {_fmt(c['p90'])})" if c.get("p90") is not None else ""
        out.append(f"{key} {c['name']}: {_fmt(c['value'], kind)}  need {c['threshold']}  "
                   f"{'PASS' if c['pass'] else 'FAIL'}{extra}")
    a = report["also"]
    out.append("")
    out.append("Also (not gated): "
               f"silence partials/call {_fmt(a['silence_partials_per_call'])}, "
               f"G5 with +-1 word allowed {_fmt(a['g5_loose_pm1_word'], 'pct')}, "
               f"rt_missed {_fmt(a['rt_missed_rate'], 'pct')}, "
               f"frames dropped {a['frames_dropped']}, "
               f"max queue lag {a['queue_lag_max_ms']} ms, billed audio {_fmt(a['billed_audio_sec'])} s, "
               f"connect median {_fmt(a['connect_sec_median'])} s, "
               f"begin median {_fmt(a['begin_sec_median'])} s")
    if a["errors"]:
        out.append("Errors/close codes: " + ", ".join(f"{k} x{v}" for k, v in a["errors"].items()))
    for w in report.get("warnings", []):
        out.append("WARNING: " + w)
    out.append("")
    out.append(f"VERDICT: {report['verdict']} "
               f"(needs >= {report['min_calls']} calls and >= {report['min_segments']} "
               f"non-silent segments)")
    return "\n".join(out)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("logs", nargs="+", help="saved `fly logs` file(s)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    ap.add_argument("--min-calls", type=int, default=5)
    ap.add_argument("--min-segments", type=int, default=100)
    args = ap.parse_args(argv)
    try:
        rows, skipped, total = read_lines(args.logs)
    except OSError as exc:
        print(f"cannot read input: {type(exc).__name__}", file=sys.stderr)
        return 2
    if not rows:
        print("no phone_stt_shadow lines found", file=sys.stderr)
        return 2
    report = aggregate(build_calls(rows), args.min_calls, args.min_segments)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render(report, skipped, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
