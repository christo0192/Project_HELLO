#!/usr/bin/env python3
"""Static Dockerfile packaging analyzer for the LiveKit voice worker image.

Single source of truth for the rule that stops PR102 recurring: the runtime
image must contain the EXACT transitive first-party import closure of the
Python file the container actually starts, copied to a destination that
resolves under the runtime WORKDIR, reachable from the directory the
interpreter actually starts in, and nothing secret.

Findings, all produced from one parse of the FINAL build stage (the stage that
becomes the image; `FROM` resets WORKDIR and ENTRYPOINT exactly as Docker does):

  ENTRYPOINT_*   the closure root is derived from the final stage's JSON
                 ``ENTRYPOINT`` — not hardcoded. Absent, shell-form,
                 malformed, non-Python, script-less, ambiguous or
                 not-first-party all fail closed, because a root that cannot
                 be established means the closure below proves nothing.
  MISSING_COPY   a first-party module the entrypoint transitively imports is
                 not COPY'd into the final stage (`ModuleNotFoundError` at
                 startup).
  BAD_COPY_DEST  a first-party module IS COPY'd, but to a destination that
                 does not resolve to /app — the modules land outside the
                 interpreter's search path and the container dies with the
                 same `ModuleNotFoundError` class.
  BAD_WORKDIR    the modules land in /app, but the EFFECTIVE final WORKDIR is
                 not /app, so a relative ENTRYPOINT script is resolved against
                 the wrong directory: `python: can't open file '/srv/agent.py'`.
                 Landing the files correctly and starting the interpreter
                 somewhere else is the same outage wearing a different message.
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

#: The runtime working directory every worker source must resolve under, and
#: the directory the interpreter must start in.
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


def parse_stages(dockerfile_text: str) -> list:
    """Split a Dockerfile into build stages.

    Each stage is ``{"workdir": <effective WORKDIR at the end of the stage>,
    "entrypoint": <raw text after the last ENTRYPOINT keyword, or None>,
    "copies": [(sources, destination, workdir_in_force)]}``.

    `FROM` starts a stage and resets BOTH `WORKDIR` and `ENTRYPOINT`, which is
    what Docker does: the final image inherits its own base image's entrypoint,
    never an earlier stage's. Parsing is robust to real Dockerfile shapes —
    backslash line-continuations are joined first, keywords are matched
    case-insensitively (Docker is), `--from=` stage copies are skipped, and
    leading `--chown=`/`--chmod=`/`--link` flag tokens are dropped rather than
    mistaken for sources.
    """
    stages: list = []
    current = None
    for raw in _join_continuations(dockerfile_text).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        toks = line.split()
        keyword = toks[0].lower()
        if keyword == "from":
            current = {"workdir": None, "entrypoint": None, "copies": []}
            stages.append(current)
            continue
        if current is None:
            continue  # ARG/comment before the first FROM: belongs to no stage
        if keyword == "workdir" and len(toks) >= 2:
            target = toks[1]
            current["workdir"] = target if target.startswith("/") else posixpath.normpath(
                posixpath.join(current["workdir"] or "/", target)
            )
        elif keyword == "entrypoint":
            current["entrypoint"] = line[len(toks[0]):].strip()  # last in the stage wins
        elif keyword == "copy":
            rest = toks[1:]
            if any(t.startswith("--from=") for t in rest):
                continue
            rest = [t for t in rest if not t.startswith("--")]  # drop flags
            if len(rest) >= 2:
                current["copies"].append((rest[:-1], rest[-1], current["workdir"]))
    return stages


def copy_entries(dockerfile_text: str) -> list:
    """``(sources, destination, workdir)`` for every first-party ``COPY`` in
    the file, in order, across all stages."""
    return [entry for stage in parse_stages(dockerfile_text) for entry in stage["copies"]]


def copy_sources(dockerfile_text: str) -> list:
    """Flat list of first-party COPY source tokens (destination dropped)."""
    return [src for srcs, _dest, _wd in copy_entries(dockerfile_text) for src in srcs]


def resolves_under_app(dest: str, workdir, sources=None) -> bool:
    """True iff ``dest`` lands exactly in ``/app`` inside the image.

    Accepts an absolute ``/app`` / ``/app/`` and a relative ``./`` / ``.``
    under ``WORKDIR /app``. A relative destination with no WORKDIR in force
    cannot be resolved, so it fails closed.

    ``sources`` enables the single-file form Docker also accepts:
    ``COPY agent.py /app/agent.py`` names the destination FILE, not a
    directory, so the parent is what must be ``/app``.
    """
    target = dest
    if not target.startswith("/"):
        if not workdir:
            return False
        target = posixpath.join(workdir, target)
    normalized = posixpath.normpath(target)
    if normalized == APP_DIR:
        return True
    # Single source copied to an explicitly named destination file/dir of the
    # same basename: resolve its parent instead.
    if sources and len(sources) == 1 and not dest.endswith("/"):
        if posixpath.basename(normalized) == posixpath.basename(sources[0].rstrip("/")):
            return posixpath.dirname(normalized) == APP_DIR
    return False


def entrypoint_root(dockerfile_text: str, local: dict):
    """Derive the Python closure root from the FINAL stage's ``ENTRYPOINT``.

    Returns ``(module, script, error)``; on failure ``module``/``script`` are
    None. The root is what the built image actually executes, so hardcoding it
    would let a legitimate entrypoint rename silently re-root (or skip) the
    closure check, and reading an earlier stage's ENTRYPOINT would root it at
    something the image does not run at all.
    """
    stages = parse_stages(dockerfile_text)
    line = stages[-1]["entrypoint"] if stages else None
    if line is None:
        return None, None, "ENTRYPOINT_MISSING the final build stage declares no ENTRYPOINT to root the import closure at"
    if not line.startswith("["):
        return None, None, "ENTRYPOINT_NOT_EXEC_FORM shell-form ENTRYPOINT cannot be parsed: %s" % line
    try:
        argv = json.loads(line)
    except ValueError as exc:
        return None, None, "ENTRYPOINT_UNPARSEABLE %s (%s)" % (line, exc)
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        return None, None, "ENTRYPOINT_UNPARSEABLE not a non-empty JSON array of strings: %s" % line
    if not posixpath.basename(argv[0]).startswith("python"):
        return None, None, "ENTRYPOINT_NOT_PYTHON interpreter is %r, not python" % argv[0]
    scripts = [a for a in argv[1:] if a.endswith(".py")]
    if not scripts:
        return None, None, "ENTRYPOINT_NO_SCRIPT no .py script argument to root the closure at: %s" % line
    if len(scripts) > 1:
        return None, None, "ENTRYPOINT_AMBIGUOUS %d .py arguments, cannot tell which one starts the worker: %s" % (
            len(scripts), line,
        )
    script = scripts[0]
    name = posixpath.basename(script)
    module = name[:-3]
    if local.get(module) != name:
        return None, None, "ENTRYPOINT_NOT_FIRST_PARTY %s is not a first-party module in the build context" % script
    return module, script, None


def entrypoint_start_path(script: str, final_workdir):
    """Absolute path the interpreter will try to open, or None if unresolvable.

    A relative ENTRYPOINT script is resolved against the container's cwd — the
    EFFECTIVE final WORKDIR — not against wherever the COPY happened to land.
    """
    if script.startswith("/"):
        return posixpath.normpath(script)
    if not final_workdir:
        return None
    return posixpath.normpath(posixpath.join(final_workdir, script))


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
    stages = parse_stages(dockerfile)
    final = stages[-1] if stages else {"workdir": None, "entrypoint": None, "copies": []}

    entry, script, entry_error = entrypoint_root(dockerfile, local)
    result = {
        "entry": entry,
        "entry_script": script,
        "entry_error": entry_error,
        "final_workdir": final["workdir"],
        "closure": set(),
        "missing": [],
        "bad_dest": [],
        "bad_workdir": [],
        "forbidden": [],
    }

    # Only the FINAL stage's COPYs put files in the image. A first-party module
    # copied solely into the builder stage never reaches the runtime image, so
    # counting it as covered would be a fail-open.
    final_copies = final["copies"]
    copy_set = {t.rstrip("/") for srcs, _d, _w in final_copies for t in srcs}
    first_party_files = {name.rstrip("/") for name in local.values()}

    # FORBIDDEN is scanned across every stage (defence in depth: a secret must
    # not enter any layer). BAD_COPY_DEST is a property of the final stage.
    for srcs, _dest, _wd in copy_entries(dockerfile):
        for src in srcs:
            if is_forbidden(os.path.basename(src.rstrip("/"))):
                result["forbidden"].append(src)
    for srcs, dest, workdir in final_copies:
        if not any(s.rstrip("/") in first_party_files for s in srcs):
            continue  # not a worker-source COPY (e.g. requirements.txt)
        if not resolves_under_app(dest, workdir, srcs):
            result["bad_dest"].append(
                "%s -> %s (WORKDIR %s)" % (",".join(srcs), dest, workdir or "unset")
            )

    if entry is not None:
        closure = import_closure(ctx, entry)
        result["closure"] = closure
        result["missing"] = sorted(
            local[m].rstrip("/") for m in closure if local[m].rstrip("/") not in copy_set
        )
        # Where does the interpreter actually start, and is the entrypoint
        # script there? Files in the right place plus a cwd in the wrong place
        # is still a startup crash-loop.
        start = entrypoint_start_path(script, final["workdir"])
        expected = posixpath.join(APP_DIR, local[entry])
        if start is None:
            # The base image's own WORKDIR is not knowable from this file, so
            # a relative script with no declared WORKDIR is refused rather than
            # guessed. (For python:3.12-slim the cwd would be `/`, and the
            # container would die with `can't open file '/<script>'`.)
            result["bad_workdir"].append(
                "relative ENTRYPOINT script %s with no WORKDIR declared in the final stage; "
                "the start directory is not statically knowable" % script
            )
        elif start != expected:
            result["bad_workdir"].append(
                "ENTRYPOINT starts %s (final WORKDIR %s), expected %s"
                % (start, final["workdir"] or "unset", expected)
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
        print("FINAL_WORKDIR " + (result["final_workdir"] or "unset"))
        print("CLOSURE " + ",".join(sorted(result["closure"])))
    if result["missing"]:
        print("MISSING_COPY " + ",".join(result["missing"]))
    if result["bad_dest"]:
        print("BAD_COPY_DEST " + "; ".join(result["bad_dest"]))
    if result["bad_workdir"]:
        print("BAD_WORKDIR " + "; ".join(result["bad_workdir"]))
    if result["forbidden"]:
        print("FORBIDDEN_COPY " + ",".join(sorted(set(result["forbidden"]))))

    failed = bool(
        result["entry_error"]
        or result["missing"]
        or result["bad_dest"]
        or result["bad_workdir"]
        or result["forbidden"]
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
