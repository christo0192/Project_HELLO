import unittest

from closing import ClosingState, ClosingStateMachine


class TestClosingStateMachine(unittest.TestCase):
    def test_complete_path_is_ordered(self):
        machine = ClosingStateMachine()
        machine.plan_completed()
        self.assertEqual(machine.state, ClosingState.WIND_DOWN_PENDING)
        machine.wind_down_delivered()
        self.assertEqual(machine.state, ClosingState.CANDIDATE_QNA)
        machine.candidate_questions_handled()
        self.assertEqual(machine.state, ClosingState.CLOSING_PENDING)
        machine.closing_delivered()
        self.assertEqual(machine.state, ClosingState.CLOSING_PLAYED)

    def test_invalid_transition_fails_closed(self):
        machine = ClosingStateMachine()
        with self.assertRaisesRegex(RuntimeError, "closing_invalid_close_transition"):
            machine.closing_delivered()
        machine.plan_completed()
        with self.assertRaisesRegex(RuntimeError, "closing_invalid_qna_transition"):
            machine.candidate_questions_handled()


if __name__ == "__main__":
    unittest.main()
