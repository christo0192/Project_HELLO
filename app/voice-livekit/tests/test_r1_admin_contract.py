"""The worker's administration rows against what the API actually parses (a CONTRACT test).

The worker posts trusted rows to ``POST /api/internal/r1/admin-log``; the API stores each
payload as sent and ``parseR1AdministrationLog`` reads exactly the names listed in
``API_PAYLOAD_KEYS`` below.  Any other name parses as unknown: the scorer is told ``NOT
PROBED`` / ``slip not reported`` / ``amount not reported`` as TRUSTED ground truth, the gate
fails closed on every session and the guard check for out-of-level commitments goes blind.
The first smoke audit found exactly that (the worker said ``topic``, ``probe_turn``,
``slip_sec``, ``usd`` and ``category``; the API reads ``need``, ``probed_turn``,
``slip_seconds``, ``amount_usd`` and ``kind``), and no test on either side crossed the
boundary: the API fixtures use the API's names, the worker tests checked the worker against
itself.

This module is the crossing:

* ``API_*`` mirror the API's expectations.  The comments name the lines they mirror in
  ``app/api/src/lib/r1/admin-log.ts`` (``parseR1AdministrationLog``) and
  ``app/api/src/lib/r1/gate.ts`` (``evaluateR1Gate``).
* ``parse_like_api`` and ``gate_like_api`` are Python ports of those reads, so the REAL rows
  of a REAL scripted session (the integration rig) can be run through them.
* When the API sources are in the checkout, the mirrored key set is compared with what the
  TypeScript actually reads, so a change on either side fails here instead of in production.

What is deliberately NOT worker-side (and is therefore listed, not hidden):

* ``push_missing:f1``: F1 is anchor + counter in the plan (no F1 push line exists), but the
  API gate requires an F1 push.  That rule is the API's to change (PR-B).
* ``latency_unknown``: the worker does not measure first-audio latency yet (PR-4c), so
  ``session_facts.first_audio_p95_ms`` is sent as an explicit null.
"""
from __future__ import annotations

import json
import math
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]  # app/voice-livekit
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_guard
from r1_phases import R1Phase
from r1_replies import (
    GUARD_KINDS,
    SESSION_FACT_KEYS,
    fidelity_events,
    fidelity_pins,
    guard_kind,
    session_facts_event,
)
from tests.test_r1_core import (
    setUpModule,  # noqa: F401 - unittest runs it: silences the loggers' stdout
    tearDownModule,  # noqa: F401
)
from tests.test_r1_integration import fidelity_session

API_ADMIN_LOG = HERE.parent / "api" / "src" / "lib" / "r1" / "admin-log.ts"
API_ROUTES = HERE.parent / "api" / "src" / "routes" / "r1.ts"

# routes/r1.ts line 15: ADMIN_LOG_EVENTS, the event types the route and the 0117/0122 CHECK accept.
API_EVENT_TYPES = frozenset(
    {
        "need_revealed",
        "family_delivered",
        "push_delivered",
        "counter_delivered",
        "discount_detected",
        "guard_hit",
        "time_cue",
        "session_facts",
    }
)
# admin-log.ts lines 18-34 (the contract comment) and 143-196 (the parse): the payload keys
# each event type is read from.  Nothing else in a payload is read.
API_PAYLOAD_KEYS = {
    "need_revealed": frozenset({"need", "probed_turn"}),  # lines 148-154
    "family_delivered": frozenset({"slip_seconds"}),  # line 146, 155-159
    "push_delivered": frozenset({"slip_seconds"}),  # line 146, 160-164
    "counter_delivered": frozenset({"slip_seconds"}),  # line 146, 165-167
    "discount_detected": frozenset({"amount_usd", "conditional", "value_before"}),  # 168-175
    "guard_hit": frozenset({"kind"}),  # 176-182
    "time_cue": frozenset({"roleplay_seconds"}),  # 183-185
    "session_facts": frozenset(  # 186-196
        {
            "roleplay_seconds",
            "talk_share_pct",
            "longest_monologue_seconds",
            "barge_in_count",
            "question_count",
            "interruption_count",
            "first_audio_p95_ms",
        }
    ),
}
API_GUARD_KINDS = frozenset(  # admin-log.ts lines 113-120 (GUARD_KINDS)
    {"commitment", "concession", "control", "persona", "feedback", "other"}
)
API_FAMILIES = ("F1", "F2", "F3", "F4")  # admin-log.ts line 45
# gate.ts R1_GATE_LIMITS (lines 33-42) that the administration log decides.
MIN_ROLEPLAY_SECONDS = 600
MAX_FAMILY_SLIP_SECONDS = 60
GUARD_HITS_FAIL_AT = 3
MAX_FIRST_AUDIO_P95_MS = 3000

# The failures a worker-complete log still has, each owned by someone else (see the docstring).
KNOWN_OPEN_GATE_FAILURES = frozenset({"push_missing:f1", "latency_unknown"})


# ------------------------------------------------------------ a port of the API's reads


def finite_non_negative(value):  # admin-log.ts lines 96-98
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def turn_of(value):  # admin-log.ts lines 100-102 (JSON 5.0 is the integer 5 to JavaScript)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if float(value).is_integer() and value >= 0 else None


def bool_or_null(value):  # admin-log.ts lines 104-106
    return value if isinstance(value, bool) else None


def parse_like_api(rows):
    """Port of ``parseR1AdministrationLog``; rows are the JSON the API would have stored."""
    needs, discounts, guard_hits = [], [], []
    families = {family: {"primary": None, "push": None} for family in API_FAMILIES}
    counter = time_cue = facts = None
    for row in rows:
        payload = row.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        turn = turn_of(row.get("turn_index"))
        delivery = {"turn": turn, "slip_seconds": finite_non_negative(payload.get("slip_seconds"))}
        event_type, family_id = row["event_type"], row.get("family_id")
        if event_type == "need_revealed":
            need = payload.get("need")
            needs.append(
                {
                    "need": need[:8] if isinstance(need, str) else "unknown",
                    "probed_turn": turn_of(payload.get("probed_turn")),
                    "revealed_turn": turn,
                }
            )
        elif event_type == "family_delivered":
            if family_id in families and families[family_id]["primary"] is None:
                families[family_id]["primary"] = delivery
        elif event_type == "push_delivered":
            if family_id in families and families[family_id]["push"] is None:
                families[family_id]["push"] = delivery
        elif event_type == "counter_delivered":
            counter = counter or delivery
        elif event_type == "discount_detected":
            discounts.append(
                {
                    "turn": turn,
                    "amount_usd": finite_non_negative(payload.get("amount_usd")),
                    "conditional": bool_or_null(payload.get("conditional")),
                    "value_before": bool_or_null(payload.get("value_before")),
                }
            )
        elif event_type == "guard_hit":
            kind = payload.get("kind")
            guard_hits.append(
                {"kind": kind if kind in API_GUARD_KINDS else "other", "turn": turn}
            )
        elif event_type == "time_cue":
            if time_cue is None:
                time_cue = finite_non_negative(payload.get("roleplay_seconds"))
        elif event_type == "session_facts":
            facts = {
                "roleplay_seconds": finite_non_negative(payload.get("roleplay_seconds")),
                **{
                    key: finite_non_negative(payload.get(key))
                    for key in SESSION_FACT_KEYS
                    if key != "roleplay_seconds"
                },
            }
    return {
        "needs": needs,
        "families": families,
        "counter": counter,
        "discounts": discounts,
        "guard_hits": guard_hits,
        "time_cue": time_cue,
        "facts": facts,
    }


def gate_like_api(log):
    """Port of the parts of ``evaluateR1Gate`` that the administration log decides."""
    failures = []
    roleplay = (log["facts"] or {}).get("roleplay_seconds")
    roleplay = log["time_cue"] if roleplay is None else roleplay
    if roleplay is None:
        failures.append("roleplay_duration_unknown")
    elif roleplay < MIN_ROLEPLAY_SECONDS:
        failures.append("roleplay_too_short")
    for family in API_FAMILIES:
        entry, name = log["families"][family], family.lower()
        if entry["primary"] is None:
            failures.append(f"family_missing:{name}")
        if entry["push"] is None:
            failures.append(f"push_missing:{name}")
        for delivery in (entry["primary"], entry["push"]):
            if delivery is None:
                continue
            if delivery["slip_seconds"] is None:
                failures.append(f"family_slip_unknown:{name}")
            elif delivery["slip_seconds"] > MAX_FAMILY_SLIP_SECONDS:
                failures.append(f"family_slip:{name}")
    if log["counter"] is None:
        failures.append("counter_missing")
    elif log["counter"]["slip_seconds"] is None:
        failures.append("counter_slip_unknown")
    elif log["counter"]["slip_seconds"] > MAX_FAMILY_SLIP_SECONDS:
        failures.append("counter_slip")
    if any(need["revealed_turn"] is None for need in log["needs"]):
        failures.append("need_reveal_turn_unknown")
    if any(
        need["revealed_turn"] is not None
        and (need["probed_turn"] is None or need["probed_turn"] > need["revealed_turn"])
        for need in log["needs"]
    ):
        failures.append("unprobed_reveal")
    if any(hit["kind"] == "commitment" for hit in log["guard_hits"]):
        failures.append("out_of_level_commitment")
    if any(hit["kind"] == "concession" for hit in log["guard_hits"]):
        failures.append("out_of_level_concession")
    if len(log["guard_hits"]) >= GUARD_HITS_FAIL_AT:
        failures.append("guard_hits")
    if log["facts"] is None:
        failures.append("fidelity_facts_missing")
    elif log["facts"]["first_audio_p95_ms"] is None:
        failures.append("latency_unknown")
    elif log["facts"]["first_audio_p95_ms"] > MAX_FIRST_AUDIO_P95_MS:
        failures.append("latency_p95_exceeded")
    return failures


def posted(events):
    """What the API would have stored: the rows as the worker's writer sends them, as JSON."""
    return json.loads(json.dumps(events))


# ------------------------------------------------------------------- the real session


class TestWorkerRowsAgainstTheApiParser(unittest.IsolatedAsyncioTestCase):
    """The rows of a complete scripted session, parsed the way the API parses them."""

    async def session_rows(self):
        rig = await fidelity_session()
        rig.interview._begin_exit()
        rig.interview._queue_fidelity()
        await rig.flush()
        return rig, posted(rig.writer.admin_events)

    async def test_every_row_is_an_event_type_the_route_accepts(self):
        _, rows = await self.session_rows()
        self.assertTrue(rows)
        self.assertLessEqual({row["event_type"] for row in rows}, API_EVENT_TYPES)

    async def test_every_row_carries_every_key_the_parser_reads(self):
        _, rows = await self.session_rows()
        for row in rows:
            expected = API_PAYLOAD_KEYS[row["event_type"]]
            with self.subTest(event_type=row["event_type"], turn=row["turn_index"]):
                self.assertLessEqual(expected, set(row["payload"]), row)

    async def test_no_row_still_speaks_the_workers_old_names(self):
        _, rows = await self.session_rows()
        old_names = {"topic", "probe_turn", "slip_sec", "usd", "category"}
        for row in rows:
            with self.subTest(event_type=row["event_type"]):
                self.assertEqual(old_names & set(row["payload"]), set(), row)

    async def test_the_parsed_log_has_real_values_where_the_parser_used_to_see_unknowns(self):
        rig, rows = await self.session_rows()
        log = parse_like_api(rows)
        # Needs: a real H-id, probed at or before the reveal (not "NOT PROBED").
        self.assertTrue(log["needs"])
        for need in log["needs"]:
            self.assertIn(need["need"], {"H1", "H2", "H3"})
            self.assertIsNotNone(need["probed_turn"])
            self.assertLessEqual(need["probed_turn"], need["revealed_turn"])
        # Objections: every delivery has a slip (not "slip not reported").
        for family in API_FAMILIES:
            self.assertIsNotNone(log["families"][family]["primary"], family)
            self.assertIsNotNone(log["families"][family]["primary"]["slip_seconds"], family)
        for family in ("F2", "F3", "F4"):
            self.assertIsNotNone(log["families"][family]["push"]["slip_seconds"], family)
        self.assertIsNotNone(log["counter"]["slip_seconds"])
        # Discounts: an amount (not "amount not reported").
        self.assertTrue(log["discounts"])
        for discount in log["discounts"]:
            self.assertIsNotNone(discount["amount_usd"])
            self.assertIsNotNone(discount["conditional"])
            self.assertIsNotNone(discount["value_before"])
        # The learner's time cue carries the role-play clock; the facts row exists.
        self.assertIsNotNone(log["time_cue"])
        self.assertGreater(log["time_cue"], 600)
        self.assertIsNotNone(log["facts"])
        self.assertAlmostEqual(
            log["facts"]["roleplay_seconds"], rig.machine.roleplay_elapsed, delta=0.1
        )

    async def test_the_gate_is_left_with_exactly_the_failures_that_are_not_the_workers(self):
        _, rows = await self.session_rows()
        failures = set(gate_like_api(parse_like_api(rows)))
        self.assertEqual(
            failures,
            KNOWN_OPEN_GATE_FAILURES,
            "a worker-side contract failure is back (the gate reads unknowns again), or one of "
            "the two API/PR-4c-owned gaps was closed: update KNOWN_OPEN_GATE_FAILURES",
        )

    async def test_the_guard_trip_of_the_session_is_a_known_kind(self):
        _, rows = await self.session_rows()
        hits = [row for row in rows if row["event_type"] == "guard_hit"]
        self.assertTrue(hits)
        for row in hits:
            self.assertIn(row["payload"]["kind"], API_GUARD_KINDS)


class TestSessionFacts(unittest.IsolatedAsyncioTestCase):
    async def test_one_session_facts_row_with_exactly_the_keys_the_parser_reads(self):
        rig = await fidelity_session()
        rig.interview._begin_exit()
        rig.interview._queue_fidelity()
        await rig.flush()
        facts = [e for e in posted(rig.writer.admin_events) if e["event_type"] == "session_facts"]
        self.assertEqual(len(facts), 1)
        payload = facts[0]["payload"]
        self.assertEqual(set(payload) - {"pins"}, API_PAYLOAD_KEYS["session_facts"])
        self.assertEqual(set(SESSION_FACT_KEYS), API_PAYLOAD_KEYS["session_facts"])
        for key in SESSION_FACT_KEYS:
            value = payload[key]
            self.assertTrue(
                value is None
                or (isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) and value >= 0),
                (key, value),
            )
        # What the worker measures today, and what it honestly leaves unknown.  The rig has no
        # user-speaking events, so no turn length was ever measured: null, not a fake 0.0 s.
        self.assertIsNotNone(payload["roleplay_seconds"])
        self.assertIsNone(payload["longest_monologue_seconds"])
        self.assertIsNone(payload["first_audio_p95_ms"])  # PR-4c: the gate says latency_unknown
        self.assertEqual(facts[0]["turn_index"], None)
        self.assertEqual(facts[0]["family_id"], None)

    async def test_the_role_play_clock_is_the_role_plays_not_the_sessions(self):
        rig = await fidelity_session()
        rig.machine.transition(R1Phase.ROLEPLAY_EXIT)
        at_exit = rig.machine.roleplay_elapsed
        rig.clock.advance(300)  # the exit line and the wrap-up run on
        event = session_facts_event(None, fidelity_pins(rig.interview.persona_choice),
                                    roleplay_seconds=rig.machine.roleplay_elapsed)
        self.assertEqual(event["payload"]["roleplay_seconds"], round(at_exit, 1))

    def test_unmeasured_or_invalid_values_are_sent_as_null_never_as_a_guess(self):
        for admin in (None, {}, {"communication": {}},
                      {"communication": {"longest_candidate_turn_sec": 0.0}},
                      {"communication": {"longest_candidate_turn_sec": -1}},
                      {"communication": {"longest_candidate_turn_sec": float("nan")}},
                      {"communication": {"longest_candidate_turn_sec": True}}):
            with self.subTest(admin=admin):
                payload = session_facts_event(admin, {}, roleplay_seconds=42.0)["payload"]
                self.assertIsNone(payload["longest_monologue_seconds"])
                self.assertEqual(payload["roleplay_seconds"], 42.0)
        payload = session_facts_event(
            {"communication": {"longest_candidate_turn_sec": 41.5}}, {}, roleplay_seconds=700.04
        )["payload"]
        self.assertEqual(payload["longest_monologue_seconds"], 41.5)
        self.assertEqual(payload["roleplay_seconds"], 700.0)


# ------------------------------------------------------------------------- guard hits


class TestGuardHitKinds(unittest.TestCase):
    PINS = {"persona_id": "p"}

    def rows(self, *categories):
        trips = [
            {"turn_index": 3 + index, "phase": "roleplay", "category": category,
             "rule": "r", "digest": "d" * 12}
            for index, category in enumerate(categories)
        ]
        return posted(fidelity_events({}, self.PINS, trips))

    def test_the_worker_vocabulary_maps_onto_the_api_kinds(self):
        self.assertEqual(set(GUARD_KINDS), set(API_GUARD_KINDS))
        for category in r1_guard.CATEGORIES:
            with self.subTest(category=category):
                self.assertIn(guard_kind(category), API_GUARD_KINDS)
        self.assertEqual(guard_kind("commitment"), "commitment")
        self.assertEqual(guard_kind("concession"), "concession")
        self.assertEqual(guard_kind("persona_secret"), "persona")
        self.assertEqual(guard_kind("volunteered_need"), "persona")
        self.assertEqual(guard_kind("feedback"), "feedback")
        for category in ("control", "vendor", "evaluation", "meta", "scripted_cue"):
            self.assertEqual(guard_kind(category), "control", category)
        for category in ("invented_fact", "contact", "protected_question", "unknown", None):
            self.assertEqual(guard_kind(category), "other", category)

    def test_a_commitment_or_concession_trip_fails_the_gate_as_out_of_level(self):
        log = parse_like_api(self.rows("commitment", "concession"))
        self.assertEqual([hit["kind"] for hit in log["guard_hits"]], ["commitment", "concession"])
        failures = gate_like_api(log)
        self.assertIn("out_of_level_commitment", failures)
        self.assertIn("out_of_level_concession", failures)

    def test_acknowledgement_hygiene_trips_are_not_posted(self):
        # The worker's own ledger leaves them out of its 3-hit count; the API counts EVERY row.
        rows = self.rows("ack_format", "ack_format", "ack_format", "control")
        self.assertEqual([row["payload"]["kind"] for row in rows], ["control"])
        self.assertNotIn("guard_hits", gate_like_api(parse_like_api(rows)))

    def test_three_real_leaks_still_trip_the_hit_budget(self):
        rows = self.rows("control", "persona_secret", "invented_fact")
        self.assertIn("guard_hits", gate_like_api(parse_like_api(rows)))

    def test_a_guard_row_carries_a_turn_the_parser_accepts(self):
        (row,) = self.rows("control")
        self.assertEqual(turn_of(row["turn_index"]), 3)


# ------------------------------------------------- the API sources, when they are here


@unittest.skipUnless(API_ADMIN_LOG.is_file(), "the API sources are not part of this checkout")
class TestMirrorMatchesTheTypeScript(unittest.TestCase):
    """If the parser changes, this mirror (and so the worker) must change with it."""

    @classmethod
    def setUpClass(cls):
        cls.source = API_ADMIN_LOG.read_text(encoding="utf-8")

    def test_the_payload_keys_the_parser_reads_are_the_mirrored_ones(self):
        read = set(re.findall(r"payload\.([a-z_0-9]+)", self.source))
        mirrored = set().union(*API_PAYLOAD_KEYS.values())
        self.assertEqual(read, mirrored, "admin-log.ts reads different payload keys")

    def test_the_event_types_the_parser_switches_on_are_the_mirrored_ones(self):
        cases = set(re.findall(r"case '([a-z_]+)':", self.source))
        self.assertEqual(cases, set(API_EVENT_TYPES))

    def test_the_guard_kinds_and_families_are_the_mirrored_ones(self):
        block = re.search(r"GUARD_KINDS[^=]*=\s*new Set\(\[(.*?)\]\)", self.source, re.DOTALL)
        self.assertIsNotNone(block)
        self.assertEqual(set(re.findall(r"'([a-z]+)'", block.group(1))), set(API_GUARD_KINDS))
        families = re.search(r"R1_FAMILIES\s*=\s*\[(.*?)\]", self.source, re.DOTALL)
        self.assertEqual(tuple(re.findall(r"'(F[0-9])'", families.group(1))), API_FAMILIES)

    @unittest.skipUnless(API_ROUTES.is_file(), "the API routes are not part of this checkout")
    def test_the_route_accepts_exactly_the_mirrored_event_types(self):
        text = API_ROUTES.read_text(encoding="utf-8")
        block = re.search(r"ADMIN_LOG_EVENTS\s*=\s*\[(.*?)\]", text, re.DOTALL)
        self.assertIsNotNone(block)
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", block.group(1))), set(API_EVENT_TYPES))

    def test_the_gate_limits_are_the_mirrored_ones(self):
        gate = API_ADMIN_LOG.with_name("gate.ts")
        if not gate.is_file():
            self.skipTest("gate.ts is not part of this checkout")
        text = gate.read_text(encoding="utf-8")
        for name, value in (
            ("MIN_ROLEPLAY_SECONDS", MIN_ROLEPLAY_SECONDS),
            ("MAX_FAMILY_SLIP_SECONDS", MAX_FAMILY_SLIP_SECONDS),
            ("GUARD_HITS_FAIL_AT", GUARD_HITS_FAIL_AT),
            ("MAX_FIRST_AUDIO_P95_MS", MAX_FIRST_AUDIO_P95_MS),
        ):
            with self.subTest(limit=name):
                self.assertRegex(text, rf"{name}:\s*{value}\b")


if __name__ == "__main__":
    unittest.main()
