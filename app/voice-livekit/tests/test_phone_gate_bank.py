"""M013 S01 T11: the gate judge evaluation bank, replayed in CI.

``tests/fixtures/gate_bank_synthetic.json`` holds synthetic reply windows with
the judge responses RECORDED from the live endpoint by
``tests/eval_gate_bank_live.py`` (never hand-written). Each item is replayed
through the real wiring, guards and route tables (``tests/gate_bank.py``); only
the HTTP transport is a recording, and every request it receives must equal
the one recorded.

Pass rules (S01-PLAN T11):

* 0 false grants;
* no more false grants than the legacy regex reader;
* 0 machine verdicts on human items;
* true-grant recall at least the legacy reader's (an LLM that re-asks
  consenting candidates more than the regex is a regression on the owner's
  complaint);
* every recorded response carries the current ``gate_judge.PROMPT_VERSION``:
  a prompt change without re-recording fails here. Re-record with
  ``PHONE_GATE_EVAL_LIVE=1 python tests/eval_gate_bank_live.py --record``.
"""

from __future__ import annotations

import json
import re
import unittest
from unittest import mock

from tests import gate_bank as gb  # installs the SDK stub first

import gate_judge  # noqa: E402

_BANK = gb.load_bank()
_ITEMS = _BANK["items"]
_BY_ID = {item["id"]: item for item in _ITEMS}


def _replay(items=_ITEMS):
    transports: dict[str, gb.RecordedTransport] = {}

    def make(item):
        transports[item["id"]] = gb.RecordedTransport(item)
        return transports[item["id"]]

    return gb.run_items(items, make), transports


_STATE: dict = {}


def _state():
    """The whole bank replayed once, on first use (never at import: an event
    loop made during test discovery can meet another module's patching)."""
    if not _STATE:
        results, transports = _replay()
        _STATE.update(results=results, transports=transports,
                      summary=gb.summarize(results), by_result={r.id: r for r in results})
    return _STATE


class TestBankShape(unittest.TestCase):

    def test_bank_is_large_enough_and_covers_every_family(self):
        self.assertGreaterEqual(len(_ITEMS), gb.MIN_ITEMS)
        families = {item["family"] for item in _ITEMS}
        self.assertEqual(families, set(gb.FAMILIES))
        for family in gb.FAMILIES:
            self.assertGreaterEqual(
                sum(1 for i in _ITEMS if i["family"] == family), 10, family)

    def test_every_gate_phase_is_exercised(self):
        self.assertEqual({i["phase"] for i in _ITEMS}, set(gate_judge.PHASES))

    def test_timing_guards_are_exercised(self):
        notes = " ".join(i.get("note", "") for i in _ITEMS)
        for needle in ("150 ms", "250 ms floor", "recording sentence", "pre_question",
                       "during_question", "no_segment"):
            self.assertIn(needle, notes)

    def test_synthetic_only(self):
        self.assertIs(_BANK["synthetic"], True)
        for item in _ITEMS:
            self.assertIn(item["first_name"], gb.SYNTHETIC_NAMES)
            for u in item["utterances"]:
                self.assertIsNone(re.search(r"\d{5,}", u["text"]), item["id"])

    def test_loader_refuses_an_unsafe_or_malformed_item(self):
        good = json.loads(json.dumps(_ITEMS[0]))
        for mutate, why in (
            (lambda i: i.update(first_name="Rajesh"), "a non-synthetic name"),
            (lambda i: i["utterances"][0].update(text="call me on 98765 43210 or 9876543210"),
             "a phone number"),
            (lambda i: i.update(gold="maybe"), "an unknown gold"),
            (lambda i: i.update(family="real"), "an unknown family"),
        ):
            item = json.loads(json.dumps(good))
            mutate(item)
            with self.subTest(why), self.assertRaises(gb.BankError):
                gb.validate_bank({"synthetic": True, "items": [item]})
        with self.assertRaises(gb.BankError):
            gb.validate_bank({"synthetic": False, "items": [good]})


class TestRecordings(unittest.TestCase):

    def test_every_item_has_a_live_recording(self):
        for item in _ITEMS:
            recorded = item.get("recorded") or []
            self.assertTrue(recorded, item["id"])
            for rec in recorded:
                self.assertEqual(rec.get("source"), "live", item["id"])
                self.assertTrue(str(rec.get("model", "")).startswith("deepseek"), item["id"])

    def test_recorded_prompt_version_is_the_current_one(self):
        stale = sorted({
            rec.get("prompt_version") for item in _ITEMS for rec in item["recorded"]
            if rec.get("prompt_version") != gate_judge.PROMPT_VERSION
        } - {None})
        missing = [i["id"] for i in _ITEMS for r in i["recorded"] if not r.get("prompt_version")]
        self.assertEqual(
            (stale, missing), ([], []),
            "the judge prompt changed: re-record the bank "
            "(PHONE_GATE_EVAL_LIVE=1 python tests/eval_gate_bank_live.py --record)")
        self.assertEqual(_BANK["prompt_version"], gate_judge.PROMPT_VERSION)

    def test_replayed_requests_equal_the_recorded_ones_and_use_them_all(self):
        errors = [e for t in _state()["transports"].values() for e in t.errors]
        self.assertEqual(errors, [])
        self.assertEqual({i: t.unused for i, t in _state()["transports"].items() if t.unused}, {})

    def test_a_prompt_change_is_caught_by_the_replay(self):
        item = _ITEMS[0]
        transport = gb.RecordedTransport(item)
        with mock.patch.object(gate_judge, "_JUDGE_SYSTEM_PROMPT",
                               gate_judge._JUDGE_SYSTEM_PROMPT + " "):  # noqa: SLF001
            gb.run_items([item], lambda _i: transport)
        self.assertTrue(any("system prompt" in e for e in transport.errors))

    def test_a_request_change_is_caught_by_the_replay(self):
        item = json.loads(json.dumps(_ITEMS[0]))
        item["utterances"][0]["text"] += " Thanks."
        transport = gb.RecordedTransport(item)
        gb.run_items([item], lambda _i: transport)
        self.assertTrue(any("differs" in e for e in transport.errors))


class TestPassRules(unittest.TestCase):

    def test_gate_passes(self):
        self.assertEqual(gb.gate_failures(_state()["summary"]), [])

    def test_zero_false_grants(self):
        self.assertEqual(_state()["summary"]["false_grants"], [])

    def test_false_grants_not_above_legacy(self):
        self.assertLessEqual(len(_state()["summary"]["false_grants"]), len(_state()["summary"]["legacy_false_grants"]))

    def test_zero_machine_verdicts_on_human_items(self):
        self.assertEqual(_state()["summary"]["machine_on_human"], [])

    def test_true_grant_recall_not_below_legacy(self):
        self.assertGreaterEqual(_state()["summary"]["true_grants"], _state()["summary"]["legacy_true_grants"])

    def test_valid_json_rate(self):
        done = _state()["summary"]["judge_calls_completed"]
        self.assertGreater(done, 0)
        self.assertGreaterEqual(_state()["summary"]["judge_valid_json"] / done, 0.995)

    def test_a_question_at_qna_close_is_never_closed_on(self):
        self.assertEqual(_state()["summary"]["qna_declines_on_questions"], [])

    def test_an_answer_after_consent_is_never_a_revocation(self):
        self.assertEqual(_state()["summary"]["post_consent_revocations_on_answers"], [])


class TestTheGuardsAreWhatHoldsTheLine(unittest.TestCase):
    """Mutation: the replay runs the real deterministic guards. Switch them
    off and the recorded judge grants on speech that may not consent."""

    # A click; a yes before the recording sentence was heard.
    _GUARD_ITEMS = tuple(
        next(i["id"] for i in _ITEMS if i.get("note") == note)
        for note in ("click: 150 ms of speech",
                     "started before the recording sentence was heard"))

    def test_the_guard_items_are_judged_grants_and_held_by_the_guards(self):
        for iid in self._GUARD_ITEMS:
            result = _state()["by_result"][iid]
            self.assertEqual(result.judge_intent, gate_judge.INTENT_CONSENT_GRANTED, iid)
            self.assertEqual(result.outcome, "reask", iid)
            self.assertIsNotNone(result.guard_rejected, iid)

    def test_without_the_guards_the_same_recordings_grant(self):
        items = [_BY_ID[i] for i in self._GUARD_ITEMS]
        with mock.patch.object(gate_judge, "grant_guard_failure", lambda *a, **k: None):
            results, _ = _replay(items)
        self.assertEqual([r.outcome for r in results], ["granted", "granted"])


class TestJudgeUnavailableFallsBackToLegacy(unittest.TestCase):
    """A judge outage over the whole bank: legacy decides, and the gate still
    never grants on speech that began before the recording sentence."""

    def test_every_consent_item_follows_the_legacy_reader_under_an_outage(self):
        consent = [i for i in _ITEMS if i["phase"] in gb.CONSENT_PHASES]

        class _Down:
            def __init__(self, _item):
                self.responses = []

            async def request(self, **_kwargs):
                import types  # noqa: PLC0415
                self.responses.append((503, None))
                return types.SimpleNamespace(status_code=503, json=lambda: {})

        results = gb.run_items(consent, _Down)
        for r in results:
            item = _BY_ID[r.id]
            if r.legacy_outcome == "granted" and item["utterances"][0].get("start_ms") is not None \
                    and item["utterances"][0]["start_ms"] < (item.get("recording_anchor_ms") or 0):
                self.assertNotEqual(r.outcome, "granted", r.id)
            elif r.legacy_outcome == "machine" and item.get("spoke_before", True):
                self.fail(f"{r.id}: machine after a person spoke")
            else:
                self.assertEqual(r.outcome, r.legacy_outcome, r.id)


if __name__ == "__main__":
    unittest.main()
