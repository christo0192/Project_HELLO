"""Plan section 9 fence 10: ``r1_*.py`` log only through ``StructuredLogger``.

The fence says R1 modules use ``StructuredLogger`` (never stdlib ``logging`` or ``print``)
and never log utterances, first names or presigned URLs.  Two kinds of evidence:

* a static scan of every ``r1_*.py`` module, so a new module or a new log call that breaks
  the fence fails here rather than in review;
* a dynamic run in which every failure path raises an exception whose MESSAGE carries a
  poisoned utterance, first name and presigned URL, and the captured log lines are checked
  for the poison.
"""
from __future__ import annotations

import ast
import json
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import observability
import r1_persistence
import r1_session
from r1_persistence import R1TurnWriter
from tests.test_r1_core import (
    ROOM_NAME,
    SESSION_ID,
    Clock,
    FakeContext,
    FakeParticipant,
    FakeSession,
    FakeWriter,
    capture_r1_logs,
    final_event,
)

R1_MODULES = sorted(HERE.glob("r1_*.py"))
LOG_METHODS = {"debug", "info", "warn", "error"}
# Names that carry candidate speech, identity or a URL: never a log value.
FORBIDDEN_VALUE_NAMES = {
    "text",
    "transcript",
    "utterance",
    "first_name",
    "url",
    "presigned",
    "message",
    "body",
    "content",
    "args",
    "context",
}
# The only names an f-string log value may interpolate: fixed labels and result kinds.
FSTRING_NAMES = {"outcome", "expected_status", "result", "kind", "getattr"}

POISON_UTTERANCE = "Quokka-utterance-7731"
POISON_NAME = "Zanzibarella"
POISON_URL = "https://r2.example.test/bucket/key?X-Amz-Signature=deadbeefcafe"
POISONS = (POISON_UTTERANCE, POISON_NAME, "X-Amz-Signature", "r2.example.test")


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _log_calls(tree: ast.Module) -> list[ast.Call]:
    calls = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in LOG_METHODS
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "_log"
        ):
            calls.append(node)
    return calls


class TestStaticFence(unittest.TestCase):
    """Every R1 module is scanned; the scan itself must not be vacuous."""

    def test_the_scan_covers_the_modules_that_log(self) -> None:
        names = {path.name for path in R1_MODULES}
        self.assertLessEqual(
            {"r1_session.py", "r1_persistence.py", "r1_context.py", "r1_llm.py"}, names
        )
        logging_modules = {path.name for path in R1_MODULES if _log_calls(_parse(path))}
        self.assertEqual(logging_modules, {"r1_session.py", "r1_persistence.py"})

    def test_no_r1_module_uses_stdlib_logging_print_or_tracebacks(self) -> None:
        for path in R1_MODULES:
            tree = _parse(path)
            with self.subTest(module=path.name):
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        banned = {"logging", "traceback", "warnings"}
                        self.assertFalse(banned & {alias.name for alias in node.names}, node.lineno)
                    if isinstance(node, ast.ImportFrom):
                        self.assertNotIn(node.module, {"logging", "traceback", "warnings"})
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                        self.assertNotEqual(node.func.id, "print", node.lineno)
                    if isinstance(node, ast.Attribute):
                        # logging.getLogger / logger.exception / traceback.print_exc and friends
                        self.assertNotIn(node.attr, {"getLogger", "print_exc", "format_exc"})
                    if isinstance(node, ast.Name):
                        self.assertNotEqual(node.id, "_LOG", node.lineno)

    def test_no_r1_module_registers_a_job_shutdown_callback(self) -> None:
        """livekit-agents 1.6.4 runs those callbacks only AFTER the entrypoint has ended.

        So a callback can never wake a running interview, and a drain reaches R1 only as
        the entrypoint's cancellation (``test_r1_sdk_contract`` pins the SDK order).  A
        registration anywhere in an R1 module would suggest a drain path that does not
        exist, so this scans every module, not just the one that wires events.
        """
        for path in R1_MODULES:
            with self.subTest(module=path.name):
                for node in ast.walk(_parse(path)):
                    if isinstance(node, ast.Attribute):
                        self.assertNotEqual(node.attr, "add_shutdown_callback", node.lineno)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str):
                        # A getattr(ctx, "add_shutdown_callback") lookup is the same thing.
                        self.assertNotEqual(node.value, "add_shutdown_callback", node.lineno)

    def test_every_logging_module_owns_a_structured_logger(self) -> None:
        for path in R1_MODULES:
            tree = _parse(path)
            if not _log_calls(tree):
                continue
            with self.subTest(module=path.name):
                assigned = [
                    node
                    for node in tree.body
                    if isinstance(node, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "_log" for t in node.targets)
                ]
                self.assertEqual(len(assigned), 1)
                call = assigned[0].value
                self.assertIsInstance(call, ast.Call)
                self.assertEqual(getattr(call.func, "id", None), "StructuredLogger")

    def test_every_log_call_uses_the_event_catalogue_and_allowlisted_keys(self) -> None:
        allowed = observability._ALLOWED_META_KEYS
        for path in R1_MODULES:
            for call in _log_calls(_parse(path)):
                where = f"{path.name}:{call.lineno}"
                with self.subTest(call=where):
                    first = call.args[0] if call.args else None
                    self.assertIsInstance(first, ast.Constant, where)
                    self.assertEqual(first.value, "unknown_event", where)
                    self.assertEqual(len(call.args), 1, where)  # no positional message
                    for keyword in call.keywords:
                        self.assertIn(keyword.arg, allowed, f"{where} {keyword.arg}")
                    self.assertTrue(
                        any(k.arg == "error_type" for k in call.keywords), where
                    )

    def test_no_log_value_can_carry_an_utterance_a_first_name_a_url_or_an_exception_message(
        self,
    ) -> None:
        for path in R1_MODULES:
            for call in _log_calls(_parse(path)):
                for keyword in call.keywords:
                    where = f"{path.name}:{call.lineno} {keyword.arg}"
                    with self.subTest(call=where):
                        self._assert_value_is_safe(keyword.value, where)

    def _assert_value_is_safe(self, value: ast.AST, where: str) -> None:
        for node in ast.walk(value):
            if isinstance(node, ast.Name):
                self.assertNotIn(node.id, FORBIDDEN_VALUE_NAMES, where)
            if isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, FORBIDDEN_VALUE_NAMES | {"__cause__"}, where)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                # str(exc) / repr(exc) would put the exception MESSAGE on the line.
                self.assertNotIn(node.func.id, {"str", "repr", "format"}, where)
            if isinstance(node, ast.FormattedValue):
                names = {n.id for n in ast.walk(node.value) if isinstance(n, ast.Name)}
                self.assertTrue(names <= FSTRING_NAMES, f"{where} {names}")


class TestDynamicFence(unittest.IsolatedAsyncioTestCase):
    """Poisoned exception messages and speech never reach a captured log line."""

    def assert_clean(self, lines: list[dict]) -> None:
        self.assertTrue(lines, "the scenario must actually log something")
        blob = json.dumps(lines)
        for poison in POISONS:
            self.assertNotIn(poison, blob)
        for line in lines:
            self.assertEqual(line["component"], "r1")
            self.assertEqual(line["event"], "unknown_event")

    async def test_every_failure_path_logs_types_and_labels_only(self) -> None:
        order: list = []
        ctx = FakeContext(order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        ctx.delete_error = RuntimeError(f"{POISON_NAME} {POISON_URL}")
        session = FakeSession(log=order)

        async def failing_close() -> None:
            raise RuntimeError(POISON_UTTERANCE)

        session.aclose = failing_close
        writer = FakeWriter(order)
        writer.save_error = RuntimeError(f"{POISON_UTTERANCE} {POISON_URL}")
        interview = r1_session.R1Interview(
            ctx,
            {"first_name": POISON_NAME, "candidate_identity": "candidate"},
            session,
            writer,
            clock=Clock(),
        )
        interview.wire_events()
        ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        interview.machine.transition(r1_session.R1Phase.OPENING)
        interview.machine.transition(r1_session.R1Phase.ICEBREAKER)

        async def failing_attributes(_attributes) -> None:
            raise RuntimeError(f"{POISON_NAME}")

        ctx.room.local_participant.set_attributes = failing_attributes
        with capture_r1_logs() as lines:
            session.emit("user_input_transcribed", final_event(POISON_UTTERANCE))
            await interview.say("L-SIL-IB")  # the bot row write fails too
            await interview._drain_background()
            await interview._exit("provider_error")
        self.assert_clean(lines)
        kinds = {line["error_type"] for line in lines}
        self.assertLessEqual(
            {
                "r1_transcript_write_failed",
                "r1_phase_ended_failed",
                "r1_session_close_failed",
                "r1_room_delete_failed",
            },
            kinds,
        )

    async def test_a_runtime_failure_logs_the_type_and_never_a_traceback(self) -> None:
        order: list = []
        ctx = FakeContext(order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        session = FakeSession(log=order)
        writer = FakeWriter(order)
        interview = r1_session.R1Interview(
            ctx,
            {"first_name": POISON_NAME, "candidate_identity": "candidate"},
            session,
            writer,
            clock=Clock(),
        )

        async def broken_start() -> None:
            raise ValueError(f"{POISON_UTTERANCE} {POISON_URL}")

        interview._start = broken_start
        with capture_r1_logs() as lines:
            outcome = await interview.run()
        self.assertEqual(outcome, "provider_error")
        self.assert_clean(lines)
        self.assertIn("r1_runtime_failure", {line["error_type"] for line in lines})

    async def test_the_persistence_failures_log_a_status_or_a_type_only(self) -> None:
        def requester(*_args):
            raise HTTPError(POISON_URL, 500, f"{POISON_UTTERANCE}", {}, None)

        def unreachable(*_args):
            raise OSError(f"{POISON_NAME} {POISON_URL}")

        http_failure = R1TurnWriter(SESSION_ID, ROOM_NAME, attempt_id="a", requester=requester)
        network_failure = R1TurnWriter(
            SESSION_ID, ROOM_NAME, attempt_id="a", requester=unreachable
        )
        sessionless = R1TurnWriter(None, ROOM_NAME)
        with capture_r1_logs() as lines:
            await http_failure.attempt_outcome("complete")
            await network_failure.attempt_outcome("complete")
            await sessionless.terminal("complete", 1)
            await sessionless.usage_disconnect(1)
        self.assert_clean(lines)
        statuses = [line.get("status") for line in lines]
        self.assertIn(500, statuses)

    def test_the_persistence_module_shares_the_r1_component(self) -> None:
        self.assertEqual(r1_persistence._log._component, "r1")
        self.assertEqual(r1_session._log._component, "r1")


if __name__ == "__main__":
    unittest.main()
