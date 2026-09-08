"""SE-call RCA slate (2026-09-07) — delivery-verified commits, objective-drift
guard, conflict-detector generalization, judge telemetry, and the truthful
post_event refusal contract.

FIX 1 — a MANDATORY question (compensation / notice period) whose DELIVERED ask
never reached its objective must HOLD the cursor and re-ask (bounded), instead
of committing ``ask_delivered: True`` for an ask that never happened.
FIX 2 — a plan-pursuit reply whose question clause misses the authorized
objective is rejected ``objective_drift`` (phase-gated; custom objectives fail
open).
FIX 3 — the deterministic résumé-conflict detector generalizes past the
sales-only claim lexicon (role classes, hoisted employer comparison, duration
divergence) without regressing the proven sales-call fixtures.
FIX 4 — coverage-judge outcomes/conflicts are counted into per-call telemetry
with honest zeros; timeout and error are separate categories.
FIX 6a — a server ``ok:false`` + status body is a truthful refusal, not
``malformed_response``, and a terminal ``ignored`` verdict stops the retry loop.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

# Reuse the phone-gate harness: its module bootstrap installs the stub SDK and
# exposes the REAL coordinator driver + fakes.
from tests.test_phone_gate import (  # noqa: E402
    FakeEventClient,
    _GOOD_SECRET,
    _RecordingTransport,
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


# ── FIX 1: delivery-verified commit gate ─────────────────────────────────────

class TestDeliveryVerifiedCommitGate(unittest.IsolatedAsyncioTestCase):
    """Driven through the REAL single-STT-final turn hook, not an isolated
    predicate: the gate must hold BEFORE the answer-gate disposition block and
    before `pending` is populated."""

    OFF_OBJECTIVE_PROMPT = "Tell me, what do you usually do on your weekends?"
    # Substantive, answer-shaped, does NOT cover the notice objective and does
    # not mention comp/notice at all.
    NEUTRAL_ANSWER = "I usually spend time with my family and read books."

    @staticmethod
    def _notice_state():
        return _default_state(questions=[
            {"key": "k1", "text": "What is your notice period?", "mandatory": True, "hint": None},
            {"key": "k2", "text": "Second question?", "mandatory": True, "hint": None},
        ])

    async def _coordinator(self, state=None):
        agent, session, st, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=state or self._notice_state(),
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = self.OFF_OBJECTIVE_PROMPT
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, st, client, hooks

    async def _turn(self, hooks, text):
        ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](
            text, types.SimpleNamespace(text_content=text), ctx,
        )
        return ctx

    async def _drain(self, predicate, tries=100):
        for _ in range(tries):
            await asyncio.sleep(0.005)
            if predicate():
                return True
        return False

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    def _gate_logs(self, hooks, category):
        return [
            c for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == "phone_delivery_gate"
            and c.kwargs.get("error_category") == category
        ]

    async def test_mandatory_ask_drift_holds_cursor_and_reasks_authorized(self):
        agent, _, state, client, hooks = await self._coordinator()
        ctx = await self._turn(hooks, self.NEUTRAL_ANSWER)
        # The re-ask was emitted with the EXACT owed question, via the
        # answer-gate template (policy outside the objective guard's scope) and
        # an authorized generation (the one-question validator cannot drop it).
        self.assertIn(state.questions[0].spoken_text, str(ctx.items))
        self.assertEqual(getattr(agent, "_turn_policy", None), "answer_reask")
        self.assertEqual(
            getattr(agent, "_generation_objective", None),
            state.questions[0].spoken_text,
        )
        self.assertTrue(self._gate_logs(hooks, "mandatory_ask_drift_reask"))
        # The cursor HELD: pending was never populated, so no boundary commit.
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(client.committed_keys, [])
        self.assertIsNone(agent._pending.get("question"))
        await self._close(hooks)

    async def test_cap_falls_through_and_commits_with_cap_log(self):
        agent, _, state, client, hooks = await self._coordinator()
        await self._turn(hooks, self.NEUTRAL_ANSWER)
        await self._turn(hooks, self.NEUTRAL_ANSWER)
        self.assertEqual(len(self._gate_logs(hooks, "mandatory_ask_drift_reask")), 2)
        self.assertEqual(client.committed_keys, [])
        # Third drift for the same key: cap reached — fall through (loudly)
        # to the historical path; the substantive answer then commits.
        await self._turn(hooks, self.NEUTRAL_ANSWER)
        self.assertTrue(self._gate_logs(hooks, "delivery_gate_cap_reached"))
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        await self._close(hooks)

    async def test_composed_cap_answer_gate_cannot_stack_past_three_holds(self):
        # After TWO delivery-gate holds, the answer gate may add at most ONE
        # more (combined ≤ 3): a non-answer on the fall-through turn re-asks
        # once, then the next non-answer advances at the composed cap.
        agent, _, state, client, hooks = await self._coordinator()
        nonanswer = "If I answer that, will you tell me the salary band first?"
        await self._turn(hooks, self.NEUTRAL_ANSWER)   # drift hold 1
        await self._turn(hooks, self.NEUTRAL_ANSWER)   # drift hold 2
        await self._turn(hooks, nonanswer)             # answer-gate hold 3
        self.assertEqual(client.committed_keys, [])
        await self._turn(hooks, nonanswer)             # composed cap: advance
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        await self._close(hooks)

    async def test_non_mandatory_question_stays_shadow_only(self):
        # Same drifting ask against a NON-mandatory (experience) objective:
        # only the pre-existing shadow log fires and the exchange commits.
        state = _default_state(questions=[
            {"key": "k1", "text": "Ask about total experience and customer-facing, counselling, advisory, or sales experience.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "Second question?", "mandatory": True, "hint": None},
        ])
        agent, _, st, client, hooks = await self._coordinator(state=state)
        answer = "I have four years of customer-facing sales experience."
        await self._turn(hooks, answer)
        self.assertFalse(self._gate_logs(hooks, "mandatory_ask_drift_reask"))
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        await self._close(hooks)

    async def test_kill_switch_restores_playout_as_delivery_proof(self):
        with patch.dict(phone.os.environ, {"PHONE_DELIVERY_GATE": "off"}):
            agent, _, state, client, hooks = await self._coordinator()
            await self._turn(hooks, self.NEUTRAL_ANSWER)
            self.assertFalse(self._gate_logs(hooks, "mandatory_ask_drift_reask"))
            self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
            await self._close(hooks)

    async def test_candidate_answer_covering_objective_is_never_held(self):
        # SAFETY VALVE: the candidate volunteered the mandatory answer even
        # though the delivered ask drifted — nothing was lost, so holding
        # (and re-asking a question just answered) would be wrong.
        agent, _, state, client, hooks = await self._coordinator()
        await self._turn(hooks, "My notice period is thirty days.")
        self.assertFalse(self._gate_logs(hooks, "mandatory_ask_drift_reask"))
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        await self._close(hooks)

    async def test_on_objective_ask_passes_untouched(self):
        agent, _, state, client, hooks = await self._coordinator()
        hooks["latest_assistant"][0] = (
            "Thanks! Could you tell me what your notice period is?"
        )
        await self._turn(hooks, "It is sixty days.")
        self.assertFalse(self._gate_logs(hooks, "mandatory_ask_drift_reask"))
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        await self._close(hooks)

    def test_mandatory_objective_predicate_shapes(self):
        for text in (
            "What is your notice period?",
            "Ask when the candidate can join.",
            "Check availability to start.",
            "Are you serving notice currently?",
        ):
            self.assertTrue(phone.phone_is_mandatory_objective(text), text)
        for text in (
            "Tell me about your current role.",
            "What is your expected CTC?",  # compensation predicate's job
            None, 42,
        ):
            self.assertFalse(phone.phone_is_mandatory_objective(text), text)

    def test_delivery_gate_env_default_on_only_literal_off_disables(self):
        with patch.dict(phone.os.environ, {}, clear=False):
            phone.os.environ.pop("PHONE_DELIVERY_GATE", None)
            self.assertTrue(phone.phone_delivery_gate_enabled())
        with patch.dict(phone.os.environ, {"PHONE_DELIVERY_GATE": " OFF "}):
            self.assertFalse(phone.phone_delivery_gate_enabled())
        with patch.dict(phone.os.environ, {"PHONE_DELIVERY_GATE": "false"}):
            self.assertTrue(phone.phone_delivery_gate_enabled())


# ── FIX 2: objective_drift guard ─────────────────────────────────────────────

class TestObjectiveDriftGuard(unittest.TestCase):
    DRIFTING_REPLY = "Nice! And which city are you currently based in?"
    ON_OBJECTIVE_REPLY = "Thanks for that. What is your notice period at your current job?"
    NOTICE_OBJECTIVE = "What is your notice period?"

    def test_plan_pursuit_drift_is_no_longer_rejected(self):
        # B4 (PR1a, 2026-09-08): `objective_drift` is DOWNGRADED TO LOG-ONLY. A
        # plan-pursuit reply whose question clause does not lexically reach the
        # authorized objective is no longer swapped for the canned line — the
        # coverage predicate is a shadow signal that mis-fires on paraphrases.
        # RED before B4 (returned "objective_drift"); GREEN after (None). The
        # occurrence is still logged as a soft flag.
        self.assertIsNone(
            phone.phone_generated_reply_rejection_reason(
                self.DRIFTING_REPLY, self.NOTICE_OBJECTIVE,
                allow_closing=False, enforce_objective=True,
            ),
        )

    def test_on_objective_reply_passes(self):
        self.assertIsNone(phone.phone_generated_reply_rejection_reason(
            self.ON_OBJECTIVE_REPLY, self.NOTICE_OBJECTIVE,
            allow_closing=False, enforce_objective=True,
        ))

    def test_default_off_preserves_every_historical_caller(self):
        self.assertIsNone(phone.phone_generated_reply_rejection_reason(
            self.DRIFTING_REPLY, self.NOTICE_OBJECTIVE, allow_closing=False,
        ))

    def test_custom_objective_fails_open(self):
        # No deterministic contract matches a custom recruiter objective; the
        # coverage predicate fails open, so enforcement cannot reject it.
        self.assertIsNone(phone.phone_generated_reply_rejection_reason(
            self.DRIFTING_REPLY,
            "Ask which programming certifications the candidate holds.",
            allow_closing=False, enforce_objective=True,
        ))

    def test_closing_allowed_turn_is_exempt(self):
        self.assertIsNone(phone.phone_generated_reply_rejection_reason(
            "Thanks so much for your time today. Goodbye and take care.",
            self.NOTICE_OBJECTIVE, allow_closing=True, enforce_objective=True,
        ))

    def test_earlier_rejections_keep_precedence(self):
        # A drifting reply that ALSO drifts to compensation reports the
        # sharper pre-existing category, not the new one.
        self.assertEqual(
            phone.phone_generated_reply_rejection_reason(
                "And what salary do you expect?",
                "Tell me about your current work.",
                allow_closing=False, enforce_objective=True,
            ),
            "compensation_drift",
        )

    def test_guard_call_site_enforces_only_the_screening_phase(self):
        # The llm_node guard opts in exactly for the plan-pursuit ("screening")
        # snapshot phase; conflict/name-confirm/reanchor phases stay exempt.
        import inspect
        source = inspect.getsource(phone)
        self.assertIn(
            'enforce_objective=(self._generation_phase == "screening")', source,
            "the objective-drift enforcement must be phase-gated to the "
            "plan-pursuit generation phase at the guard call site",
        )

    def test_conflict_and_name_confirm_phase_replies_are_not_rejected(self):
        # A natural conflict/name-confirm probe re-anchors on the REMEDY text,
        # not the plan question. With enforcement default-off (the exemption the
        # call site grants those phases) the probe passes exactly as today.
        probe = (
            "Thanks for walking me through that. Your resume lists a trading "
            "role — could you help me square that with the sales work you "
            "described?"
        )
        self.assertIsNone(phone.phone_generated_reply_rejection_reason(
            probe, phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT,
            allow_closing=False,
            max_question_acts=phone.phone_objective_guard_max_questions_for_phase(
                "resume_conflict"),
        ))


# ── FIX 3: conflict-detector generalization ──────────────────────────────────

class TestConflictDetectorGeneralization(unittest.TestCase):
    SALES_RESUME = {"recent_role": {"title": "Sales Advisor", "employer": "upGrad"}}
    TRADER_RESUME = {"recent_role": {"title": "Proprietary Trader", "employer": "Quant Tekel"}}

    def _conflict(self, text, facts):
        return phone.phone_deterministic_resume_conflict(text, facts)

    # Original proven sales-call fixtures — must stay green byte-for-byte.
    def test_original_sales_fixture_title_mismatch(self):
        conflict = self._conflict(
            "I have around three years of experience in EdTech companies and "
            "worked as a sales and program advisor.",
            {"recent_role": {"title": "Proprietary Trader"}},
        )
        self.assertEqual(
            conflict["resume_fact"],
            "Current or most recent resume role: Proprietary Trader",
        )
        self.assertIn("three years", conflict["spoken_claim"])

    def test_original_sales_fixture_with_employer_suffix(self):
        conflict = self._conflict(
            "I have around two years of experience in EdTech companies like "
            "upGrad, Great Learning, and KLR, working as a sales and program "
            "advisor.",
            self.TRADER_RESUME,
        )
        self.assertIsNotNone(conflict)
        self.assertIn("Quant Tekel", conflict["resume_fact"])

    def test_original_intro_only_shapes_stay_silent(self):
        for text in (
            "Hi there, my name is Christo, thanks for calling.",
            "Hi, my name is Christo, nice to meet you.",
            "I joined last month.",
            "Thirty days.",
        ):
            self.assertIsNone(self._conflict(
                text, {"name": "Rijo", "current_role": {"title": "Data Engineer"}},
            ), text)

    # THE SE-CALL SHAPE the old lexicon was blind to.
    def test_se_shape_engineering_claim_against_sales_resume_fires(self):
        for text in (
            "I am currently working as a software engineer doing backend development.",
            "I have five years of experience as a software developer.",
            "I've been a full-stack developer for three years now.",
        ):
            conflict = self._conflict(text, self.SALES_RESUME)
            self.assertIsInstance(conflict, dict, text)
            self.assertIn("Sales Advisor", conflict["resume_fact"])
            self.assertEqual(
                set(conflict), {"resume_fact", "spoken_claim"},
                "the conflict output shape is pinned",
            )

    def test_compatible_or_overlapping_classes_stay_silent(self):
        # Same class → no conflict; overlapping class sets → no conflict.
        self.assertIsNone(self._conflict(
            "I'm currently a backend developer working mostly in Python.",
            {"recent_role": {"title": "Software Engineer"}},
        ))
        self.assertIsNone(self._conflict(
            "I am a software engineer with four years of experience building pipelines.",
            {"recent_role": {"title": "Data Engineer"}},  # {data, engineering}
        ))

    def test_unknown_class_on_either_side_stays_silent(self):
        # Unknown spoken class.
        self.assertIsNone(self._conflict(
            "I've been a horticulturist for three years.",
            {"recent_role": {"title": "Data Engineer"}},
        ))
        # Unknown résumé class.
        self.assertIsNone(self._conflict(
            "I am currently a software engineer.",
            {"recent_role": {"title": "Chief Storyteller"}},
        ))

    def test_unlisted_past_job_is_none(self):
        # A PAST job that is not on the résumé is not a current-work conflict.
        self.assertIsNone(self._conflict(
            "Previously I worked at Zomato for two years as a sales advisor.",
            self.SALES_RESUME,
        ))

    def test_employer_mismatch_fires_for_current_claims_beyond_sales(self):
        conflict = self._conflict(
            "Right now I am working at Zeta Payments.",
            {"recent_role": {"title": "Data Engineer", "employer": "Infosys"}},
        )
        self.assertIsInstance(conflict, dict)
        self.assertIn("Infosys", conflict["resume_fact"])

    def test_employer_containment_matches_both_directions(self):
        self.assertIsNone(self._conflict(
            "I currently work at Infosys Limited.",
            {"recent_role": {"title": "Data Engineer", "employer": "Infosys"}},
        ))
        self.assertIsNone(self._conflict(
            "I currently work at Infosys.",
            {"recent_role": {"title": "Data Engineer", "employer": "Infosys Limited"}},
        ))

    def test_prior_role_employers_count_as_listed(self):
        self.assertIsNone(self._conflict(
            "I am currently working with Great Learning.",
            {
                "recent_role": {"title": "Sales Advisor", "employer": "upGrad"},
                "prior_roles": [{"employer": "Great Learning"}],
            },
        ))

    def test_applying_for_target_company_is_not_an_employer_claim(self):
        self.assertIsNone(self._conflict(
            "I have three years of experience and I'm applying for Interview Kickstart.",
            {"recent_role": {"title": "Sales Advisor", "employer": "upGrad"}},
        ))

    def test_duration_divergence_fires_at_two_years_or_fifty_percent(self):
        fired = self._conflict(
            "I have ten years of experience in this field.",
            {"experience_years": 3},
        )
        self.assertIsInstance(fired, dict)
        self.assertIn("3", fired["resume_fact"])
        # Within tolerance: no conflict.
        self.assertIsNone(self._conflict(
            "I have three years of experience.", {"experience_years": 3},
        ))
        self.assertIsNone(self._conflict(
            "I have four years of experience.", {"experience_years": 3.5},
        ))

    def test_bare_tenure_duration_never_trips_the_experience_check(self):
        # "two years" about one role is NOT a total-experience claim.
        self.assertIsNone(self._conflict(
            "I stayed there for two years before moving on.",
            {"experience_years": 8},
        ))

    def test_output_shape_and_key_are_stable_for_dedup(self):
        conflict = self._conflict(
            "I am currently a software engineer.", self.SALES_RESUME,
        )
        self.assertEqual(set(conflict), {"resume_fact", "spoken_claim"})
        self.assertEqual(
            phone.phone_conflict_key(conflict),
            phone.phone_conflict_key(dict(conflict)),
        )


# ── FIX 4: coverage-judge telemetry ──────────────────────────────────────────

class TestCoverageJudgeTelemetry(unittest.TestCase):
    # F-Q2a (call #2 RCA): `conflict_found_deterministic` joins the fixed set —
    # the sync deterministic detector's findings were previously invisible
    # (probe played, counters read 0/0).
    BUCKETS = (
        "covered_deterministic", "not_covered_deterministic",
        "covered_model", "not_covered_model",
        "judge_timeout", "judge_error",
        "conflict_found", "conflict_found_deterministic",
        # Codex review Finding F: arming counts `scheduled`; only the playout
        # proof counts `delivered` — for every origin.
        "conflict_probe_scheduled", "conflict_probe_delivered",
    )

    def test_accumulator_starts_with_honest_zeros(self):
        metrics = agent_mod._new_phone_call_metrics()
        self.assertEqual(
            metrics["coverage_judge"], {bucket: 0 for bucket in self.BUCKETS},
        )

    def test_bump_increments_known_buckets_and_ignores_unknown(self):
        metrics = agent_mod._new_phone_call_metrics()
        agent_mod._bump_coverage_judge_metric(metrics, "covered_model")
        agent_mod._bump_coverage_judge_metric(metrics, "covered_model")
        agent_mod._bump_coverage_judge_metric(metrics, "not_a_bucket")
        agent_mod._bump_coverage_judge_metric(None, "covered_model")  # never raises
        self.assertEqual(metrics["coverage_judge"]["covered_model"], 2)
        self.assertNotIn("not_a_bucket", metrics["coverage_judge"])

    def test_summary_always_includes_the_block_with_int_coercion(self):
        metrics = agent_mod._new_phone_call_metrics()
        snapshot = agent_mod._summarize_phone_call_metrics(metrics)
        self.assertEqual(
            snapshot["coverage_judge"], {bucket: 0 for bucket in self.BUCKETS},
        )
        metrics["coverage_judge"]["judge_timeout"] = "3"   # coerced
        metrics["coverage_judge"]["judge_error"] = object()  # reduces to 0
        snapshot = agent_mod._summarize_phone_call_metrics(metrics)
        self.assertEqual(snapshot["coverage_judge"]["judge_timeout"], 3)
        self.assertEqual(snapshot["coverage_judge"]["judge_error"], 0)
        # A legacy accumulator without the block still summarizes zeros.
        snapshot = agent_mod._summarize_phone_call_metrics(
            {"watchdog_fired_count": 1, "deterministic_fallback_count": 0},
        )
        self.assertEqual(
            snapshot["coverage_judge"], {bucket: 0 for bucket in self.BUCKETS},
        )


class TestCoverageJudgeTelemetryWiring(unittest.IsolatedAsyncioTestCase):
    """The increments happen at the LIVE choke points, driven through the real
    coordinator commit path."""

    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])

    async def _coordinator(self, call_metrics):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
            coverage_judge_enabled=True, call_metrics=call_metrics,
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = "Tell me about your recent role."
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def _turn(self, hooks, text):
        ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](
            text, types.SimpleNamespace(text_content=text), ctx,
        )
        return ctx

    async def _drain(self, predicate, tries=300):
        for _ in range(tries):
            await asyncio.sleep(0.01)
            if predicate():
                return True
        return False

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    async def test_verdict_conflict_and_probe_delivery_are_counted(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        agent, _, state, client, hooks = await self._coordinator(call_metrics)
        conflict = {
            "resume_fact": "Six years at Example Co",
            "spoken_claim": "I joined last month",
        }
        verdict = phone.PhoneCoverageVerdict(True, conflict, "model")
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=verdict,
        ):
            await self._turn(hooks, "I have been leading data projects there.")
            self.assertTrue(await self._drain(
                lambda: call_metrics["coverage_judge"]["covered_model"] == 1))
            self.assertEqual(call_metrics["coverage_judge"]["conflict_found"], 1)
            # The next authored turn SCHEDULES the owed probe. Finding F
            # (Codex review §8): arming is not delivery — the async promotion
            # used to bump `conflict_probe_delivered` here, mixing scheduled
            # and played probes in one metric.
            hooks["latest_assistant"][0] = "What is your notice period?"
            await self._turn(hooks, "Thirty days notice, I can start after that.")
        self.assertEqual(
            call_metrics["coverage_judge"]["conflict_probe_scheduled"], 1)
        self.assertEqual(
            call_metrics["coverage_judge"]["conflict_probe_delivered"], 0)
        # Only the playout proof counts the delivery — same choke point as the
        # sync deterministic path.
        value = agent._on_reply_delivered(False)
        if asyncio.iscoroutine(value):
            await value
        self.assertEqual(
            call_metrics["coverage_judge"]["conflict_probe_delivered"], 1)
        await self._close(hooks)

    async def test_judge_timeout_is_counted_in_its_own_bucket(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        agent, _, state, client, hooks = await self._coordinator(call_metrics)
        timeout_verdict = phone.PhoneCoverageVerdict(False, None, "judge_timeout")
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=timeout_verdict,
        ):
            await self._turn(hooks, "I have been leading data projects there.")
            self.assertTrue(await self._drain(
                lambda: call_metrics["coverage_judge"]["judge_timeout"] == 1))
        self.assertEqual(call_metrics["coverage_judge"]["judge_error"], 0)
        await self._close(hooks)


# ── FIX 6a: truthful post_event refusals + terminal retry stop ───────────────

class TestPostEventTruthfulRefusal(unittest.IsolatedAsyncioTestCase):
    def _client(self, transport):
        return phone.PhoneEventClient(
            transport_factory=lambda: transport, api_base="http://api.test",
        )

    async def _post(self, body, status_code=200):
        transport = _RecordingTransport(status_code=status_code, body=body)
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).post_event(
                "3f1c9d40-6f5a-4d2b-9a1e-77c0e2b1a5d3", "assessment.completed",
            )
        return outcome

    async def test_ok_false_with_status_is_a_truthful_refusal(self):
        outcome = await self._post({
            "ok": False, "status": "ignored",
            "ignored_reason": "terminal", "duplicate": True,
        })
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.status, "ignored")
        self.assertEqual(outcome.ignored_reason, "terminal")
        self.assertTrue(outcome.duplicate)
        self.assertIsNone(outcome.error_category)  # NOT malformed_response

    async def test_ok_false_preinsert_refusals_carry_their_status(self):
        for status in ("assessment_missing", "attempt_required"):
            outcome = await self._post({"ok": False, "status": status})
            self.assertFalse(outcome.ok)
            self.assertEqual(outcome.status, status)
            self.assertIsNone(outcome.error_category)

    async def test_genuinely_malformed_bodies_stay_malformed(self):
        for body in ("not-a-dict", {}, {"ok": False}, {"ok": False, "status": 7}):
            outcome = await self._post(body)
            self.assertFalse(outcome.ok)
            self.assertEqual(outcome.error_category, "malformed_response")

    async def test_ok_true_path_is_unchanged(self):
        outcome = await self._post({"ok": True, "status": "applied"})
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.status, "applied")


class TestTerminalPostRetryStops(unittest.IsolatedAsyncioTestCase):
    class _ScriptedEvents:
        def __init__(self, outcomes):
            self.outcomes = list(outcomes)
            self.calls = 0

        async def post_event(self, attempt_id, event_type):
            self.calls += 1
            return self.outcomes[min(self.calls - 1, len(self.outcomes) - 1)]

    async def test_ignored_status_stops_the_loop_immediately(self):
        events = self._ScriptedEvents([
            phone.PhoneApiOutcome(False, "ignored", ignored_reason="terminal"),
        ])
        outcome = await agent_mod._post_phone_event_with_retry(
            events, "attempt", "assessment.completed",
            attempts=3, delay_sec=0.0,
        )
        self.assertEqual(events.calls, 1)
        self.assertEqual(outcome.status, "ignored")

    async def test_retryable_refusals_still_spend_every_attempt(self):
        events = self._ScriptedEvents([
            phone.PhoneApiOutcome(False, "assessment_missing"),
        ])
        await agent_mod._post_phone_event_with_retry(
            events, "attempt", "assessment.completed",
            attempts=3, delay_sec=0.0,
        )
        self.assertEqual(events.calls, 3)

    async def test_ok_still_returns_first(self):
        events = self._ScriptedEvents([phone.PhoneApiOutcome(True, "applied")])
        outcome = await agent_mod._post_phone_event_with_retry(
            events, "attempt", "assessment.completed",
            attempts=3, delay_sec=0.0,
        )
        self.assertEqual(events.calls, 1)
        self.assertTrue(outcome.ok)

    async def test_t4b_row_pending_refusal_logs_info_not_warn_then_succeeds(self):
        # T4(b) POLL-THEN-EMIT (Call D): the row is not written on the first two
        # posts (`assessment_missing` — the pre-insert interlock), then lands.
        # Each pending post is a BENIGN poll: it must log at INFO under
        # `terminal_row_pending`, NOT warn ~5 times before self-heal.
        events = self._ScriptedEvents([
            phone.PhoneApiOutcome(False, "assessment_missing"),
            phone.PhoneApiOutcome(False, "assessment_missing"),
            phone.PhoneApiOutcome(True, "applied"),
        ])
        from unittest.mock import MagicMock
        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy):
            outcome = await agent_mod._post_phone_event_with_retry(
                events, "attempt", "assessment.completed",
                attempts=3, delay_sec=0.0,
            )
        self.assertTrue(outcome.ok)
        pending_info = [
            c for c in spy.info.call_args_list
            if c.kwargs.get("error_category") == "terminal_row_pending"
        ]
        self.assertEqual(len(pending_info), 2)
        # A row-pending refusal is NEVER a warn.
        pending_warn = [
            c for c in spy.warn.call_args_list
            if c.kwargs.get("error_category") in {"assessment_missing", "attempt_required"}
        ]
        self.assertEqual(pending_warn, [])

    async def test_t4b_a_genuine_failure_still_warns(self):
        # A non-pending, non-ignored failure (e.g. a transport/other status) still
        # WARNs — the fix narrows ONLY the two pre-insert refusals.
        events = self._ScriptedEvents([
            phone.PhoneApiOutcome(False, "plan_incomplete"),
        ])
        from unittest.mock import MagicMock
        spy = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", spy):
            await agent_mod._post_phone_event_with_retry(
                events, "attempt", "assessment.completed",
                attempts=2, delay_sec=0.0,
            )
        warned = [
            c for c in spy.warn.call_args_list
            if c.kwargs.get("error_type") == "phone_terminal_post_retry"
            and c.kwargs.get("error_category") == "plan_incomplete"
        ]
        self.assertTrue(warned)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
