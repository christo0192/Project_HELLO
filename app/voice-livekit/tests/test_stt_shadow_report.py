"""M015 PR-1: tools/stt_shadow_report.py - saved fly logs -> go/no-go metrics.

Synthetic log lines only (both `fly logs` forms), with exact expected numbers.
"""

from __future__ import annotations

import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest

_TOOLS = pathlib.Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(_TOOLS))
import stt_shadow_report as rep  # noqa: E402

CID_A = "aaaaaaaa-1111-4111-8111-111111111111"
CID_B = "bbbbbbbb-2222-4222-8222-222222222222"


def row(cid, cat, **meta):
    d = {"timestamp": "2026-10-09T10:00:00.000Z", "level": "info", "component": "phone_stt_shadow",
         "event": "unknown_event", "correlationId": cid, "error_type": "phone_stt_shadow",
         "error_category": cat}
    d.update(meta)
    return d


def seg(cid, k, klass, pmax, *, p1=None, p3=None, f=None, lw=0, rf=None, rw=0, dur=2.0):
    out = []
    if p1 is not None:
        out.append(row(cid, "seg_partial_lead", turn_index=k, duration_sec=p1))
    if p3 is not None:
        out.append(row(cid, "seg_three_word", turn_index=k, duration_sec=p3))
    if f is not None:
        out.append(row(cid, "seg_legacy_final", turn_index=k, duration_sec=f, option_count=lw))
    if rf is not None:
        out.append(row(cid, "seg_rt_final", turn_index=k, duration_sec=rf, option_count=rw))
    out.append(row(cid, "seg_summary", turn_index=k, schema=klass, option_count=pmax,
                   phase="settled", duration_sec=dur))
    return out


def call_a():
    rows = [row(CID_A, "armed"), row(CID_A, "socket_open", duration_sec=0.3),
            row(CID_A, "session_begin", duration_sec=0.1)]
    rows += seg(CID_A, 0, "both", 3, p1=0.4, p3=1.3, f=3.0, lw=5, rf=2.5, rw=5)
    rows += seg(CID_A, 1, "both", 3, p1=0.5, p3=1.0, f=2.0, lw=4, rf=2.1, rw=4)
    rows += seg(CID_A, 2, "noise_partial", 1, p1=0.3)
    rows += seg(CID_A, 3, "silent", 0)
    rows += seg(CID_A, 4, "rt_missed", 0, f=1.5, lw=2)
    rows += [row(CID_A, "session_end", duration_sec=60.5)]
    for name, value in (("segments", 5), ("silence_partials", 2), ("frames_dropped", 0),
                        ("unrecovered_death", 0)):
        rows.append(row(CID_A, "call_summary", schema=name, option_count=value))
    return rows


def call_b():
    rows = [row(CID_B, "armed"), row(CID_B, "socket_open", duration_sec=0.5)]
    rows += seg(CID_B, 0, "both", 3, p1=0.7, p3=1.2, f=2.2, lw=2, rf=2.0, rw=3)
    rows += seg(CID_B, 1, "both", 2, p1=0.5, f=1.8, lw=3, rf=1.9, rw=6)
    rows += [row(CID_B, "socket_closed", schema="close_1011", phase="unexpected", duration_sec=30)]
    return rows          # no call_summary: forced exit; the death is derived


def plain(r):
    return f"2026-10-09T10:00:00Z app[3d8e] bom [info]{json.dumps(r)}"


def fly_json(r):
    return json.dumps({"timestamp": "2026-10-09T10:00:00Z", "level": "info",
                       "message": json.dumps(r), "instance": "3d8e"})


NOISE = [
    "2026-10-09T10:00:00Z app[3d8e] bom [info]plain text with no json",
    plain({"component": "agent", "error_type": "voice_phone_vad_event", "correlationId": CID_A}),
    "2026-10-09T10:00:00Z app[3d8e] bom [info]{not valid json",
    "",
]


def write(lines):
    f = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8")
    f.write("\n".join(lines) + "\n")
    f.close()
    return f.name


def run(args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = rep.main(args)
    return code, out.getvalue(), err.getvalue()


class TestReport(unittest.TestCase):
    def _files(self, fmt):
        rows = call_a() + NOISE + call_b()
        return write([fmt(r) if isinstance(r, dict) else r for r in rows])

    def test_exact_metrics_in_both_log_formats(self):
        for fmt in (plain, fly_json):
            path = self._files(fmt)
            code, out, _ = run([path, "--json", "--min-calls", "2", "--min-segments", "6"])
            self.assertEqual(code, 0)
            rep_ = json.loads(out)
            c = rep_["criteria"]
            self.assertEqual(rep_["calls"], 2)
            self.assertEqual(rep_["non_silent_segments"], 6)
            self.assertAlmostEqual(c["G1"]["value"], 0.5)
            self.assertAlmostEqual(c["G2"]["value"], 1.0)
            self.assertAlmostEqual(c["G3"]["value"], 1 / 6)
            self.assertAlmostEqual(c["G4"]["value"], 1 / 6)
            self.assertAlmostEqual(c["G5"]["value"], 0.75)
            self.assertEqual(c["G6"]["value"], 1)
            self.assertEqual({k: v["pass"] for k, v in c.items()},
                             {"G1": True, "G2": True, "G3": False, "G4": False,
                              "G5": False, "G6": False})
            self.assertEqual(rep_["verdict"], "NO-GO (G3, G4, G5, G6)")
            self.assertEqual(rep_["also"]["billed_audio_sec"], 60.5)
            self.assertEqual(rep_["also"]["silence_partials_per_call"], 1.0)
            self.assertIn("closed:close_1011:unexpected", rep_["also"]["errors"])

    def test_per_call_values(self):
        code, out, _ = run([self._files(plain), "--json", "--min-calls", "2", "--min-segments", "6"])
        per = {m["cid"]: m for m in json.loads(out)["per_call"]}
        a, b = per["aaaaaaaa"], per["bbbbbbbb"]
        self.assertEqual((a["segments"], a["non_silent"], a["noise"], a["false3"]), (5, 4, 1, 0))
        self.assertAlmostEqual(a["g1_median"], 0.4)
        self.assertAlmostEqual(a["g2_median"], 1.35)
        self.assertEqual((a["agree"], a["agree_n"], a["deaths"]), (2, 2, 0))
        self.assertEqual((b["false3"], b["agree"], b["agree_n"], b["deaths"]), (1, 1, 2, 1))

    def test_a_clean_dataset_is_go(self):
        rows = []
        for i in range(5):
            cid = f"cccccccc-0000-4000-8000-00000000000{i}"
            rows.append(row(cid, "armed"))
            for k in range(20):
                rows += seg(cid, k, "both", 4, p1=0.4, p3=0.9, f=2.2, lw=6, rf=2.3, rw=6)
            rows.append(row(cid, "call_summary", schema="unrecovered_death", option_count=0))
        code, out, _ = run([write([plain(r) for r in rows]), "--json"])
        report = json.loads(out)
        self.assertEqual(report["verdict"], "GO")
        self.assertEqual(report["non_silent_segments"], 100)

    def test_insufficient_data_exits_zero(self):
        code, out, _ = run([self._files(plain)])
        self.assertEqual(code, 0)
        self.assertIn("VERDICT: INSUFFICIENT DATA", out)
        self.assertIn("G6 unrecovered socket deaths: 1", out)

    def test_no_shadow_lines_exit_2(self):
        code, out, err = run([write(NOISE)])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        code, _, _ = run(["/nonexistent/nowhere.log"])
        self.assertEqual(code, 2)

    def test_output_has_only_short_ids_labels_and_numbers(self):
        path = self._files(plain)
        for extra in ([], ["--json"]):
            _, out, _ = run([path, "--min-calls", "2", "--min-segments", "6"] + extra)
            self.assertNotIn(CID_A, out)
            self.assertNotIn(CID_B, out)
            self.assertIn("aaaaaaaa", out)
            self.assertNotIn("2026-10-09", out)

    def test_script_is_stdlib_only_and_reads_no_env(self):
        import ast
        tree = ast.parse((_TOOLS / "stt_shadow_report.py").read_text(encoding="utf-8"))
        stdlib = {"argparse", "json", "statistics", "sys", "collections", "typing", "__future__"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.assertLessEqual({a.name.split(".")[0] for a in node.names}, stdlib)
            elif isinstance(node, ast.ImportFrom):
                self.assertIn((node.module or "").split(".")[0], stdlib)
            elif isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, ("environ", "getenv"))

    def test_derived_death_from_socket_lines_only_when_no_summary(self):
        rows = [row(CID_A, "armed"), row(CID_A, "send_stalled", duration_sec=2.0)]
        report = rep.aggregate(rep.build_calls(rows), 1, 0)
        self.assertEqual(report["criteria"]["G6"]["value"], 1)
        rows.append(row(CID_A, "call_summary", schema="unrecovered_death", option_count=0))
        report = rep.aggregate(rep.build_calls(rows), 1, 0)
        self.assertEqual(report["criteria"]["G6"]["value"], 0)

    def test_agreement_rule(self):
        self.assertTrue(rep.agrees(2, 3))       # +-1 word
        self.assertTrue(rep.agrees(10, 12))     # 20 %
        self.assertFalse(rep.agrees(10, 13))
        self.assertFalse(rep.agrees(3, 6))


if __name__ == "__main__":
    unittest.main()
