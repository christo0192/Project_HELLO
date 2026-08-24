#!/usr/bin/env python3
"""Static Dockerfile packaging analyzer for the LiveKit voice worker image.

Single source of truth for the rule that stops PR102 recurring: the runtime
image must contain the EXACT transitive first-party import closure of the
Python file the container actually starts, copied to a destination that
resolves under the runtime WORKDIR, and nothing secret.

Four independent findings are produced from one parse:

  ENTRYPOINT_*   the closure root is derived from the Dockerfile's JSON
                 ``ENTRYPOINT`` — not hardcoded. Absent, shell-form,
                 malformed, non-Python, ambiguous or not-first-party all fail
                 closed, because a root that cannot be established means the
                 closure below proves nothing.
  MISSING_COPY   a first-party module the entrypoint transitively imports is
                 not COPY'd into the image (`ModuleNotFoundError` at startup).
  BAD_COPY_DEST  a first-party module IS COPY'd, but to a destination that
                 does not resolve to the runtime WORKDIR /app — the modules
                 land outside the interpreter's search path and the container
                 dies with the same `ModuleNotFoundError` class.
  FORBIDDEN_COPY a secret/env file is COPY'd into the image.

Used by scripts/validate-container.sh (CI) and by
app/voice-livekit/tests/test_docker_packaging.py (unit controls), so the
mutation controls exercise the code CI actually runs.

Offline, stdlib-only, no Docker, no network.
"""

from __future__ import annotations

import ast
import json
import os
import posixpath
import re
import sys

#: The runtime working directory every worker source must resolve under.
APP_DIR = "/app"

SECRET_NAMES = {
    "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "secrets",
    ".netrc", ".pgpass", ".htpasswd", "kubeconfig", ".dockercfg",
    ".dockerconfigjson", ".npmrc", "service-account.json",
}
SECRET_SUBSTR = ("secret", "credential", "password", "passwd", "apikey", "api_key", "token")


def local_modules(ctx: str) -> dict:
    """First-party importable names in the build context: top-level ``.py``
    modules and packages (directories holding ``__init__.py``)."""
    local = {}
    for entry in sorted(os.listdir(ctx)):
        path = os.path.join(ctx, entry)
        if entry.endswith(".py"):
            local[entry[:-3]] = entry
        elif os.path.isdir(path) and os.path.isfile(os.path.join(path, "__init__.py")):
            local[entry] = entry
    return local


def top_imports(pyfile: str) -> set:
    """Top-level module names imported by ``pyfile`` (absolute, relative and
    literal-string dynamic forms)."""
    with open(pyfile, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=pyfile)
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names.add(node.module.split(".")[0])
            elif node.level:
                # `from . import sibling` — module is None; names are siblings.
                for alias in node.names:
                    names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.Call):
            # Literal-string dynamic imports: importlib.import_module("x") /
            # __import__("x"). Non-literal args are unresolvable and are a
            # documented limitation (see the Dockerfile COPY comment).
            fn = node.func
            is_dyn = (isinstance(fn, ast.Attribute) and fn.attr == "import_module") or (
                isinstance(fn, ast.Name) and fn.id == "__import__"
            )
            if is_dyn and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    names.add(arg.value.split(".")[0])
    return names


def import_closure(ctx: str, entry: str) -> set:
    """Transitive first-party import closure of ``entry`` (local modules only)."""
    local = local_modules(ctx)
    closure: set = set()
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
            for name in top_imports(f):
                if name in local and name not in closure:
                    stack.append(name)
    return closure


def _join_continuations(text: str) -> str:
    return re.sub(r"\\\s*\n", " ", text)


def copy_entries(dockerfile_text: str) -> list:
    """``(sources, destination, workdir)`` for every first-party ``COPY``.

    Robust to real Dockerfile shapes: backslash line-continuations are joined
    first, the keyword is matched case-insensitively (Docker is), ``--from=``
    stage copies are skipped, and leading ``--chown=``/``--chmod=``/``--link``
    flag tokens are dropped rather than mistaken for sources. ``workdir`` is
    the WORKDIR in force at that instruction (``None`` if never set in the
    current stage), so a relative destination can be resolved.
    """
    entries = []
    workdir = None
    for raw in _join_continuations(dockerfile_text).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        toks = line.split()
        keyword = toks[0].lower()
        if keyword == "from":
            workdir = None  # a new stage starts with no WORKDIR of its own
            continue
        if keyword == "workdir" and len(toks) >= 2:
            target = toks[1]
            workdir = target if target.startswith("/") else posixpath.normpath(
                posixpath.join(workdir or "/", target)
            )
            continue
        if keyword != "copy":
            continue
        rest = toks[1:]
        if any(t.startswith("--from=") for t in rest):
            continue
        rest = [t for t in rest if not t.startswith("--")]
        if len(rest) >= 2:
            entries.append((rest[:-1], rest[-1], workdir))
    return entries


def copy_sources(dockerfile_text: str) -> list:
    """Flat list of first-party COPY source tokens (destination dropped)."""
    return [src for srcs, _dest, _wd in copy_entries(dockerfile_text) for src in srcs]


def resolves_under_app(dest: str, workdir) -> bool:
    """True iff ``dest`` lands exactly in ``/app`` inside the image.

    Accepts an absolute ``/app`` / ``/app/`` and a relative ``./`` / ``.``
    under ``WORKDIR /app``. A relative destination with no WORKDIR in force
    cannot be resolved, so it fails closed.
    """
    target = dest
    if not target.startswith("/"):
        if not workdir:
            return False
        target = posixpath.join(workdir, target)
    return posixpath.normpath(target) == APP_DIR


def entrypoint_root(dockerfile_text: str, local: dict):
    """Derive the Python closure root from the Dockerfile ``ENTRYPOINT``.

    Returns ``(module, error)``; exactly one is non-None. The root is what the
    container actually executes, so hardcoding it would let a legitimate
    entrypoint rename silently re-root (or skip) the closure check.
    """
    line = None
    for raw in _join_continuations(dockerfile_text).splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        toks = stripped.split()
        if toks[0].lower() == "entrypoint":
            line = stripped[len(toks[0]):].strip()  # last ENTRYPOINT wins, as in Docker
    if line is None:
        return None, "ENTRYPOINT_MISSING no ENTRYPOINT instruction to root the import closure at"
    if not line.startswith("["):
        return None, "ENTRYPOINT_NOT_EXEC_FORM shell-form ENTRYPOINT cannot be parsed: %s" % line
    try:
        argv = json.loads(line)
    except ValueError as exc:
        return None, "ENTRYPOINT_UNPARSEABLE %s (%s)" % (line, exc)
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        return None, "ENTRYPOINT_UNPARSEABLE not a non-empty JSON array of strings: %s" % line
    if not posixpath.basename(argv[0]).startswith("python"):
        return None, "ENTRYPOINT_NOT_PYTHON interpreter is %r, not python" % argv[0]
    scripts = [a for a in argv[1:] if a.endswith(".py")]
    if len(scripts) != 1:
        return None, "ENTRYPOINT_NOT_PYTHON expected exactly one .py argument, found %d in %s" % (
            len(scripts), line,
        )
    name = posixpath.basename(scripts[0])
    module = name[:-3]
    if local.get(module) != name:
        return None, "ENTRYPOINT_NOT_FIRST_PARTY %s is not a first-party module in the build context" % scripts[0]
    return module, None


def is_forbidden(basename: str) -> bool:
    """A secret/env file that must never enter the image."""
    low = basename.lower()
    is_env = basename == ".env" or (basename.startswith(".env.") and basename != ".env.example")
    is_secret = (
        low.endswith((".pem", ".key", ".p12", ".pfx", ".pkcs12"))
        or low in SECRET_NAMES
        or any(sub in low for sub in SECRET_SUBSTR)
    )
    return is_env or is_secret


def analyze(ctx: str) -> dict:
    """Full static packaging analysis of a build context directory."""
    with open(os.path.join(ctx, "Dockerfile"), encoding="utf-8") as handle:
        dockerfile = handle.read()
    local = local_modules(ctx)

    entry, entry_error = entrypoint_root(dockerfile, local)
    result = {
        "entry": entry,
        "entry_error": entry_error,
        "closure": set(),
        "missing": [],
        "bad_dest": [],
        "forbidden": [],
    }

    entries = copy_entries(dockerfile)
    copy_srcs = [src for srcs, _d, _w in entries for src in srcs]
    copy_set = {t.rstrip("/") for t in copy_srcs}
    first_party_files = {name.rstrip("/") for name in local.values()}

    # FORBIDDEN and BAD_COPY_DEST do not depend on the closure root, so they are
    # still reported when the entrypoint itself is unusable.
    for src in copy_srcs:
        if is_forbidden(os.path.basename(src.rstrip("/"))):
            result["forbidden"].append(src)
    for srcs, dest, workdir in entries:
        if not any(s.rstrip("/") in first_party_files for s in srcs):
            continue  # not a worker-source COPY (e.g. requirements.txt in the builder)
        if not resolves_under_app(dest, workdir):
            result["bad_dest"].append(
                "%s -> %s (WORKDIR %s)" % (",".join(srcs), dest, workdir or "unset")
            )

    if entry is not None:
        closure = import_closure(ctx, entry)
        result["closure"] = closure
        result["missing"] = sorted(
            local[m].rstrip("/") for m in closure if local[m].rstrip("/") not in copy_set
        )
    return result


def main(argv: list) -> int:
    if len(argv) != 2:
        print("usage: docker_import_closure.py <build-context-dir>", file=sys.stderr)
        return 2
    ctx = argv[1]
    try:
        result = analyze(ctx)
    except (OSError, SyntaxError) as exc:
        print("PARSE_ERROR %s: %s" % (ctx, exc))
        return 3

    if result["entry_error"]:
        print(result["entry_error"])
    else:
        print("ENTRYPOINT_ROOT " + result["entry"])
        print("CLOSURE " + ",".join(sorted(result["closure"])))
    if result["missing"]:
        print("MISSING_COPY " + ",".join(result["missing"]))
    if result["bad_dest"]:
        print("BAD_COPY_DEST " + "; ".join(result["bad_dest"]))
    if result["forbidden"]:
        print("FORBIDDEN_COPY " + ",".join(sorted(set(result["forbidden"]))))

    failed = bool(
        result["entry_error"] or result["missing"] or result["bad_dest"] or result["forbidden"]
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
