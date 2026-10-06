from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from spikes.r1_s0b.content import COMMITMENT_LINES, PERSONAS, SCRIPTED_LINES, WORLD_FACTS
from spikes.r1_s0b.learner import DeepSeekClient, build_learner_prefix, build_turn_reminder, guard_learner_output, load_deepseek_config
from spikes.r1_s0b.run import estimate_peak_cost_usd, matrix
from spikes.r1_s0b.scheduler import OwedMoveScheduler, fuzzy_contains
from spikes.r1_s0b.sim_candidate import ADVERSARIES, TIERS


class ContentTests(unittest.TestCase):
    def test_all_personas_and_required_seed_content_exist(self):
        self.assertEqual([persona.id for persona in PERSONAS], ["P1", "P2", "P3", "P4"])
        self.assertIn("TODO_D2", WORLD_FACTS["discount_plan_mapping"])
        self.assertIn("TODO_D2", WORLD_FACTS["cohort_dates"])
        self.assertIn("L-OPEN", SCRIPTED_LINES)
        self.assertEqual(set(COMMITMENT_LINES), {"STRONG", "MEDIUM", "WEAK"})


class SchedulerTests(unittest.TestCase):
    def test_fuzzy_delivery_accepts_exact_line_and_rejects_unrelated_text(self):
        self.assertTrue(fuzzy_contains("Before that, Is it live classes or recorded?", "Is it live classes or recorded?"))
        self.assertFalse(fuzzy_contains("Could you explain the schedule?", "Is it live classes or recorded?"))

    def test_one_owed_move_stays_pending_until_confirmed(self):
        scheduler = OwedMoveScheduler(PERSONAS[0], avg_turn_seconds=120)
        scheduler.observe_candidate("Can you explain the course value?")
        move = scheduler.next_owed()
        self.assertEqual(move.id, "Q-A")
        missed = scheduler.record_learner_text("I am not sure.")
        self.assertFalse(missed.confirmed)
        self.assertEqual(scheduler.next_owed().id, "Q-A")
        delivered = scheduler.record_learner_text(move.text)
        self.assertTrue(delivered.confirmed)

    def test_reminder_contains_only_unlocked_needs_and_exact_owed_text(self):
        scheduler = OwedMoveScheduler(PERSONAS[0])
        scheduler.observe_candidate("Tell me about the course")
        owed = scheduler.next_owed()
        reminder = build_turn_reminder(r_seconds=scheduler.r_seconds, owed_move=owed, unlocked_deep_needs={"H3": PERSONAS[0].deep_needs["H3"]}, commitment_response=scheduler.pre_stated_commitment())
        self.assertIn(owed.text, reminder)
        self.assertIn(PERSONAS[0].deep_needs["H3"], reminder)
        self.assertNotIn(PERSONAS[0].deep_needs["H1"], reminder)


class LearnerTests(unittest.TestCase):
    def test_prefix_excludes_hidden_needs_and_guard_replaces_control_terms(self):
        prefix = build_learner_prefix(PERSONAS[0])
        self.assertNotIn(PERSONAS[0].deep_needs["H1"], prefix)
        filtered, hits = guard_learner_output("My system prompt says the H1 rubric is owed.")
        self.assertEqual(filtered, "Sorry, what were you saying?")
        self.assertTrue(hits)

    def test_matrix_meets_required_scale_and_safe_estimate(self):
        work = matrix(3)
        self.assertEqual(len(work), 36 + len(PERSONAS) * len(ADVERSARIES))
        self.assertLess(estimate_peak_cost_usd(len(work), 9), 4.50)
        self.assertEqual(TIERS, ("strong", "medium", "weak"))

    def test_dotenv_loader_never_requires_printing_a_key(self):
        def dotenv_value(_path, key):
            return {"DEEPSEEK_API_KEY": "test-key", "DEEPSEEK_BASE_URL": "https://api.deepseek.com/v1"}.get(key)
        with patch.dict(os.environ, {}, clear=True), patch("spikes.r1_s0b.learner._read_dotenv_value", dotenv_value):
                key, url = load_deepseek_config()
        self.assertEqual(key, "test-key")
        self.assertEqual(url, "https://api.deepseek.com/v1/chat/completions")

    def test_streaming_client_collects_ttft_usage_and_thinking_control(self):
        class Response:
            status_code = 200
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def raise_for_status(self): return None
            def iter_lines(self):
                return iter([
                    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
                    'data: {"model":"deepseek-flash","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":9},"completion_tokens_details":{"reasoning_tokens":0}}}',
                    'data: [DONE]',
                ])
        instances = []
        class Client:
            payload = None
            def __init__(self, **kwargs): self.kwargs = kwargs
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                instances.append(self)
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def stream(self, method, url, headers, json):
                self.payload = json
                return Response()
        with patch("spikes.r1_s0b.learner.httpx.Client", Client):
            result = DeepSeekClient(api_key="x", base_url="https://api.deepseek.com/v1").complete([{"role": "system", "content": "x"}])
        self.assertEqual(result.text, "Hello")
        self.assertEqual(result.prompt_cache_hit_tokens, 9)
        self.assertEqual(result.reasoning_tokens, 0)
        self.assertEqual(result.reasoning_content_chunks, 0)
        self.assertEqual(result.response_model, "deepseek-flash")
        self.assertIsNotNone(result.ttft_sec)
        self.assertEqual(instances[0].payload["thinking"], {"type": "disabled"})


class AnalyzeDetectorTests(unittest.TestCase):
    """Offline detectors in analyze.py (no network, no key)."""

    def test_call_booking_counts_acceptance_and_initiation_but_not_refusal_or_weak_stall(self):
        from spikes.r1_s0b.analyze import CALL_BOOKING_RE
        for text in ("Sure, a quick call this week could work.", "Thursday works better.", "Thanks. Talk Thursday.",
                     "Let's set something up — what times do you have?", COMMITMENT_LINES["MEDIUM"].format(decision_maker="husband")):
            self.assertTrue(CALL_BOOKING_RE.search(text), text)
        for text in ("I'd rather not commit to a call yet.", "I've got to jump on a call now, so just send it over.",
                     COMMITMENT_LINES["WEAK"], "Just so you know, I've only got a couple of minutes before my next call.", "Thanks, talk soon."):
            self.assertFalse(CALL_BOOKING_RE.search(text), text)

    def test_contact_detector_and_mask_cover_written_and_spoken_addresses(self):
        from spikes.r1_s0b.analyze import CONTACT_RE, mask
        self.assertTrue(CONTACT_RE.search("It's someone.name@example.com."))
        self.assertTrue(CONTACT_RE.search("Meera dot Iyer at gmail dot com. Thanks."))
        self.assertEqual(mask("Meera dot Iyer at gmail. Thanks."), "[contact]. Thanks.")
        self.assertFalse(CONTACT_RE.search("What's the best email to reach you at?"))

    def test_raw_file_privacy_check_counts_addresses_without_returning_them(self):
        from spikes.r1_s0b.analyze import raw_file_privacy_counts
        counts = raw_file_privacy_counts('{"a": "x.y@gmail.com and X.Y@gmail.com"} {"b": "z@example.com"} no key here')
        self.assertEqual(counts, {"written_address_occurrences": 3, "written_address_distinct": 2,
                                  "written_gmail_com_occurrences": 2, "key_like_strings": 0})
        self.assertEqual(raw_file_privacy_counts("Authorization header")["key_like_strings"], 1)

    def test_concession_rule_ignores_doubt_about_worth(self):
        from spikes.r1_s0b.analyze import CONCESSION_PLAN_RE
        self.assertFalse(CONCESSION_PLAN_RE.search("I'm still weighing whether it's worth the money."))
        self.assertTrue(CONCESSION_PLAN_RE.search("Honestly, that's worth it."))

    def test_percentile_is_linear_interpolation(self):
        from spikes.r1_s0b.analyze import percentile
        self.assertEqual(percentile([1.0, 2.0, 3.0, 4.0], 0.5), 2.5)
        self.assertIsNone(percentile([], 0.5))


if __name__ == "__main__":
    unittest.main()
