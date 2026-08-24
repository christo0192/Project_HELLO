"""Static Docker-packaging tests — the runtime image ships every first-party
module the entrypoint imports, and ships it where the interpreter looks.

Regression origin (PR102): project-hello-voice v40 ran `python agent.py start`
and crashed with `ModuleNotFoundError: No module named 'phone'`. P4a added
`import phone` to agent.py but the Dockerfile COPY list was not updated, so
phone.py never entered the image.

These tests exercise `scripts/docker_import_closure.py` — the SAME analyzer
`scripts/validate-container.sh` runs in CI, not a second copy of it, so a
mutation control here is a control on the shipped gate. They pin four
properties of the real Dockerfile and prove each one non-vacuously:

  1. the closure ROOT is derived from the JSON ENTRYPOINT (a renamed or
     unparseable entrypoint must fail, never silently skip);
  2. the transitive first-party import closure of that root is fully COPY'd;
  3. every worker-source COPY resolves to /app under the WORKDIR in force
     (the adjacent failure: all modules ship, none are importable);
  4. no secret/env file is COPY'd.

Pure static analysis: no LiveKit SDK import, no network, no Docker. Runs under
the same `unittest discover` as every other worker test (quality.yml).
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CTX = os.path.dirname(HERE)  # app/voice-livekit
REPO = os.path.dirname(os.path.dirname(CTX))
DOCKERFILE = os.path.join(CTX, "Dockerfile")
ANALYZER = os.path.join(REPO, "scripts", "docker_import_closure.py")


def _load_analyzer():
    """Load the exact analyzer CI runs, by path (it is not an installed pkg)."""
    spec = importlib.util.spec_from_file_location("docker_import_closure", ANALYZER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dic = _load_analyzer()


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _write_fixture(directory: str, files: dict) -> None:
    for name, content in files.items():
        with open(os.path.join(directory, name), "w", encoding="utf-8") as handle:
            handle.write(content)


def _fixture_dockerfile(copy_line: str, workdir: str | None = "/app",
                        entrypoint: str | None = 'ENTRYPOINT ["python", "agent.py", "start"]') -> str:
    parts = [
        "FROM python:3.12-slim AS builder",
        "RUN pip install --no-cache-dir -r requirements.txt",
        "FROM python:3.12-slim AS runtime",
    ]
    if workdir is not None:
        parts.append("WORKDIR " + workdir)
    parts.append("USER 1000:1000")
    parts.append(copy_line)
    if entrypoint is not None:
        parts.append(entrypoint)
    return "\n".join(parts) + "\n"


class DockerPackagingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.local = dic.local_modules(CTX)
        self.dockerfile = _read(DOCKERFILE)
        self.entry, self.entry_error = dic.entrypoint_root(self.dockerfile, self.local)
        self.assertIsNone(self.entry_error, self.entry_error)
        self.closure = dic.import_closure(CTX, self.entry)
        self.copy_srcs = dic.copy_sources(self.dockerfile)
        self.copy_set = {t.rstrip("/") for t in self.copy_srcs}
        self.result = dic.analyze(CTX)

    # ── the real image ────────────────────────────────────────────────────
    def test_real_context_is_fully_green(self) -> None:
        self.assertIsNone(self.result["entry_error"])
        self.assertEqual(self.result["missing"], [])
        self.assertEqual(self.result["bad_dest"], [])
        self.assertEqual(self.result["forbidden"], [])

    def test_closure_root_is_derived_from_the_entrypoint(self) -> None:
        # Not hardcoded: the root is whatever the container actually starts.
        self.assertEqual(self.entry, "agent")

    def test_closure_is_non_trivial(self) -> None:
        self.assertIn("agent", self.closure)
        self.assertIn("phone", self.closure)
        self.assertGreaterEqual(len(self.closure), 5)

    def test_every_imported_module_is_copied(self) -> None:
        missing = sorted(
            self.local[m].rstrip("/")
            for m in self.closure
            if self.local[m].rstrip("/") not in self.copy_set
        )
        self.assertEqual(
            missing, [], f"import closure not covered by Dockerfile COPY: {missing}"
        )

    def test_phone_is_copied(self) -> None:
        # The exact PR102 regression, pinned explicitly.
        self.assertIn("phone", self.closure, "agent.py must import phone")
        self.assertIn("phone.py", self.copy_set, "phone.py must be COPY'd into the image")

    def test_no_secret_or_env_file_copied(self) -> None:
        for src in self.copy_srcs:
            base = os.path.basename(src.rstrip("/"))
            self.assertFalse(dic.is_forbidden(base), f"forbidden file in COPY: {src}")

    def test_non_runtime_modules_excluded(self) -> None:
        # voice_quality_harness and model_governance are not on the runtime
        # import path and must stay OUT of the image (minimal, no test/harness).
        self.assertNotIn("voice_quality_harness", self.closure)
        self.assertNotIn("model_governance", self.closure)
        self.assertNotIn("voice_quality_harness.py", self.copy_set)
        self.assertNotIn("model_governance", self.copy_set)

    # ── COPY parsing ──────────────────────────────────────────────────────
    def test_copy_parser_robust_to_real_dockerfile_shapes(self) -> None:
        # Backslash continuation, lowercase keyword, and a --chown flag: the
        # source on the continuation line must still be seen, the flag must not
        # be treated as a source, and the destination must be dropped.
        text = "copy --chown=1000:1000 agent.py \\\n     phone.py ./\n"
        self.assertEqual(sorted(dic.copy_sources(text)), ["agent.py", "phone.py"])
        # A `--from=` stage copy is ignored.
        self.assertEqual(dic.copy_sources("COPY --from=builder /opt/venv /opt/venv\n"), [])

    def test_secret_on_continuation_line_is_caught(self) -> None:
        # The exact false-green the review flagged: a secret hidden on a COPY
        # continuation line must not slip past the source parser + detector.
        srcs = dic.copy_sources("COPY agent.py \\\n     id_rsa ./\n")
        self.assertIn("id_rsa", srcs)
        self.assertTrue(any(dic.is_forbidden(os.path.basename(s)) for s in srcs))
        for name in ("service-account.json", ".netrc", "app.key", "my_secret.txt"):
            self.assertTrue(dic.is_forbidden(name), name)
        for ok in ("agent.py", ".env.example", "requirements.txt"):
            self.assertFalse(dic.is_forbidden(ok), ok)

    def test_assertion_is_non_vacuous(self) -> None:
        # If phone.py's COPY were dropped, the coverage check MUST go red.
        mutated = self.dockerfile.replace(" phone.py", "")
        mutated_set = {t.rstrip("/") for t in dic.copy_sources(mutated)}
        missing = [
            self.local[m].rstrip("/")
            for m in self.closure
            if self.local[m].rstrip("/") not in mutated_set
        ]
        self.assertIn("phone.py", missing)

    # ── destination resolution (L-1) ──────────────────────────────────────
    def test_real_worker_copy_destination_resolves_to_app(self) -> None:
        entries = [
            (srcs, dest, wd)
            for srcs, dest, wd in dic.copy_entries(self.dockerfile)
            if "agent.py" in srcs
        ]
        self.assertEqual(len(entries), 1, "exactly one worker-source COPY expected")
        _srcs, dest, workdir = entries[0]
        self.assertEqual(workdir, "/app", "WORKDIR /app must be in force at the worker COPY")
        self.assertTrue(dic.resolves_under_app(dest, workdir), f"destination {dest} must land in /app")

    def test_destination_resolution_accepts_and_rejects(self) -> None:
        self.assertTrue(dic.resolves_under_app("./", "/app"))
        self.assertTrue(dic.resolves_under_app(".", "/app"))
        self.assertTrue(dic.resolves_under_app("/app", None))
        self.assertTrue(dic.resolves_under_app("/app/", None))
        # Wrong destination, wrong WORKDIR, and an unresolvable relative one.
        self.assertFalse(dic.resolves_under_app("/elsewhere/", "/app"))
        self.assertFalse(dic.resolves_under_app("/app/sub/", "/app"))
        self.assertFalse(dic.resolves_under_app("./", "/srv"))
        self.assertFalse(dic.resolves_under_app("./", None))

    def test_mutated_destination_goes_red_end_to_end(self) -> None:
        # The reviewed false-green: every module COPY'd, none importable.
        with tempfile.TemporaryDirectory() as fixture:
            _write_fixture(fixture, {
                "Dockerfile": _fixture_dockerfile("COPY agent.py helper.py /elsewhere/"),
                "agent.py": "import helper\n",
                "helper.py": "X = 1\n",
            })
            result = dic.analyze(fixture)
            self.assertEqual(result["missing"], [])  # the modules DO ship...
            self.assertTrue(result["bad_dest"], "wrong destination must be reported")
            self.assertIn("/elsewhere/", result["bad_dest"][0])
        # Positive control on the same fixture shape: /app is accepted.
        with tempfile.TemporaryDirectory() as fixture:
            _write_fixture(fixture, {
                "Dockerfile": _fixture_dockerfile("COPY agent.py helper.py ./"),
                "agent.py": "import helper\n",
                "helper.py": "X = 1\n",
            })
            self.assertEqual(dic.analyze(fixture)["bad_dest"], [])

    # ── entrypoint-derived closure root (L-2) ─────────────────────────────
    def test_renamed_entrypoint_reroots_the_closure(self) -> None:
        # A hardcoded `agent` root would silently skip this context entirely.
        with tempfile.TemporaryDirectory() as fixture:
            _write_fixture(fixture, {
                "Dockerfile": _fixture_dockerfile(
                    "COPY main.py ./", entrypoint='ENTRYPOINT ["python", "main.py", "start"]'
                ),
                "main.py": "import helper\n",
                "helper.py": "X = 1\n",
            })
            result = dic.analyze(fixture)
            self.assertEqual(result["entry"], "main")
            self.assertEqual(result["missing"], ["helper.py"])

    def test_wrong_root_with_missing_dependency_goes_red(self) -> None:
        # agent.py exists and is fully covered, but it is not what runs.
        with tempfile.TemporaryDirectory() as fixture:
            _write_fixture(fixture, {
                "Dockerfile": _fixture_dockerfile(
                    "COPY agent.py main.py ./", entrypoint='ENTRYPOINT ["python", "main.py", "start"]'
                ),
                "agent.py": "X = 1\n",
                "main.py": "import helper\n",
                "helper.py": "Y = 2\n",
            })
            result = dic.analyze(fixture)
            self.assertEqual(result["entry"], "main")
            self.assertEqual(result["missing"], ["helper.py"])

    def test_unusable_entrypoints_fail_closed(self) -> None:
        local = {"agent": "agent.py"}
        cases = {
            "ENTRYPOINT_MISSING": _fixture_dockerfile("COPY agent.py ./", entrypoint=None),
            "ENTRYPOINT_NOT_EXEC_FORM": _fixture_dockerfile(
                "COPY agent.py ./", entrypoint="ENTRYPOINT python agent.py start"
            ),
            "ENTRYPOINT_UNPARSEABLE": _fixture_dockerfile(
                "COPY agent.py ./", entrypoint='ENTRYPOINT ["python", "agent.py",'
            ),
            "ENTRYPOINT_NOT_PYTHON": _fixture_dockerfile(
                "COPY agent.py ./", entrypoint='ENTRYPOINT ["/bin/sh", "-c", "start"]'
            ),
            "ENTRYPOINT_NOT_FIRST_PARTY": _fixture_dockerfile(
                "COPY agent.py ./", entrypoint='ENTRYPOINT ["python", "/opt/vendor/run.py"]'
            ),
        }
        for expected, text in cases.items():
            with self.subTest(expected):
                root, error = dic.entrypoint_root(text, local)
                self.assertIsNone(root)
                self.assertIsNotNone(error)
                self.assertTrue(error.startswith(expected), error)
        # An ambiguous two-script entrypoint is also unusable.
        root, error = dic.entrypoint_root(
            _fixture_dockerfile("COPY agent.py ./", entrypoint='ENTRYPOINT ["python", "a.py", "b.py"]'),
            local,
        )
        self.assertIsNone(root)
        self.assertTrue(error.startswith("ENTRYPOINT_NOT_PYTHON"), error)
        # Positive control: the good shape still resolves.
        root, error = dic.entrypoint_root(_fixture_dockerfile("COPY agent.py ./"), local)
        self.assertEqual((root, error), ("agent", None))


if __name__ == "__main__":
    unittest.main()
