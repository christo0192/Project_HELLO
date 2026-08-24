"""Static Docker-packaging tests — the runtime image ships every first-party
module the entrypoint imports.

Regression origin (PR102): project-hello-voice v40 ran `python agent.py start`
and crashed with `ModuleNotFoundError: No module named 'phone'`. P4a added
`import phone` to agent.py but the Dockerfile COPY list was not updated, so
phone.py never entered the image. These tests parse the *actual* transitive
first-party import closure of agent.py with an AST walk and assert the
Dockerfile COPY covers it — and that no secret/env file is copied.

Pure static analysis: no LiveKit SDK import, no network, no Docker. Runs under
the same `unittest discover` as every other worker test (quality.yml).
"""

from __future__ import annotations

import ast
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CTX = os.path.dirname(HERE)  # app/voice-livekit
DOCKERFILE = os.path.join(CTX, "Dockerfile")


def _local_modules(ctx: str) -> dict[str, str]:
    """First-party importable names in the build context: top-level .py modules
    and packages (directories with __init__.py)."""
    local: dict[str, str] = {}
    for entry in sorted(os.listdir(ctx)):
        path = os.path.join(ctx, entry)
        if entry.endswith(".py"):
            local[entry[:-3]] = entry
        elif os.path.isdir(path) and os.path.isfile(os.path.join(path, "__init__.py")):
            local[entry] = entry
    return local


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _top_imports(pyfile: str) -> set[str]:
    tree = ast.parse(_read(pyfile), filename=pyfile)
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names.add(node.module.split(".")[0])
            elif node.level:
                # `from . import sibling` — module is None; the names are siblings.
                for alias in node.names:
                    names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.Call):
            # Literal-string dynamic imports: importlib.import_module("x") / __import__("x").
            fn = node.func
            is_dyn = (isinstance(fn, ast.Attribute) and fn.attr == "import_module") or (
                isinstance(fn, ast.Name) and fn.id == "__import__"
            )
            if is_dyn and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    names.add(arg.value.split(".")[0])
    return names


def import_closure(ctx: str, entry: str = "agent") -> set[str]:
    """Transitive first-party import closure of `entry`, following only local
    modules (third-party names are ignored)."""
    local = _local_modules(ctx)
    closure: set[str] = set()
    stack = [entry]
    while stack:
        mod = stack.pop()
        if mod in closure or mod not in local:
            continue
        closure.add(mod)
        src = os.path.join(ctx, local[mod])
        files = [src]
        if os.path.isdir(src):
            files = [
                os.path.join(root, f)
                for root, _, fs in os.walk(src)
                for f in fs
                if f.endswith(".py")
            ]
        for f in files:
            for name in _top_imports(f):
                if name in local and name not in closure:
                    stack.append(name)
    return closure


def copy_sources(dockerfile_text: str) -> list[str]:
    """Worker-source COPY srcs. Robust to backslash line-continuations, a
    case-insensitive COPY keyword, `--from=` stage copies, and leading
    `--chown=`/`--chmod=`/`--link` flag tokens."""
    text = re.sub(r"\\\s*\n", " ", dockerfile_text)  # join continuations
    srcs: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        toks = s.split()
        if toks[0].lower() != "copy":
            continue
        toks = toks[1:]
        if any(t.startswith("--from=") for t in toks):
            continue
        toks = [t for t in toks if not t.startswith("--")]  # drop flags
        if len(toks) >= 2:
            srcs.extend(toks[:-1])  # drop destination
    return srcs


class DockerPackagingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.local = _local_modules(CTX)
        self.closure = import_closure(CTX)
        self.dockerfile = _read(DOCKERFILE)
        self.copy_srcs = copy_sources(self.dockerfile)
        self.copy_set = {t.rstrip("/") for t in self.copy_srcs}

    def test_closure_is_non_trivial(self) -> None:
        # Guards against a vacuous parse: agent + its known first-party deps.
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

    SECRET_NAMES = {
        "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "secrets",
        ".netrc", ".pgpass", ".htpasswd", "kubeconfig", ".dockercfg",
        ".dockerconfigjson", ".npmrc", "service-account.json",
    }
    SECRET_SUBSTR = ("secret", "credential", "password", "passwd", "apikey", "api_key", "token")

    @staticmethod
    def _is_forbidden(base: str) -> bool:
        low = base.lower()
        is_env = base == ".env" or (base.startswith(".env.") and base != ".env.example")
        is_secret = (
            low.endswith((".pem", ".key", ".p12", ".pfx", ".pkcs12"))
            or low in DockerPackagingTest.SECRET_NAMES
            or any(sub in low for sub in DockerPackagingTest.SECRET_SUBSTR)
        )
        return is_env or is_secret

    def test_no_secret_or_env_file_copied(self) -> None:
        for src in self.copy_srcs:
            base = os.path.basename(src.rstrip("/"))
            self.assertFalse(self._is_forbidden(base), f"forbidden file in COPY: {src}")

    def test_non_runtime_modules_excluded(self) -> None:
        # voice_quality_harness and model_governance are not on the runtime
        # import path and must stay OUT of the image (minimal, no test/harness).
        self.assertNotIn("voice_quality_harness", self.closure)
        self.assertNotIn("model_governance", self.closure)
        self.assertNotIn("voice_quality_harness.py", self.copy_set)
        self.assertNotIn("model_governance", self.copy_set)

    def test_copy_parser_robust_to_real_dockerfile_shapes(self) -> None:
        # Backslash continuation, lowercase keyword, and a --chown flag: the
        # source on the continuation line must still be seen, the flag must not
        # be treated as a source, and the destination must be dropped.
        text = "copy --chown=1000:1000 agent.py \\\n     phone.py ./\n"
        self.assertEqual(sorted(copy_sources(text)), ["agent.py", "phone.py"])
        # A `--from=` stage copy is ignored.
        self.assertEqual(copy_sources("COPY --from=builder /opt/venv /opt/venv\n"), [])

    def test_secret_on_continuation_line_is_caught(self) -> None:
        # The exact false-green the review flagged: a secret hidden on a COPY
        # continuation line must not slip past the source parser + detector.
        srcs = copy_sources("COPY agent.py \\\n     id_rsa ./\n")
        self.assertIn("id_rsa", srcs)
        self.assertTrue(any(self._is_forbidden(os.path.basename(s)) for s in srcs))
        for name in ("service-account.json", ".netrc", "app.key", "my_secret.txt"):
            self.assertTrue(self._is_forbidden(name), name)
        for ok in ("agent.py", ".env.example", "requirements.txt"):
            self.assertFalse(self._is_forbidden(ok), ok)

    def test_assertion_is_non_vacuous(self) -> None:
        # If phone.py's COPY were dropped, the coverage check MUST go red.
        mutated = self.dockerfile.replace(" phone.py", "")
        mutated_set = {t.rstrip("/") for t in copy_sources(mutated)}
        missing = [
            self.local[m].rstrip("/")
            for m in self.closure
            if self.local[m].rstrip("/") not in mutated_set
        ]
        self.assertIn("phone.py", missing)


if __name__ == "__main__":
    unittest.main()
