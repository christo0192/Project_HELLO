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


# ── FIX A: role-class lexicon widening (additive) ────────────────────────────

class TestRoleClassLexiconWidening(unittest.TestCase):
    """Titles that previously went UNCLASSIFIED (silent false-negatives) now
    classify. RED before the widening (`_role_classes` returned an empty set for
    these); GREEN after. Each new term is pinned to its MOST-SPECIFIC existing
    class so no intra-family disjoint is manufactured (see FIX B below)."""

    def test_qualified_architect_titles_classify_as_engineering(self):
        # An engineering-flavoured QUALIFIER in front of "architect" classifies
        # the title as engineering (2026-09-08 review repair: the term is now
        # ``<qualifier> architect`` only, never a bare ``architect``).
        for title in (
            "Solutions Architect", "Software Architect", "Cloud Architect",
            "Enterprise Architect", "Systems Architect", "Technical Architect",
            "Data Architect", "Security Architect",
        ):
            self.assertIn(
                "engineering", phone._role_classes(title),
                f"{title!r} should classify as engineering",
            )

    def test_bare_and_non_engineering_architect_titles_stay_unclassified(self):
        # 2026-09-08 review repair: the bare ``architect(?:ure)?`` term wrongly
        # pulled non-engineering "architect" titles into the engineering class,
        # manufacturing false disjoint conflicts against design (and other) JDs.
        # These must classify as engineering NOWHERE (as on origin/main), so a
        # design JD vs an "Information Architect" résumé is not a false conflict.
        for title in (
            "Architect", "Information Architect", "Naval Architect",
            "Landscape Architect", "Enterprise Architecture",
        ):
            self.assertNotIn(
                "engineering", phone._role_classes(title),
                f"{title!r} must NOT classify as engineering",
            )

    def test_information_architect_is_not_a_false_conflict_against_design(self):
        # End-to-end: an "Information Architect" résumé screened for a design
        # role must NOT produce an author-time disjoint conflict. Under the old
        # bare-architect term this fired (engineering vs design → disjoint).
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Information Architect"}},
            "Senior Product Designer",
        ))
        # …while a QUALIFIED software architect vs the same design role is a
        # genuine disjoint and is preserved.
        conflict = phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Software Architect"}},
            "Senior Product Designer",
        )
        self.assertIsInstance(conflict, dict)
        self.assertIn("Software Architect", conflict["resume_fact"])

    def test_product_lead_titles_classify_as_management(self):
        # product manager already matched via `manager`; product owner and scrum
        # master are added to the SAME class so the product family never reads as
        # disjoint against itself.
        for title in ("Product Owner", "Scrum Master", "Product Manager"):
            self.assertIn(
                "management", phone._role_classes(title),
                f"{title!r} should classify as management",
            )

    def test_reliability_and_dev_synonyms_classify_as_engineering(self):
        for title in (
            "Reliability Engineer", "Site Reliability Engineer", "SRE",
            "Coder", "Developer",
        ):
            self.assertIn(
                "engineering", phone._role_classes(title),
                f"{title!r} should classify as engineering",
            )

    def test_business_analyst_stays_data_not_a_new_class(self):
        # Deliberately NOT moved to a bespoke class: it already classifies as
        # `data` via `analyst`, and a new class would only create fresh disjoints
        # against genuine data/analytics résumés.
        self.assertEqual(phone._role_classes("Business Analyst"), frozenset({"data"}))

    def test_widened_titles_now_produce_author_time_conflicts(self):
        # End-to-end through the author-time detector: a product-owner résumé
        # screened for a software-engineering role is a real disjoint that the
        # OLD lexicon could not see (product owner was unclassified → None).
        conflict = phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Product Owner"}}, "Backend Developer",
        )
        self.assertIsInstance(conflict, dict)
        self.assertIn("Product Owner", conflict["resume_fact"])


# ── FIX B: multi-class titles are NOT a false disjoint ───────────────────────

class TestSharedDomainTokenIsNotDisjoint(unittest.TestCase):
    """A title that legitimately spans two families (e.g. `trading systems
    engineer` → {engineering, finance}) must NOT read as a hard disjoint against
    either family — the existing set-INTERSECTION disjoint check already grants
    this, and these tests pin it so a future lexicon edit cannot regress it. A
    title with NO shared domain token (e.g. `software engineer` vs a trader
    résumé) STILL conflicts."""

    def test_trading_engineer_vs_trader_is_not_a_conflict(self):
        # {engineering, finance} ∩ {finance} = {finance} ≠ ∅ → not disjoint.
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Proprietary Trader"}},
            "Trading Systems Engineer",
        ))

    def test_software_engineer_vs_trader_still_conflicts(self):
        # {engineering} ∩ {finance} = ∅ → disjoint → real conflict preserved.
        conflict = phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Proprietary Trader"}}, "Software Engineer",
        )
        self.assertIsInstance(conflict, dict)
        self.assertIn("Proprietary Trader", conflict["resume_fact"])

    def test_sales_engineer_vs_sales_resume_is_not_a_conflict(self):
        # {engineering, sales} ∩ {sales} = {sales} ≠ ∅ → not disjoint.
        self.assertIsNone(phone.phone_authortime_resume_conflict(
            {"recent_role": {"title": "Sales Advisor"}}, "Sales Engineer",
        ))

    def test_shared_domain_holds_in_the_spoken_answer_detector_too(self):
        # Same tolerance on the live spoken-answer path: a current claim of a
        # dual-domain title against the résumé's finance role does not fire, but
        # a pure-engineering claim against the same résumé does.
        self.assertIsNone(phone.phone_deterministic_resume_conflict(
            "I am currently a trading systems engineer.",
            {"recent_role": {"title": "Proprietary Trader"}},
        ))
        self.assertIsInstance(phone.phone_deterministic_resume_conflict(
            "I am currently a software engineer.",
            {"recent_role": {"title": "Proprietary Trader"}},
        ), dict)


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

    async def test_judge_name_conflict_arms_owed_probe_when_deterministic_silent(self):
        # FIX C (SE-call: wrong name "Deepak" vs résumé "Christo" never raised).
        # The judge emits a NAME contradiction as a conflict (resume_fact =
        # resume_name, spoken_claim = the name given). It rides the SAME
        # `verdict.conflict` → `owed_conflict_probe` path as a résumé-content
        # conflict. This turn is engineered so EVERY deterministic path stays
        # silent (compatible role classes, non-intro answer → no name mismatch,
        # no author-time delta), so ONLY the judge can arm the probe — proving the
        # judge-as-primary intent for name conflicts too. RED if the judge's NAME
        # finding were dropped when the lexicon is silent; GREEN as shipped.
        call_metrics = agent_mod._new_phone_call_metrics()
        name_conflict = {
            "resume_fact": "Christo",
            "spoken_claim": "Deepak",
        }
        compatible_resume = {
            "recent_role": {"title": "Software Engineer", "employer": "Acme"},
            "name": "Christo",
        }
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(False, name_conflict, "model"),
        ):
            agent, _, _, _, hooks = await _make_native_coordinator(
                turn_mode="toolless",
                # Compatible classes (engineering ∩ engineering) → NO author-time
                # arm and NO spoken-answer conflict.
                state=self._state("Backend Developer", compatible_resume),
                coverage_judge_enabled=True,
                call_metrics=call_metrics,
            )
            owed = getattr(agent, "_owed_conflict_probe", None)
            self.assertFalse(owed["value"], "no deterministic conflict at session start")
            ctx = types.SimpleNamespace(items=[])
            hooks["assistant_delivery_complete"].set()
            hooks["latest_assistant"][0] = "Tell me about your recent role."
            hooks["latest_assistant_anchor"][0] = 1
            # A neutral, non-intro, class-compatible answer: the deterministic
            # name-mismatch AND résumé-conflict paths both stay silent.
            neutral = "I have been building backend services in Python for a few years."
            await hooks["on_native_turn"](
                neutral, types.SimpleNamespace(text_content=neutral), ctx,
            )
            for _ in range(100):
                await asyncio.sleep(0.005)
                if owed["value"]:
                    break
            self.assertTrue(
                owed["value"],
                "the judge's NAME conflict must arm the owed probe with no "
                "deterministic signal",
            )
            self.assertEqual(owed["conflict"]["resume_fact"], "Christo")
            self.assertEqual(owed["conflict"]["spoken_claim"], "Deepak")
            self.assertEqual(call_metrics["coverage_judge"]["conflict_found"], 1)
            await self._close(hooks)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
