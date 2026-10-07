"""R1's modules and tests must actually ship, and CI must actually run them.

Two failures here are silent, which is why they get tests of their own:

* a file that was never ``git add``-ed is simply absent from a ``git commit -a`` squash, and
  nothing fails (``test_r1_routing.py`` holds the only entrypoint routing and refuse-path
  tests; its absence would pass CI);
* a test module that no CI step names can skip itself (``test_r1_sdk_contract`` needs the
  SDK, ``test_r1_routing`` cannot run under it) and the plain discover step reports a skip
  as a pass.

These checks read the checkout, so they skip rather than fail where it is not one.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]  # app/voice-livekit
ROOT = HERE.parents[1]  # the repository root
QUALITY = ROOT / ".github" / "workflows" / "quality.yml"
THIS = Path(__file__).stem
R1_TEST_MODULES = sorted(path.stem for path in (HERE / "tests").glob("test_r1_*.py"))
R1_MODULES = sorted(path.stem for path in HERE.glob("r1_*.py"))
# What a step needs in order to fail on a skip: both of unittest's own skip markers.
SKIP_GUARD = (r"\.\.\. skipped", "skipped=[0-9]+")


def quality_steps() -> dict[str, str]:
    """Map each named step of quality.yml to its text (steps are the 6-space ``- name:``)."""
    if not QUALITY.is_file():
        raise unittest.SkipTest("quality.yml is not part of this checkout")
    parts = re.split(r"^      - name: ", QUALITY.read_text(encoding="utf-8"), flags=re.M)
    steps: dict[str, str] = {}
    for part in parts[1:]:
        # A comment above the NEXT step lands at the tail of this one: only code counts.
        code = [line for line in part.splitlines() if not line.lstrip().startswith("#")]
        steps[code[0].strip()] = "\n".join(code)
    return steps


def guarded_modules() -> set[str]:
    """Test modules named by a CI step that fails the build when any test is skipped."""
    named: set[str] = set()
    for text in quality_steps().values():
        if all(marker in text for marker in SKIP_GUARD):
            named.update(re.findall(r"tests\.(test_r1_\w+)", text))
    return named


class TestR1TestsShipAndRun(unittest.TestCase):
    def test_the_scan_sees_the_modules_it_is_about(self) -> None:
        # Not vacuous: the files the round-5 review found untracked are among them.
        self.assertLessEqual(
            {"test_r1_core", "test_r1_fences", "test_r1_routing", "test_r1_sdk_contract"},
            set(R1_TEST_MODULES),
        )
        self.assertLessEqual({"r1_session", "r1_routing"}, set(R1_MODULES))

    def test_every_r1_test_module_is_run_by_a_step_that_fails_on_a_skip(self) -> None:
        guarded = guarded_modules()
        unguarded = set(R1_TEST_MODULES) - guarded - {THIS}
        self.assertEqual(
            unguarded,
            set(),
            "no quality.yml step with a skip guard names these R1 test modules, so a skip "
            "(or a missing file) would pass CI silently",
        )
        self.assertEqual(guarded - set(R1_TEST_MODULES), set(), "a CI step names a missing module")

    def test_the_routing_tests_have_their_own_bare_python_step(self) -> None:
        # They skip themselves under the SDK venv (the phone fixtures cannot import there),
        # so only a bare-python step can guard them.
        steps = {
            name: text for name, text in quality_steps().items() if "tests.test_r1_routing" in text
        }
        self.assertEqual(len(steps), 1, sorted(steps))
        (text,) = steps.values()
        self.assertIn("python3 -m unittest tests.test_r1_routing", text)
        self.assertNotIn("venv", text)

    def test_every_r1_module_is_compiled_by_ci(self) -> None:
        compile_steps = [
            text for name, text in quality_steps().items() if "py_compile" in text
        ]
        self.assertTrue(compile_steps)
        for module in R1_MODULES:
            with self.subTest(module=module):
                self.assertTrue(
                    any(f"app/voice-livekit/{module}.py" in text for text in compile_steps),
                    f"{module}.py is not in the py_compile step of quality.yml",
                )

    def test_the_dockerfile_ships_every_r1_module_on_the_one_hosting_contract_line(self) -> None:
        # ``validate-hosting-foundation`` matches /^COPY agent\.py .*\.\/$/m, so the worker COPY
        # must stay ONE line.  A module the worker imports but this line lacks crashes the
        # image at the first R1 room, and a module nothing imports yet would never be noticed.
        dockerfile = (HERE / "Dockerfile").read_text(encoding="utf-8").replace("\r\n", "\n")
        copy_lines = re.findall(r"^COPY agent\.py .*\./$", dockerfile, flags=re.M)
        self.assertEqual(len(copy_lines), 1, copy_lines)
        shipped = set(copy_lines[0].split()[1:-1])
        self.assertLessEqual({"r1_session.py", "r1_replies.py", "r1_roleplay.py"}, shipped)
        for module in R1_MODULES:
            with self.subTest(module=module):
                self.assertIn(f"{module}.py", shipped)

    def test_no_r1_module_or_test_is_left_untracked(self) -> None:
        git = shutil.which("git")
        if git is None:
            self.skipTest("git is not available")
        inside = subprocess.run(
            [git, "-C", str(ROOT), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
        )
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            self.skipTest("not a git checkout")
        listed = subprocess.run(
            [git, "-C", str(ROOT), "ls-files", "--others", "--exclude-standard", "--",
             "app/voice-livekit"],
            capture_output=True,
            text=True,
            check=True,
        )
        untracked = [
            path
            for path in listed.stdout.splitlines()
            if re.fullmatch(r"app/voice-livekit/(tests/test_r1_\w+|r1_\w+)\.py", path)
        ]
        self.assertEqual(
            untracked,
            [],
            "untracked R1 files are dropped by `git commit -a`: git add them before the squash",
        )


if __name__ == "__main__":
    unittest.main()
