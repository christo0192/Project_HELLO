"""Call D RCA (2026-09-08) — T1① author-time résumé-conflict arming.

Call D evidence: a real résumé conflict existed (a "Proprietary Trader" résumé
being screened for a software-engineering role), offline scoring caught it
(``resume_conflicts``), but the DETERMINISTIC live conflict probe never armed
(``conflict_probe_scheduled=0``, ``conflict_found=0`` live) because the only
live arm paths required either the candidate to first SPEAK a conflicting claim
or the flaky live Gemini judge to discover the conflict mid-call. Neither
happened, so the conflict was never raised to the candidate.

The fix computes the résumé↔screened-role class delta DETERMINISTICALLY at
session start (both `role_title` and `resume_facts` are known there) and PRIMES
the same `owed_conflict_probe` latch the async judge uses — so a known conflict
surfaces on the first authored bot turn with NO judge call. The live judge and
the spoken-answer detector remain SECONDARY (belt-and-suspenders).
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

# Reuse the phone-gate harness: its bootstrap installs the stub SDK and exposes
# the REAL coordinator driver + fakes.
from tests.test_phone_gate import (  # noqa: E402
    FakeEventClient,
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


# ── Unit: the author-time detector ───────────────────────────────────────────

class TestAuthortimeDetector(unittest.TestCase):
    """`phone_authortime_resume_conflict` compares résumé role-class vs the
    SCREENED role-class, disjoint → conflict, with no spoken turn and no judge."""

    TRADER_RESUME = {"recent_role": {"title": "Proprietary Trader", "employer": "Quant Tekel"}}

    def test_call_d_trader_resume_vs_software_role_fires(self):
        # The exact Call D shape: a finance/trader résumé screened for a
        # software-engineering role.
        conflict = phone.phone_authortime_resume_conflict(
            self.TRADER_RESUME, "Software Engineer",
        )
        self.assertIsInstance(conflict, dict)
        self.assertEqual(set(conflict), {"resume_fact", "spoken_claim"})
        self.assertIn("Proprietary Trader", conflict["resume_fact"])
        # The "claim" is the role being screened for — a truthful, non-fabricated
        # counter-party (confirm-don't-assert).
        self.assertIn("Software Engineer", conflict["spoken_claim"])

    def test_key_is_stable_and_matches_the_live_key_scheme(self):
        # Same conflict → same dedup key as any other path that names the same
        # resume_fact, so author-time + live paths dedup against each other.
        conflict = phone.phone_authortime_resume_conflict(
            self.TRADER_RESUME, "Backend Developer",
        )
        key = phone.phone_conflict_key(conflict)
        self.assertEqual(key, phone.phone_conflict_key(dict(conflict)))

    def test_compatible_classes_stay_silent(self):
        # Résumé engineering ∩ screened engineering → no conflict.
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Software Engineer"}}, "Backend Developer",
        ))
        # current_role dict form is read the same way.
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            {"current_role": {"title": "Data Analyst"}}, "Data Engineer",
        ))

    def test_unknown_class_on_either_side_stays_silent(self):
        # Unknown résumé class → None (never manufacture a conflict).
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Chief Storyteller"}}, "Software Engineer",
        ))
        # Unknown screened class → None.
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            self.TRADER_RESUME, "Chief Vibes Officer",
        ))

    def test_missing_inputs_stay_silent(self):
        self.assertIsNone(phone.phone_authortime_resume_conflict(None, "Software Engineer"))
        self.assertIsNone(phone.phone_authortime_resume_conflict(self.TRADER_RESUME, None))
        self.assertIsNone(phone.phone_authortime_resume_conflict(self.TRADER_RESUME, ""))
        self.assertIsNone(phone.phone_authortime_resume_conflict({}, "Software Engineer"))

    def test_live_detector_unchanged_by_the_refactor(self):
        # The live spoken-answer detector still reads the résumé role identically
        # after factoring out `_resume_role_title` (regression pin).
        conflict = phone.phone_deterministic_resume_conflict(
            "I am currently working as a software engineer.",
            {"recent_role": {"title": "Sales Advisor", "employer": "upGrad"}},
        )
        self.assertIsInstance(conflict, dict)
        self.assertIn("Sales Advisor", conflict["resume_fact"])


# ── End-to-end: the author-time arm primes the owed probe with NO judge ──────

class TestAuthortimeArming(unittest.IsolatedAsyncioTestCase):
    """Drives the REAL `_run_native_phone_screening`. The arm runs at session
    start, before any turn, so the assertions do not touch the judge at all."""

    TRADER_RESUME = {"recent_role": {"title": "Proprietary Trader", "employer": "Quant Tekel"}}

    @staticmethod
    def _state(role_title, resume_facts):
        state = _default_state(role_title=role_title)
        state.resume_facts = dict(resume_facts) if resume_facts else {}
        return state

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    def _armed_logs(self, hooks):
        return [
            c for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == "phone_coverage_conflict"
            and c.kwargs.get("error_category") == "authortime_conflict_probe_armed"
        ]

    async def test_known_conflict_arms_owed_probe_without_any_judge_call(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        # Patch the judge to a hard failure: if the arm depended on it, the probe
        # would NOT arm. It arms anyway → proves the author-time path is judge-free.
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            side_effect=AssertionError("judge must not be called for the author-time arm"),
        ):
            agent, _, _, _, hooks = await _make_native_coordinator(
                turn_mode="toolless",
                state=self._state("Software Engineer", self.TRADER_RESUME),
                coverage_judge_enabled=True,
                call_metrics=call_metrics,
            )
            owed = getattr(agent, "_owed_conflict_probe", None)
            self.assertIsInstance(owed, dict)
            self.assertTrue(owed["value"], "author-time conflict must prime the owed probe")
            self.assertIsInstance(owed["conflict"], dict)
            self.assertIn("Proprietary Trader", owed["conflict"]["resume_fact"])
            # Observability: the found-deterministic bucket is bumped and the
            # author-time arm log fired.
            self.assertEqual(
                call_metrics["coverage_judge"]["conflict_found_deterministic"], 1,
            )
            self.assertEqual(len(self._armed_logs(hooks)), 1)
            await self._close(hooks)

    async def test_no_conflict_leaves_the_probe_disarmed(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        agent, _, _, _, hooks = await _make_native_coordinator(
            turn_mode="toolless",
            # Résumé engineering ∩ screened engineering → no conflict.
            state=self._state("Backend Developer", {"recent_role": {"title": "Software Engineer"}}),
            coverage_judge_enabled=False,
            call_metrics=call_metrics,
        )
        owed = getattr(agent, "_owed_conflict_probe", None)
        self.assertIsInstance(owed, dict)
        self.assertFalse(owed["value"])
        self.assertEqual(
            call_metrics["coverage_judge"]["conflict_found_deterministic"], 0,
        )
        self.assertEqual(len(self._armed_logs(hooks)), 0)
        await self._close(hooks)

    async def test_gate_off_does_not_arm(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(phone, "phone_conflict_gate_enabled", return_value=False):
            agent, _, _, _, hooks = await _make_native_coordinator(
                turn_mode="toolless",
                state=self._state("Software Engineer", self.TRADER_RESUME),
                coverage_judge_enabled=False,
                call_metrics=call_metrics,
            )
            owed = getattr(agent, "_owed_conflict_probe", None)
            self.assertFalse(owed["value"])
            self.assertEqual(len(self._armed_logs(hooks)), 0)
            await self._close(hooks)

    async def test_judge_discovered_conflict_still_arms_as_secondary(self):
        # No author-time conflict (compatible classes), but the async judge finds
        # one mid-call: the SECONDARY path must still arm the owed probe. Proves
        # the author-time arm did not displace the judge discovery path.
        call_metrics = agent_mod._new_phone_call_metrics()
        judge_conflict = {
            "resume_fact": "Resume says data analyst",
            "spoken_claim": "candidate claimed ten years leading sales",
        }
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(False, judge_conflict, "model"),
        ):
            agent, _, _, _, hooks = await _make_native_coordinator(
                turn_mode="toolless",
                # Compatible classes → NO author-time arm.
                state=self._state("Backend Developer", {"recent_role": {"title": "Software Engineer"}}),
                coverage_judge_enabled=True,
                call_metrics=call_metrics,
            )
            owed = getattr(agent, "_owed_conflict_probe", None)
            self.assertFalse(owed["value"], "no author-time conflict for compatible classes")
            # Drive one turn so the judge fires and its verdict callback arms the
            # owed probe (the secondary path).
            ctx = types.SimpleNamespace(items=[])
            hooks["assistant_delivery_complete"].set()
            hooks["latest_assistant"][0] = "Tell me about your recent role."
            hooks["latest_assistant_anchor"][0] = 1
            await hooks["on_native_turn"](
                "I led a sales team for ten years.",
                types.SimpleNamespace(text_content="I led a sales team for ten years."),
                ctx,
            )
            # Let the async judge verdict callback run.
            for _ in range(100):
                await asyncio.sleep(0.005)
                if owed["value"]:
                    break
            self.assertTrue(owed["value"], "the judge-discovered conflict must arm the owed probe")
            self.assertEqual(call_metrics["coverage_judge"]["conflict_found"], 1)
            await self._close(hooks)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
