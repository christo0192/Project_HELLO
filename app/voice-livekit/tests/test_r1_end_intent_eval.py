"""``tools/r1_end_intent_eval.py``: the owner's offline accuracy eval of the end-intent classifier.

It needs a real DeepSeek key for the model run, so here it is exercised offline (the lexical
baseline), with a fake client, and on hand-made results.
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parents[1]
for path in (HERE, HERE / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import r1_end_intent_eval as ev  # noqa: E402

try:
    from livekit.agents import llm as _llm  # noqa: F401
except ImportError:  # pragma: no cover - bare CI
    _llm = None


class FixtureTests(unittest.TestCase):
    def test_the_labelled_set_is_well_formed(self):
        rows = ev.load_rows()
        self.assertGreater(len(rows), 600)
        self.assertEqual(ev.validate_rows(rows), [])
        labels = {row["label"] for row in rows}
        self.assertEqual(labels, {"end", "maybe", "no"})
        self.assertEqual({row["context"] for row in rows}, {"roleplay", "after_aside"})
        # The owner's own end requests and real in-role turns are in it.
        sources = {row["source"].split(":")[0] for row in rows}
        self.assertTrue({"owner", "sweep", "corpus", "tests", "review"} <= sources, sources)

    def test_a_broken_row_is_reported(self):
        rows = [
            {"id": "a", "text": "x", "label": "end", "also_ok": [], "context": "roleplay"},
            {"id": "a", "text": "y", "label": "stop", "also_ok": ["no"], "context": "roleplay"},
            {"id": "b", "text": 3, "label": "no", "also_ok": ["x"], "context": "lobby"},
        ]
        problems = ev.validate_rows(rows)
        self.assertEqual(len(problems), 5, problems)


class DecisionTests(unittest.TestCase):
    def row(self, text, context="roleplay"):
        return {"text": text, "context": context}

    def test_the_worker_asks_only_where_it_would(self):
        self.assertTrue(ev.would_ask(self.row("Kindly end the interview.")))
        self.assertFalse(ev.would_ask(self.row("End the interview.")))  # lexical fast path
        self.assertFalse(ev.would_ask(self.row("What's your budget?")))  # prefilter miss
        self.assertFalse(ev.would_ask(self.row("yes", "after_aside")))  # the bare-yes rule
        self.assertTrue(ev.would_ask(self.row("Okay, wrap it up.", "after_aside")))

    def test_the_decision_is_the_workers_rails(self):
        self.assertEqual(ev.decide(self.row("Kindly end the interview."), "end"), "end")
        self.assertEqual(ev.decide(self.row("Let's call it a day."), "end"), "maybe")
        self.assertEqual(ev.decide(self.row("End the interview."), None), "end")
        self.assertEqual(ev.decide(self.row("haan ji", "after_aside"), None), "end")

    def test_a_maybe_is_an_exit_while_the_question_is_open(self):
        # Reviewed fix: the worker exits on any end request while L-ASIDE-END is open.
        self.assertEqual(ev.decide(self.row("Okay, wrap it up.", "after_aside"), "maybe"), "end")
        self.assertEqual(ev.decide(self.row("No, carry on.", "after_aside"), "maybe"), "no")
        self.assertEqual(ev.decide(self.row("So the EMI is fine?", "after_aside"), "no"), "no")

    def test_after_a_closed_question_only_the_candidates_words_exit(self):
        def later(text, verdict):
            return ev.decide(self.row(text), verdict, after_closed_aside=True)

        talk = "At the end of the day, the course pays for itself."
        self.assertEqual(later(talk, "maybe"), "no")  # a model-only maybe is dropped
        self.assertEqual(later("Okay, never mind, can you disconnect the call?", None), "end")
        self.assertEqual(later("Kindly end the interview.", "end"), "end")
        self.assertEqual(later("Once you finish the course you'll clear the interview.", "end"),
                         "no")

    def test_the_learners_own_interview_talk_is_in_the_labelled_set(self):
        rows = [row for row in ev.load_rows() if row["source"] == "review:learner-interview"]
        self.assertGreaterEqual(len(rows), 50)
        self.assertTrue(all(row["label"] == "no" and ev.would_ask(row) for row in rows))
        # Even a model that says "end" to every one of them ends nothing, in either mode.
        for row in rows:
            with self.subTest(text=row["text"]):
                self.assertNotEqual(ev.decide(row, "end"), "end")
                self.assertNotEqual(ev.decide(row, "maybe", after_closed_aside=True), "end")

    def test_the_summary_counts_critical_false_ends(self):
        results = [
            {"text": "a", "label": "end", "also_ok": [], "decision": "end", "asked": True,
             "outcome": "end", "seconds": 0.5},
            {"text": "b", "label": "no", "also_ok": [], "decision": "end", "asked": True,
             "outcome": "end", "seconds": 0.9},
            {"text": "c", "label": "no", "also_ok": ["maybe"], "decision": "maybe",
             "asked": True, "outcome": "maybe", "seconds": 1.1},
            {"text": "d", "label": "no", "also_ok": [], "decision": "maybe", "asked": True,
             "outcome": "timeout", "seconds": 1.3},
            {"text": "e", "label": "maybe", "also_ok": [], "decision": "no", "asked": False,
             "seconds": None},
        ]
        summary = ev.summarise(results)
        self.assertEqual(summary["rows"], 5)
        self.assertEqual(summary["accuracy"], 0.4)
        self.assertEqual(summary["critical_false_end"], 1)
        self.assertEqual(summary["critical_false_end_texts"], ["b"])
        self.assertEqual(summary["false_aside"], 1)
        self.assertEqual(summary["missed"], 1)
        self.assertEqual(summary["timeouts"], 1)
        self.assertEqual(summary["confusion"]["no->end"], 1)
        # Without a post-aside decision a row counts with its own; "b" is critical there too.
        self.assertEqual(summary["critical_false_end_after_closed_aside"], 1)
        results[3]["decision_after_closed_aside"] = "end"  # "d": a lexical second request
        summary = ev.summarise(results)
        self.assertEqual(summary["critical_false_end_after_closed_aside_texts"], ["b", "d"])
        self.assertEqual(
            (summary["call_p50_sec"], summary["call_p95_sec"], summary["call_max_sec"]),
            (0.9, 1.3, 1.3),
        )


class RunTests(unittest.TestCase):
    def test_the_offline_baseline_runs_without_a_key(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ev.main(["--offline", "--limit", "50"])
        self.assertEqual(code, 0)
        summary = json.loads(out.getvalue())
        for key in ("rows", "accuracy", "confusion", "critical_false_end", "missed",
                    "critical_false_end_after_closed_aside", "call_p95_sec", "prefilter_rate",
                    "mode"):
            self.assertIn(key, summary)
        self.assertEqual((summary["rows"], summary["mode"]), (50, "offline"))
        self.assertEqual(summary["critical_false_end"], 0)
        self.assertLessEqual(summary["prefilter_rate"]["r1_advisor_corpus"]["share"], 0.08)

    def test_corpus_rows_are_new_no_rows(self):
        rows = ev.corpus_rows([], limit=5)
        self.assertEqual(len(rows), 5)
        self.assertTrue(all(row["label"] == "no" for row in rows))
        self.assertEqual(ev.validate_rows(rows), [])

    @unittest.skipUnless(_llm is not None, "livekit-agents is not installed (bare CI)")
    def test_a_model_answer_is_parsed_and_timed(self):
        class Stream:
            def __init__(self, text):
                self.text = text

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def __aiter__(self):
                async def chunks():
                    yield SimpleNamespace(delta=SimpleNamespace(content=self.text))
                return chunks()

        class Client:
            def __init__(self, text):
                self.text = text

            def chat(self, *, chat_ctx):
                return Stream(self.text)

        row = {"text": "Kindly end the interview.", "context": "roleplay"}
        answer = asyncio.run(ev._classify(Client('{"intent": "end"}'), row, 1, 1.0))
        self.assertEqual((answer["verdict"], answer["outcome"]), ("end", "end"))
        self.assertGreaterEqual(answer["seconds"], 0.0)
        bad = asyncio.run(ev._classify(Client("no idea"), row, 2, 1.0))
        self.assertEqual((bad["verdict"], bad["outcome"]), (None, "parse_failed"))


if __name__ == "__main__":
    unittest.main()
