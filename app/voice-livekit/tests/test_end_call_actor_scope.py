"""`is_explicit_end_call_request` — a request, not a vocabulary match.

A match here is TERMINAL: the compliance closing is spoken, the call is hung
up, and the screening is recorded as candidate-ended. So this suite is built
around one asymmetry, stated once and applied throughout:

  * A MISSED REQUEST is a compliance failure. We kept calling somebody who
    asked us to stop. These are `must_fire` and there is no acceptable count
    above zero.
  * A FALSE POSITIVE costs one call and burns a rescreen cycle. Bad, and the
    reason this change exists, but recoverable.

Where the two conflict, the detector fires. The negatives below are therefore
written to be genuinely unambiguous narration — not near-misses chosen to
flatter the implementation.

THE CORPUS IS ROLE-DERIVED, NOT INVENTED. Every negative is a plausible answer
to a question that is live in production today, and the question is named in a
comment beside it. That matters because the defect was never "somebody said a
weird thing" — it was that four of five shipped role templates ask questions
whose correct answers contain this vocabulary.

SUBJECT FORMS ARE DELIBERATELY VARIED (I / we / they / he / she / the customer
/ some prospects / my candidate). PR #293 paid for this lesson: a negative
corpus written with ONE subject form inherits the guard's own blind spot and
proves nothing about the others.
"""

import os
import unittest
from unittest import mock

import phone


# ── The real one ─────────────────────────────────────────────────────────
# Verbatim from screening_v2.transcript_turns, 2026-09-16 13:05:56Z — the
# candidate turn that ended Christo's screening at question 6 of 9. It is the
# ONLY candidate turn in the entire production transcript store containing this
# vocabulary, which is why it is pinned by value rather than paraphrased.
CHRISTO_2026_09_16 = (
    "Yeah, so basically if I I have noticed if I if I'm procrastinating a lot "
    "and if I'm not, you know, taking CRM notes right after I disconnect the "
    "call with my candidate, then I will be actually missing out lot of new "
    "answers and all those stuff that is required. And yeah, so so I over the "
    "period of t"
)


class EndCallRegression(unittest.TestCase):
    def test_the_utterance_that_ended_a_live_call_does_not_end_a_call(self):
        self.assertFalse(
            phone.is_explicit_end_call_request(CHRISTO_2026_09_16),
            "the 2026-09-16 regression is back: a candidate describing their CRM "
            "habit was read as asking to hang up",
        )

    def test_that_utterance_still_contains_the_vocabulary(self):
        # Guards the guard. If someone 'fixes' the test by editing the fixture
        # until it no longer says "disconnect the call", the regression above
        # passes while testing nothing at all.
        self.assertIsNotNone(
            phone._END_CALL_ACT_RE.search(CHRISTO_2026_09_16),
            "the regression fixture no longer contains an end-call phrase, so it "
            "cannot be exercising the detector",
        )


class EndCallMustFire(unittest.TestCase):
    """Requests. Every one of these MUST end the call."""

    CASES = (
        # Imperative, bare and softened.
        "Hang up.",
        "Please hang up.",
        "Disconnect please.",
        "Please disconnect the call.",
        "Please disconnect the call, I'm not interested.",
        "Okay disconnect.",
        "Stop the call.",
        "Please stop the call, I am driving.",
        "Just end the call please.",
        # Indian English. The shipped pattern matched NONE of these: "cut the
        # call" was not in it at all, so a consent request went unheard for the
        # life of the feature.
        "Cut the call.",
        "Please cut the call.",
        "Just cut the call please.",
        "Cut the call na.",
        # Addressed to us.
        "Can you hang up now?",
        "Could you please end the call?",
        "You can hang up now.",
        "Can you please disconnect?",
        # First person WITH a volitional modal — the distinction the old
        # pattern could not draw.
        "I want to end this call.",
        "I need to hang up.",
        "I have to disconnect now.",
        "I'd like to end the call please.",
        "I'm going to hang up.",
        "I will have to disconnect, sorry.",
        "Let's end the call here.",
        "Let me hang up, I am in a meeting.",
        # Mid-turn, after other content. A request does not have to lead.
        "Sorry, this is a bad time, please hang up.",
        "I appreciate the call but I need to disconnect now.",
    )

    def test_every_request_fires(self):
        missed = [t for t in self.CASES if not phone.is_explicit_end_call_request(t)]
        self.assertEqual(
            missed, [],
            "COMPLIANCE FAILURE — these are requests to end the call and the "
            "detector stayed silent, so the bot would keep screening:\n  "
            + "\n  ".join(repr(t) for t in missed),
        )


class EndCallMustNotFire(unittest.TestCase):
    """Narration. Every one of these MUST leave the call running."""

    CASES = (
        # ── Sales Program Advisor, Q6 'followup': "How do you organize your
        #    CRM notes, callbacks, and follow-ups across multiple prospects?"
        #    This is the question that killed the 2026-09-16 call.
        "Right after I disconnect, I log the notes in the CRM and set a callback.",
        "As soon as I hang up I update Salesforce with the next step.",
        "I never end the call without agreeing a follow-up date.",
        "Once I cut the call I immediately write the summary.",
        "My process is simple, I hang up and then I log everything.",
        "Immediately after I disconnect the call I set a reminder.",
        # ── Sales PA, Q4 'objection': "how would you handle a hesitant
        #    prospect who is concerned about program fit or value?"
        "If a prospect asks me to disconnect, I respect that and note it.",
        "If they say hang up, I thank them and move on.",
        "When a customer wants to end the call I never push back.",
        "Some prospects just hang up on you and that's part of sales.",
        "He hung up on me twice before he finally listened.",
        "They usually hang up if you push too hard.",
        # ── HR - TA, Q3 'sourcing' and Q4 'screening'. Two of today's five
        #    candidates are on this template.
        "I call the candidate, and if they don't pick up I hang up and try later.",
        "If the candidate asks me to call back I disconnect and reschedule.",
        "She asked me to hang up and call after six.",
        "In my last role I would call twenty people a day and most would hang up.",
        "Typically I end the call once I have the notice period and the CTC.",
        "The candidate hung up midway so I marked it as unreachable.",
        # ── Associate Customer Success, Q4 'atrisk' and Q5 'escalation'.
        "What I do is call them, and if they've gone quiet I hang up and email instead.",
        "The customer was angry so he cut the call before I could explain.",
        "If it needs another team I tell the customer I'll end the call and follow up.",
        "Every time a client goes quiet I call once and then hang up politely.",
        # ── Sales PA Manager, Q3 'coaching' and Q4 'pipeline'.
        "I listen to recordings and tell the advisor when to end the call.",
        "When I coach them I say never disconnect without a next step.",
        "We review calls where the advisor hung up too early.",
        "My advisor will disconnect too early and lose the deal.",
        # ── Generic habitual narration, varied subjects.
        "I usually disconnect after summarising the action items.",
        "We always end the call with a clear next step.",
        "For example, if they ask me to hang up, I do it politely.",
        "The way I handle it is I hang up and send a recap email.",
    )

    def test_no_narration_ends_a_call(self):
        fired = [t for t in self.CASES if phone.is_explicit_end_call_request(t)]
        self.assertEqual(
            fired, [],
            "FALSE END — these describe a past or hypothetical call and the "
            "detector ended the LIVE one:\n  "
            + "\n  ".join(repr(t) for t in fired),
        )


class EndCallVetoesAreLoadBearing(unittest.TestCase):
    """Each veto must be the thing that saves its own case.

    Asserting only the aggregate hides a veto that never fires: another veto
    happens to cover the same sentence and the dead one looks alive. Each case
    below is chosen so that ONE veto is the difference.
    """

    def test_conditional_veto_same_clause(self):
        # The conditional and the act in ONE clause, so the frame-inheritance
        # path cannot be what saves it. Mutation-derived: "If needed,
        # disconnect the call." was rescued by inheritance and therefore did
        # NOT pin this branch.
        self.assertFalse(phone.is_explicit_end_call_request(
            "Disconnect the call if needed."))

    def test_conditional_frame_is_inherited_forward(self):
        # The frame opens in clause 1, a subjectless clause follows, and the
        # act lands in clause 3. Resetting the frame per clause makes the last
        # clause a bare imperative and ends the call.
        self.assertFalse(phone.is_explicit_end_call_request(
            "If the customer is rude, I stay calm, disconnect the call."))

    def test_reported_speech_veto(self):
        self.assertFalse(phone.is_explicit_end_call_request(
            "She said disconnect the call."))

    def test_other_actor_veto(self):
        self.assertFalse(phone.is_explicit_end_call_request(
            "The customer will disconnect the call."))

    def test_habitual_first_person_veto(self):
        # "just" is one of the imperative's own boundary words, so without the
        # habitual veto this parses as a bare order. "I disconnect the call"
        # does NOT discriminate — no trigger matches it either way.
        self.assertFalse(phone.is_explicit_end_call_request(
            "I usually just hang up."))

    def test_habitual_veto_outranks_the_urgency_marker(self):
        # ISOLATES the habitual veto. "hang up NOW" satisfies the strong
        # imperative that lets a request escape an inherited subject, so
        # without the habitual veto this narration ends the call. The simpler
        # "I usually just hang up" does NOT isolate it — the inherited-subject
        # rule alone already stops that one.
        self.assertFalse(phone.is_explicit_end_call_request(
            "I usually hang up now and write the summary."))
        self.assertFalse(phone.is_explicit_end_call_request(
            "We end the call now and send the recap."))

    def test_conditional_frame_survives_an_intervening_clause(self):
        # ISOLATES frame inheritance. The frame opens in clause 1, clause 2
        # establishes no subject at all, and the act lands in clause 3 — so
        # neither subject inheritance nor the per-clause conditional check can
        # be what saves it. Stilted on purpose: the job of this input is to
        # isolate one branch, not to be a likely sentence.
        self.assertFalse(phone.is_explicit_end_call_request(
            "If needed, no problem, disconnect the call."))
        self.assertFalse(phone.is_explicit_end_call_request(
            "When that happens, okay, disconnect the call."))

    def test_subject_is_inherited_across_coordination(self):
        # English elides the subject in a coordinated verb phrase: this means
        # "...and then I hang up". Splitting on `and`/`then` severs it, and the
        # tail reads as an imperative. A textbook answer to the Sales-advisor
        # CRM question, and it ended a live call in the first draft of this fix.
        self.assertFalse(phone.is_explicit_end_call_request(
            "I take notes and then hang up."))

    def test_inherited_subject_still_yields_to_an_explicit_request(self):
        # Inheritance must not swallow a real request that follows narration.
        self.assertTrue(phone.is_explicit_end_call_request(
            "I take notes, please hang up now."))

    def test_meta_turn_veto(self):
        # `for example` is the only thing standing between this and a fire:
        # the clause itself is a bare imperative.
        self.assertFalse(phone.is_explicit_end_call_request(
            "For example, disconnect the call."))

    def test_modal_beats_habitual(self):
        # The pair that proves ORDER matters. Same subject, same verb; only
        # the modal differs, and the volitional check must be consulted first.
        self.assertTrue(phone.is_explicit_end_call_request("I want to disconnect the call."))
        self.assertFalse(phone.is_explicit_end_call_request("I disconnect the call."))


class EndCallClauseScope(unittest.TestCase):
    """Actor framing is per-CLAUSE; meta-discourse is per-TURN."""

    def test_a_request_survives_narration_earlier_in_the_turn(self):
        # THE case a turn-wide actor veto gets wrong. The first clause is
        # narration and would veto the whole turn; the second is a real
        # request and must still be honoured.
        self.assertTrue(phone.is_explicit_end_call_request(
            "I usually hang up after taking notes, but please disconnect now."))

    def test_narration_after_a_request_does_not_cancel_it(self):
        self.assertTrue(phone.is_explicit_end_call_request(
            "Please hang up, I always finish my notes afterwards anyway."))

    def test_two_actors_in_two_clauses(self):
        # Neither clause is a request: one is conditional, one is habitual.
        self.assertFalse(phone.is_explicit_end_call_request(
            "If they hang up, I disconnect and log it."))


class EndCallKillSwitch(unittest.TestCase):
    """`PHONE_END_CALL_DETECT=off` must disarm, and nothing else may."""

    def test_off_disarms(self):
        with mock.patch.dict(os.environ, {"PHONE_END_CALL_DETECT": "off"}):
            self.assertFalse(phone.is_explicit_end_call_request("Please hang up."))

    def test_off_is_case_and_space_insensitive(self):
        for value in ("OFF", " off ", "Off"):
            with mock.patch.dict(os.environ, {"PHONE_END_CALL_DETECT": value}):
                self.assertFalse(
                    phone.is_explicit_end_call_request("Please hang up."),
                    f"{value!r} should disarm",
                )

    def test_nothing_else_disarms(self):
        # OFF is the UNSAFE direction, so only the literal word may reach it.
        # "false"/"0"/"no" are the values an operator most plausibly types by
        # analogy with other flags, and they must NOT silently stop the bot
        # honouring hang-up requests.
        for value in ("false", "0", "no", "disabled", "", "true", "on"):
            with mock.patch.dict(os.environ, {"PHONE_END_CALL_DETECT": value}):
                self.assertTrue(
                    phone.is_explicit_end_call_request("Please hang up."),
                    f"{value!r} must NOT disarm the detector",
                )

    def test_absent_env_is_armed(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(phone.is_explicit_end_call_request("Please hang up."))


class EndCallInputHandling(unittest.TestCase):
    def test_non_strings_and_empties(self):
        for value in (None, 123, [], {}, object(), "", "   ", "\n\t "):
            self.assertFalse(
                phone.is_explicit_end_call_request(value),
                f"{value!r} must not end a call",
            )

    def test_long_input_is_bounded_and_still_correct(self):
        # The bound must not swallow a request that fits inside it.
        padding = "I discussed the role and the team and the timeline. " * 20
        self.assertTrue(phone.is_explicit_end_call_request(padding + "Please hang up."))

    def test_request_beyond_the_bound_is_not_scanned(self):
        # Stated so the trade-off is deliberate and visible rather than
        # discovered: past _END_CALL_MAX_CHARS we stop looking. A turn that
        # long is not a hang-up request in practice, and an unbounded scan on
        # the worker's hot path is the worse risk.
        far = "x " * phone._END_CALL_MAX_CHARS
        self.assertFalse(phone.is_explicit_end_call_request(far + " please hang up"))

    def test_unicode_apostrophe_contractions(self):
        # Speech-to-text emits U+2019, not ASCII "'". A contraction handler
        # that only knows the ASCII form would miss every real transcript.
        self.assertTrue(phone.is_explicit_end_call_request("I’d like to hang up."))
        self.assertTrue(phone.is_explicit_end_call_request("I’m going to hang up."))


if __name__ == "__main__":
    unittest.main()
