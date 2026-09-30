"""Phone-path RNNoise WIRING + build/deploy contract (owner report 2026-09-30).

`noise_suppression.py` (tested in test_noise_suppression.py) decides WHAT the
phone session's inbound-audio options are. This file locks HOW they reach the
call and the image, and it must pass on bare python3 (no livekit, no numpy):

  * the phone `wait_for_participant` computes the options from
    `noise_suppression.phone_room_options()` right before `session.start`, and
    passes `room_options=` ONLY when they are non-None — `None` (the
    PHONE_NOISE_SUPPRESSION=off kill switch, or the library failing to load)
    is byte-for-byte the pre-change start call;
  * the lookup is FAIL-OPEN: an exception there still starts the session;
  * the browser `_run_session` start and the Canary-1 start stay untouched;
  * the Dockerfile installs pyrnnoise==0.4.5 with --no-deps in the builder and
    COPYs noise_suppression.py into the final stage;
  * only the PHONE app enables it: fly.phone.toml sets
    PHONE_NOISE_SUPPRESSION = "rnnoise", fly.toml does not.

The behavioural cases EXECUTE the exact statements from agent.py (extracted by
AST, not re-typed), against fakes, so a drift in the real source is what fails.
"""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import os
import re
import tomllib
import unittest
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
CTX = os.path.dirname(HERE)  # app/voice-livekit
REPO = os.path.dirname(os.path.dirname(CTX))
AGENT_PY = os.path.join(CTX, "agent.py")
CANARY_PY = os.path.join(CTX, "phone_canary.py")
DOCKERFILE = os.path.join(CTX, "Dockerfile")
REQUIREMENTS = os.path.join(CTX, "requirements.txt")
ANALYZER = os.path.join(REPO, "scripts", "docker_import_closure.py")

_NS_VAR = "noise_room_options"


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _find_func(tree: ast.AST, name: str) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"function {name!r} not found")


def _session_start_calls(node: ast.AST) -> list[ast.Call]:
    calls = []
    for sub in ast.walk(node):
        if (
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Attribute)
            and sub.func.attr == "start"
            and isinstance(sub.func.value, ast.Name)
            and sub.func.value.id == "session"
        ):
            calls.append(sub)
    return calls


def _mentions(node: ast.AST, name: str) -> bool:
    return any(isinstance(n, ast.Name) and n.id == name for n in ast.walk(node))


def _wait_for_participant(source: str) -> ast.AsyncFunctionDef:
    tree = ast.parse(source)
    run_phone = _find_func(tree, "_run_phone_session")
    wfp = _find_func(run_phone, "wait_for_participant")
    assert isinstance(wfp, ast.AsyncFunctionDef)
    return wfp


def _wiring_block(source: str) -> list[ast.stmt]:
    """The statements of `wait_for_participant` from the first assignment of
    `noise_room_options` through the `if` that starts the session."""
    body = _wait_for_participant(source).body
    first = last = None
    for index, stmt in enumerate(body):
        if first is None and isinstance(stmt, (ast.Assign, ast.AnnAssign)) and _mentions(stmt, _NS_VAR):
            first = index
        if isinstance(stmt, ast.If) and _mentions(stmt.test, _NS_VAR) and _session_start_calls(stmt):
            last = index
    if first is None or last is None or last < first:
        raise AssertionError("noise-suppression wiring block not found in wait_for_participant")
    return body[first:last + 1]


def _compile_wiring(source: str):
    """Wrap the REAL wiring statements in an async function over fakes."""
    fn = ast.AsyncFunctionDef(
        name="_wired",
        args=ast.arguments(
            posonlyargs=[],
            args=[ast.arg(arg=a) for a in (
                "session", "noise_suppression", "_log", "agent", "ctx", "_PHONE_NO_RECORDING",
            )],
            kwonlyargs=[], kw_defaults=[], defaults=[],
        ),
        body=_wiring_block(source),
        decorator_list=[],
        returns=None,
        type_params=[],
    )
    module = ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[]))
    namespace: dict[str, Any] = {"Any": Any}
    exec(compile(module, AGENT_PY, "exec"), namespace)  # noqa: S102 — our own source
    return namespace["_wired"]


class _FakeSession:
    def __init__(self) -> None:
        self.starts: list[dict[str, Any]] = []

    async def start(self, **kwargs: Any) -> None:
        self.starts.append(kwargs)


class _FakeLog:
    def __init__(self) -> None:
        self.lines: list[tuple[str, str, dict[str, Any]]] = []

    def info(self, event: str, **meta: Any) -> None:
        self.lines.append(("info", event, meta))

    def warn(self, event: str, **meta: Any) -> None:
        self.lines.append(("warn", event, meta))


class _FakeNoise:
    def __init__(self, result: Any = None, exc: BaseException | None = None) -> None:
        self.result = result
        self.exc = exc
        self.calls = 0

    def phone_room_options(self) -> Any:
        self.calls += 1
        if self.exc is not None:
            raise self.exc
        return self.result


_NO_RECORDING = {"audio": False, "transcript": False, "traces": False, "logs": False}


def _run(source: str, noise: _FakeNoise) -> tuple[_FakeSession, _FakeLog]:
    wired = _compile_wiring(source)
    session, log = _FakeSession(), _FakeLog()
    agent, ctx = object(), type("Ctx", (), {"room": object()})()
    asyncio.run(wired(session, noise, log, agent, ctx, _NO_RECORDING))
    return session, log


class TestPhoneStartWiring(unittest.TestCase):
    """The exact agent.py statements, executed against fakes."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = _read(AGENT_PY)

    def test_agent_imports_noise_suppression_at_top_level(self):
        tree = ast.parse(self.source)
        top = {
            alias.name
            for node in tree.body if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertIn("noise_suppression", top)

    def test_options_are_computed_after_the_answer_and_before_start(self):
        body = _wait_for_participant(self.source).body
        text = [ast.unparse(s) for s in body]
        wait_at = next(i for i, t in enumerate(text) if "_wait_for_sip_participant" in t)
        lookup_at = next(i for i, t in enumerate(text) if "phone_room_options()" in t)
        start_at = next(i for i, s in enumerate(body) if _session_start_calls(s))
        self.assertLess(wait_at, lookup_at)
        self.assertLess(lookup_at, start_at)

    def test_none_is_exactly_the_pre_change_start_call(self):
        noise = _FakeNoise(result=None)
        session, _log = _run(self.source, noise)
        self.assertEqual(noise.calls, 1)
        self.assertEqual(len(session.starts), 1)
        kwargs = session.starts[0]
        self.assertEqual(sorted(kwargs), ["agent", "record", "room"])
        self.assertNotIn("room_options", kwargs)
        self.assertEqual(kwargs["record"], _NO_RECORDING)

    def test_non_none_options_are_passed_as_room_options(self):
        sentinel = object()
        session, log = _run(self.source, _FakeNoise(result=sentinel))
        self.assertEqual(len(session.starts), 1)
        kwargs = session.starts[0]
        self.assertIs(kwargs.get("room_options"), sentinel)
        self.assertEqual(sorted(kwargs), ["agent", "record", "room", "room_options"])
        self.assertEqual(kwargs["record"], _NO_RECORDING)
        self.assertIn(
            ("info", "unknown_event",
             {"error_type": "phone_noise_suppression", "error_category": "applied"}),
            log.lines,
        )

    def test_lookup_failure_is_fail_open_and_logged(self):
        session, log = _run(self.source, _FakeNoise(exc=RuntimeError("boom")))
        self.assertEqual(len(session.starts), 1, "the call must still start")
        self.assertNotIn("room_options", session.starts[0])
        self.assertIn(
            ("warn", "unknown_event",
             {"error_type": "phone_noise_suppression", "error_category": "options_failed"}),
            log.lines,
        )

    def test_record_kwarg_is_unchanged_in_both_branches(self):
        # The recording-off contract (phone.PHONE_NO_RECORDING) must not be
        # dropped by the branch that adds room_options.
        starts = _session_start_calls(ast.Module(body=_wiring_block(self.source), type_ignores=[]))
        self.assertEqual(len(starts), 2)
        for call in starts:
            record = [k for k in call.keywords if k.arg == "record"]
            self.assertEqual(len(record), 1)
            self.assertEqual(ast.unparse(record[0].value), "dict(_PHONE_NO_RECORDING)")

    def test_NEGATIVE_CONTROL_unconditional_room_options_goes_red(self):
        # A regression that always passes room_options (so None reaches the
        # SDK) must be caught by the None-branch case above.
        mutated = self.source.replace(
            f"if {_NS_VAR} is None:", f"if {_NS_VAR} is None and False:", 1,
        )
        self.assertNotEqual(mutated, self.source, "mutation target missing")
        session, _log = _run(mutated, _FakeNoise(result=None))
        self.assertIn("room_options", session.starts[0])

    def test_lookup_is_guarded_by_except_exception(self):
        # Without the try/except a failing lookup would propagate and the call
        # would never start — the fail-open case above executes that path; this
        # pins its shape (a broad `except Exception`, not a narrower class).
        block = _wiring_block(self.source)
        self.assertTrue(
            any(
                isinstance(s, ast.Try)
                and any(_mentions(h.type, "Exception") for h in s.handlers if h.type)
                and "phone_room_options" in ast.unparse(s.body[0])
                for s in block
            ),
            "phone_room_options() must be called inside `except Exception`",
        )


class TestOtherStartsUntouched(unittest.TestCase):
    """Browser and Canary-1 sessions keep the SDK-default room options."""

    def test_browser_session_start_has_no_room_options(self):
        tree = ast.parse(_read(AGENT_PY))
        starts = _session_start_calls(_find_func(tree, "_run_session"))
        self.assertTrue(starts)
        for call in starts:
            self.assertNotIn("room_options", {k.arg for k in call.keywords})

    def test_only_the_phone_answer_path_passes_room_options(self):
        tree = ast.parse(_read(AGENT_PY))
        wfp = _find_func(_find_func(tree, "_run_phone_session"), "wait_for_participant")
        inside = {id(c) for c in _session_start_calls(wfp)}
        self.assertEqual(len(inside), 2)
        for call in _session_start_calls(tree):
            if "room_options" in {k.arg for k in call.keywords}:
                self.assertIn(id(call), inside, "room_options passed outside the phone path")

    def test_canary_session_start_has_no_room_options(self):
        tree = ast.parse(_read(CANARY_PY))
        starts = _session_start_calls(tree)
        self.assertTrue(starts)
        for call in starts:
            self.assertNotIn("room_options", {k.arg for k in call.keywords})


def _load_analyzer():
    spec = importlib.util.spec_from_file_location("docker_import_closure", ANALYZER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestImagePackaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dockerfile = _read(DOCKERFILE)
        # Split at FROM: stage 0 is the builder, the last stage is the image.
        parts = re.split(r"(?m)^FROM\s", cls.dockerfile)
        cls.builder, cls.runtime = parts[1], parts[-1]

    def test_builder_installs_pinned_pyrnnoise_without_deps(self):
        run_lines = [
            line.strip() for line in self.builder.splitlines()
            if "pyrnnoise" in line and not line.lstrip().startswith("#")
        ]
        self.assertEqual(len(run_lines), 1, run_lines)
        line = run_lines[0]
        self.assertTrue(line.startswith("RUN /opt/venv/bin/pip install"), line)
        self.assertIn("--no-deps", line)
        self.assertIn("--no-cache-dir", line)
        self.assertIn("pyrnnoise==0.4.5", line)

    def test_runtime_stage_does_not_install_packages(self):
        self.assertNotIn("pip install", self.runtime)

    def test_requirements_do_not_install_pyrnnoise_with_its_deps(self):
        lines = [
            line.strip() for line in _read(REQUIREMENTS).splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        self.assertFalse(any(line.lower().startswith("pyrnnoise") for line in lines))

    def test_final_stage_copies_noise_suppression(self):
        dic = _load_analyzer()
        result = dic.analyze(CTX)
        self.assertIn("noise_suppression", result["closure"])
        self.assertEqual(result["missing"], [])
        final_copies = dic.parse_stages(self.dockerfile)[-1]["copies"]
        self.assertIn(
            "noise_suppression.py",
            {src for srcs, _dest, _wd in final_copies for src in srcs},
        )

    def test_NEGATIVE_CONTROL_dropping_the_copy_is_missing_from_the_closure(self):
        dic = _load_analyzer()
        mutated = self.dockerfile.replace(
            "COPY agent.py closing.py noise_suppression.py ", "COPY agent.py closing.py ", 1,
        )
        self.assertNotEqual(mutated, self.dockerfile)
        final_copies = dic.parse_stages(mutated)[-1]["copies"]
        copied = {src for srcs, _dest, _wd in final_copies for src in srcs}
        self.assertNotIn("noise_suppression.py", copied)
        # ...while still being on the import closure, so analyze() would flag it.
        self.assertIn("noise_suppression", dic.analyze(CTX)["closure"])


class TestDeployManifests(unittest.TestCase):
    @staticmethod
    def _env(name: str) -> dict:
        with open(os.path.join(CTX, name), "rb") as handle:
            return tomllib.load(handle).get("env", {})

    def test_phone_app_enables_rnnoise(self):
        self.assertEqual(self._env("fly.phone.toml").get("PHONE_NOISE_SUPPRESSION"), "rnnoise")

    def test_browser_app_does_not_set_it(self):
        self.assertNotIn("PHONE_NOISE_SUPPRESSION", self._env("fly.toml"))


if __name__ == "__main__":
    unittest.main()
