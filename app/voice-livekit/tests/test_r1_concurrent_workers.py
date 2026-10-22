"""M019 / PR #378: up to 15 concurrent R1 interviews, simulated on the WORKER side.

The API admits up to ``r1_settings.max_concurrent_sessions`` (CHECK 1..15) live R1
interviews and leases ONE voice-worker machine per interview. That is only safe if,
on the worker side:

  1. every pool machine's worker registers its OWN LiveKit name,
     ``<BROWSER_AGENT_NAME>-<FLY_MACHINE_ID>``, byte-for-byte the name the API's
     ``machineAgentName`` (app/api/src/lib/worker-agent-name.ts) dispatches to, and no
     two machines share one;
  2. each worker takes exactly ONE job: a burst of simultaneous job offers to one
     worker is accepted once and declined (``available=False``, ``terminate=False``,
     so LiveKit may offer it elsewhere) for the rest, including an offer that lands
     in the launch window before the first job's process exists, and the worker
     accepts again once that job has ended;
  3. with ``BROWSER_PER_MACHINE_AGENT_NAME`` absent (how the PR ships) every machine
     registers today's shared base name and job acceptance is today's;
  4. a job dispatched to another machine's name never reaches this worker, so an
     interview can never be conducted on a machine whose lease belongs to a
     different session.

HOW. Each simulated machine is a SEPARATE Python process started with its own
environment (``FLY_MACHINE_ID`` and the R1 cutover keys), so nothing is shared
between workers except what a real fleet shares. A process imports the real
``agent.py`` and, when livekit-agents is installed, starts it through the real
``agent.run_worker_app`` seam (``cli.run_app`` captured, nothing connects), builds
the real ``AgentServer`` from the real ``WorkerOptions`` and drives the SDK's own
availability path (``_handle_availability`` -> ``_answer_availability`` ->
``_refresh_worker_load`` -> ``load_fnc`` -> ``_is_available`` with its reserved-slot
arithmetic, ``_default_request_fnc`` -> accept, ``_handle_assignment``,
``launch_job``) with only the network and the job processes replaced. LiveKit's
explicit dispatch is modelled by its one rule: a job created for agent name N is
offered only to workers registered under exactly N.

Without the SDK (the bare-python discover step) the processes fall back to the
shared SDK stubs from ``test_phone_gate`` and the SDK-driven checks skip; the
naming, readiness-body and cross-language checks still run. CI must run this
module in a step that has the SDK and fails on a skip (tests/test_r1_shipping.py).
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import unittest

_HERE = pathlib.Path(__file__).resolve().parent.parent  # app/voice-livekit
_ROOT = _HERE.parents[1]  # the repository root
_TS_AGENT_NAME = _ROOT / "app" / "api" / "src" / "lib" / "worker-agent-name.ts"

_BASE = "browser-screener"
_POOL = 15  # the owner cap: r1_settings.max_concurrent_sessions CHECK (1..15)
_BURST = _POOL  # worst case: the whole cap offered to ONE worker at once
_HOST = "r1.example.test"
_CHILD_TIMEOUT_SEC = 240

# Fifteen distinct machine ids of the accepted class [0-9a-z]{8,32}: the two real
# fixture ids, both length boundaries, a base36 id, and ten Fly-shaped 14-hex ids.
_MACHINES: tuple[str, ...] = (
    "d895472c499e38",
    "7812736a540d58",
    "a1b2c3d4",
    "0123456789abcdefghijklmnopqrstuv",
    "zz09yy18xx27ww36",
) + tuple(hashlib.sha256(f"r1-pool-{i}".encode()).hexdigest()[:14] for i in range(10))

# Every key the worker or the SDK reads for naming, readiness or load. A child
# starts with all of them removed, then gets exactly its machine's set, so the
# developer's or the runner's environment can never leak into a simulated machine.
_SCRUB = (
    "PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION",
    "R1_READINESS_HOST", "BROWSER_PER_MACHINE_AGENT_NAME", "BROWSER_WORKER_ONE_JOB",
    "PHONE_PER_MACHINE_AGENT_NAME", "FLY_MACHINE_ID", "LIVEKIT_URL", "R1_LANE_MODE",
    "FLY_APP_NAME", "PHONE_VOICE_APP", "WORKER_CONTEXT_SECRET", "R1_DRAIN_TIMEOUT_SEC",
    "R1_SHUTDOWN_PROCESS_TIMEOUT_SEC", "LIVEKIT_WORKER_TOKEN", "LIVEKIT_AGENT_NAME",
    "LIVEKIT_AGENT_NAME_OVERRIDE", "LIVEKIT_AGENT_DEPLOYMENT", "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET", "R1SIM_SPEC",
)

# The live Cloud browser lane: named and orchestrated, R1 readiness absent.
_CLOUD = {
    "BROWSER_AGENT_NAME": _BASE,
    "WORKER_ORCHESTRATION": "worker",
    "LIVEKIT_URL": "wss://cloud.example.test",
    "R1_LANE_MODE": "r1_only",
}
# The R1 lane as the cutover leaves it, flag ABSENT (how PR #378 ships).
_R1 = {**_CLOUD, "LIVEKIT_URL": "wss://R1.Example.Test:7880", "R1_READINESS_HOST": "on"}
# The R1 lane opted into per-machine registration (FLY_MACHINE_ID added per machine).
_ON = {**_R1, "BROWSER_PER_MACHINE_AGENT_NAME": "true"}

# Flag absent: three machines per lane (enough to show the name never varies by
# machine), the Cloud fallback with the key present, and near misses of "true".
_FLAG_ABSENT_ENVS = (
    [{**_R1, "FLY_MACHINE_ID": m} for m in _MACHINES[:3]]
    + [{**_CLOUD, "FLY_MACHINE_ID": m} for m in _MACHINES[:3]]
    + [{**_CLOUD, "BROWSER_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINES[0]}]
    + [{**_R1, "BROWSER_PER_MACHINE_AGENT_NAME": v, "FLY_MACHINE_ID": _MACHINES[0]}
       for v in ("TRUE", "1", "false", "")]
)

# ── the simulated machine: one process per worker ───────────────────────────
_CHILD = r'''
import asyncio, dataclasses, json, os, sys

spec = json.loads(os.environ["R1SIM_SPEC"])

REAL = False
try:
    if spec.get("sdk") == "stub":
        raise ImportError("stub mode requested")
    from livekit.agents import worker as lkw
    from livekit.protocol import agent as lkproto
    REAL = hasattr(lkw, "AgentServer") and hasattr(lkw.AgentServer, "_answer_availability")
except Exception:
    REAL = False
if REAL:
    import agent
else:
    for _name in [n for n in sys.modules if n == "livekit" or n.startswith("livekit.")]:
        del sys.modules[_name]
    from tests import test_phone_gate as fixtures
    agent = fixtures.agent_mod

from unittest.mock import AsyncMock, patch

# Generous on purpose: fifteen machines boot at once on a small CI runner. A real
# answer takes milliseconds; only a hang ever reaches this.
POLL_DEADLINE_SEC = 60.0


def fn(value):
    if value is None:
        return None
    func = getattr(value, "__func__", value)
    owner = getattr(value, "__self__", None)
    owner = getattr(owner, "__qualname__", None) if isinstance(owner, type) else None
    qual = getattr(func, "__qualname__", None) or repr(func)
    return f"{getattr(func, '__module__', '?')}.{qual}" + (f"@{owner}" if owner else "")


def norm(value):
    if callable(value) and not isinstance(value, type):
        return "fn:" + fn(value)
    if hasattr(value, "dev_default") and hasattr(value, "prod_default"):
        return {"dev": repr(value.dev_default), "prod": repr(value.prod_default)}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)


def options_dict(opts):
    if dataclasses.is_dataclass(opts):
        return {f.name: norm(getattr(opts, f.name)) for f in dataclasses.fields(opts)}
    return {k: norm(v) for k, v in getattr(opts, "kwargs", {}).items()}


def build_options():
    if REAL:
        return agent.build_worker_options()
    with patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder), \
         patch.object(agent, "_worker_options_accepts", return_value=True):
        return agent.build_worker_options()


def start_worker():
    """agent.run_worker_app with cli.run_app captured: what the process would run."""
    captured = []
    with patch.object(agent.cli, "run_app", side_effect=captured.append):
        agent.run_worker_app()
    (target,) = captured
    if isinstance(target, lkw.AgentServer):
        return target, "agent_server"
    # The historical path: cli.run_app(WorkerOptions) builds exactly this.
    return lkw.AgentServer.from_server_options(target), "worker_options"


async def readiness_posts(server):
    """Kwargs of every readiness post the worker makes for its posture."""
    post = AsyncMock(return_value=True)
    with patch.object(agent.worker_ready_api, "post_worker_ready_machine", new=post):
        if agent._browser_r1_readiness():
            if server is not None:
                # The SDK emits this after LiveKit accepted the registration.
                server.emit("worker_registered", "AW_sim", None)
                await asyncio.gather(*list(agent._registration_post_tasks))
            else:
                await agent._post_browser_machine_ready_after_registration()
        else:
            await asyncio.get_running_loop().run_in_executor(
                None, agent._prewarm_post_machine_ready, None)
    return [dict(call.kwargs) for call in post.await_args_list]


class FakeProc:
    def __init__(self, info):
        self.running_job = info


class FakePool:
    """Stands in for ipc.proc_pool.ProcPool: launch_job binds the job to a process
    before it returns, exactly as JobProcExecutor.launch_job sets _running_job."""

    def __init__(self):
        self.processes = []
        self.launched = []

    async def launch_job(self, info):
        await asyncio.sleep(0.01)  # a real launch yields to the loop
        self.processes.append(FakeProc(info))
        self.launched.append(info.job.id)

    def get_by_job_id(self, job_id):
        for proc in self.processes:
            if proc.running_job and proc.running_job.job.id == job_id:
                return proc
        return None

    def end(self, job_id):
        self.processes = [p for p in self.processes if p.running_job.job.id != job_id]


class Harness:
    """One real AgentServer with the network and the job processes replaced. Every
    state field is the one AgentServer.run() initialises; prod mode (devmode False)."""

    def __init__(self, server, loop):
        s = self.server = server
        s._loop = loop
        s._devmode = False
        s._simulation = False
        s._draining = False
        s._job_lifecycle_tasks = set()
        s._pending_assignments = {}
        s._worker_load = 0.0
        s._reserved_slots = 0
        s._id = "AW_" + (os.environ.get("FLY_MACHINE_ID") or "x")
        s._ws_url = s._ws_url or "wss://sim"
        if s._request_fnc is None:
            s._request_fnc = lkw._default_request_fnc
        # Flag absent: the SDK's default CPU average. A just-dispatched interview has
        # no audio pipeline yet, so the measured CPU is ~0; model exactly that.
        self.cpu_default_load = s._load_fnc == lkw._DefaultLoadCalc.get_load
        if self.cpu_default_load:
            s._load_fnc = lambda: 0.0
        self.pool = s._proc_pool = FakePool()
        self.answers = {}
        self.jobs = {}

        async def queue(msg):
            if msg.HasField("availability"):
                a = msg.availability
                self.answers[a.job_id] = {"available": a.available, "terminate": a.terminate,
                                          "agent_attr": dict(a.participant_attributes)}
        s._queue_msg = queue

    def offer(self, job_id, agent_name):
        job = lkproto.Job(id=job_id, agent_name=agent_name)
        job.room.name = "r1-" + job_id
        self.jobs[job_id] = job
        self.server._handle_availability(lkproto.AvailabilityRequest(job=job))

    async def answered(self, ids):
        deadline = asyncio.get_running_loop().time() + POLL_DEADLINE_SEC
        while asyncio.get_running_loop().time() < deadline:
            if all(i in self.answers for i in ids):
                return
            await asyncio.sleep(0.002)
        raise AssertionError(f"unanswered offers: {[i for i in ids if i not in self.answers]}")

    async def assign_and_settle(self):
        for jid, ans in self.answers.items():
            if ans["available"] and jid in self.server._pending_assignments:
                self.server._handle_assignment(
                    lkproto.JobAssignment(job=self.jobs[jid], token="t"))
        deadline = asyncio.get_running_loop().time() + POLL_DEADLINE_SEC
        while asyncio.get_running_loop().time() < deadline:
            if not self.server._job_lifecycle_tasks:
                return
            await asyncio.sleep(0.002)
        raise AssertionError("job lifecycle tasks did not settle")

    def accepted(self, ids):
        return [i for i in ids if self.answers[i]["available"]]


async def one_worker_scenario(server):
    h = Harness(server, asyncio.get_running_loop())
    name = server._agent_name
    out = {"cpu_default_load": h.cpu_default_load}

    # A. The whole cap offered to this one worker in the same instant.
    burst = [f"AJ_burst_{i:02d}" for i in range(spec["burst"])]
    for jid in burst:
        h.offer(jid, name)
    await h.answered(burst)
    await h.assign_and_settle()
    out["burst_accepted"] = h.accepted(burst)
    out["burst_refused_terminate"] = sorted({h.answers[i]["terminate"]
                                             for i in burst if not h.answers[i]["available"]})
    out["burst_agent_attr"] = sorted({h.answers[i]["agent_attr"].get("lk.agent.name", "")
                                      for i in out["burst_accepted"]})
    out["launched_after_burst"] = list(h.pool.launched)
    out["active_after_burst"] = len(server.active_jobs)

    # B. A later offer while that interview runs.
    h.offer("AJ_busy", name)
    await h.answered(["AJ_busy"])
    await h.assign_and_settle()
    out["busy_accepted"] = h.answers["AJ_busy"]["available"]
    out["active_while_busy"] = len(server.active_jobs)

    # C. The interview ends (its process exits): the machine is free again.
    for jid in list(h.pool.launched):
        h.pool.end(jid)
    h.offer("AJ_after_end", name)
    await h.answered(["AJ_after_end"])
    out["after_end_accepted"] = h.answers["AJ_after_end"]["available"]
    # D. The launch window: a second offer lands after AJ_after_end was accepted but
    # BEFORE its assignment arrived and its process exists (active_jobs still empty).
    out["active_in_window"] = len(server.active_jobs)
    out["reserved_in_window"] = server._reserved_slots
    h.offer("AJ_window", name)
    await h.answered(["AJ_window"])
    out["window_accepted"] = h.answers["AJ_window"]["available"]
    await h.assign_and_settle()
    out["active_at_end"] = len(server.active_jobs)
    out["launched_total"] = list(h.pool.launched)
    return out


async def worker_mode():
    result = {"real": REAL, "machine": os.environ.get("FLY_MACHINE_ID")}
    opts = build_options()
    result["options"] = options_dict(opts)
    result["registered"] = agent.browser_registered_agent_name()
    result["base"] = agent._browser_agent_name()
    result["r1_readiness"] = agent._browser_r1_readiness()
    result["per_machine"] = agent._browser_per_machine_agent_name_enabled()
    result["agent_one_job_fn"] = fn(agent._browser_one_job_per_machine_load)
    server = None
    if REAL:
        server, result["start_path"] = start_worker()
        result["server"] = {
            "agent_name": server._agent_name,
            "load_fnc": norm(server._load_fnc),
            "load_threshold": norm(server._load_threshold),
            "num_idle_processes": norm(server._num_idle_processes),
            "setup_fnc": norm(server._setup_fnc),
            "drain_timeout": server._drain_timeout,
            "cloud_agents": server.worker_info.cloud_agents,
        }
    result["readiness"] = await readiness_posts(server)
    if REAL:
        result["scenario"] = await one_worker_scenario(server)
    return result


async def fleet_mode():
    """Every machine of the pool in one LiveKit model: a job for agent name N is
    offered only to workers registered under exactly N (explicit dispatch)."""
    result = {"real": REAL}
    if not REAL:
        return result
    loop = asyncio.get_running_loop()
    fleet = {}
    for machine in spec["machines"]:
        os.environ["FLY_MACHINE_ID"] = machine
        agent._BROWSER_AGENT_NAME_FALLBACK_LOGGED = False
        server, _ = start_worker()
        fleet[machine] = Harness(server, loop)
    os.environ.pop("FLY_MACHINE_ID", None)
    names = {m: h.server._agent_name for m, h in fleet.items()}
    result["names"] = names

    def candidates(agent_name):
        return [m for m, h in fleet.items() if h.server._agent_name == agent_name]

    offered = {}  # job id -> machines it was offered to

    def dispatch(job_id, agent_name):
        """LiveKit: offer the job to each worker with that name until one accepts."""
        offered[job_id] = candidates(agent_name)
        for m in offered[job_id]:
            fleet[m].offer(job_id, agent_name)

    async def settle(job_ids):
        for jid in job_ids:
            for m in offered[jid]:
                await fleet[m].answered([jid])
        for h in fleet.values():
            await h.assign_and_settle()

    def placed(job_id):
        return [m for m in offered[job_id]
                if fleet[m].answers.get(job_id, {}).get("available")]

    # 15 interviews leased one per machine, all dispatched in the same instant to
    # the name each lease reported.
    leases = {f"AJ_session_{i:02d}": m for i, m in enumerate(spec["machines"])}
    for jid, machine in leases.items():
        dispatch(jid, names[machine])
    await settle(list(leases))
    result["lease_placement"] = {jid: placed(jid) for jid in leases}
    result["lease_offered"] = {jid: offered[jid] for jid in leases}
    result["active_per_machine"] = {m: len(h.server.active_jobs) for m, h in fleet.items()}

    # A 16th interview addressed to machine 0 while it is busy: no other worker
    # carries that name, so it can never be stacked onto or moved to another box.
    first = spec["machines"][0]
    dispatch("AJ_over_cap", names[first])
    await settle(["AJ_over_cap"])
    result["over_cap_offered"] = offered["AJ_over_cap"]
    result["over_cap_placed"] = placed("AJ_over_cap")
    # Dispatches to names nobody registered once per-machine names are on.
    for jid, agent_name in (("AJ_base", spec["base"]),
                            ("AJ_unknown", spec["base"] + "-ffffffffffffff"),
                            ("AJ_other_base", "phone-screener-" + first)):
        dispatch(jid, agent_name)
        result[jid] = offered[jid]
    result["active_after"] = {m: len(h.server.active_jobs) for m, h in fleet.items()}
    return result


async def main():
    out = await (fleet_mode() if spec["mode"] == "fleet" else worker_mode())
    sys.stdout.write("R1SIM_RESULT " + json.dumps(out, sort_keys=True) + "\n")
    sys.stdout.flush()


asyncio.run(main())
'''


def _run_machine(env: dict[str, str], spec: dict) -> dict:
    """Start one simulated machine (a fresh interpreter) and return its report."""
    child_env = {k: v for k, v in os.environ.items() if k not in _SCRUB}
    child_env.update(env)
    # R1SIM_SDK=stub runs the machines on the SDK stubs even where the SDK is
    # installed: the local way to check what the bare-python CI step sees.
    child_env["R1SIM_SPEC"] = json.dumps({**spec, "sdk": os.environ.get("R1SIM_SDK", "auto")})
    child_env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD],
        cwd=str(_HERE),
        env=child_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_CHILD_TIMEOUT_SEC,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("R1SIM_RESULT ")]
    if proc.returncode != 0 or len(lines) != 1:
        raise AssertionError(
            f"simulated machine failed (exit {proc.returncode}):\n"
            f"stdout tail:\n{proc.stdout[-3000:]}\nstderr tail:\n{proc.stderr[-6000:]}"
        )
    return json.loads(lines[0][len("R1SIM_RESULT "):])


def _run_fleet_of_processes(envs: list[dict[str, str]], spec: dict) -> list[dict]:
    """Start every machine at once, each in its own process, like a pool boot."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(envs)) as pool:
        return list(pool.map(lambda env: _run_machine(env, spec), envs))


def _ts_contract() -> tuple[re.Pattern[str], re.Pattern[str]]:
    """The API's PER_MACHINE_ID_RE and AGENT_NAME_RE, read from the TS source."""
    source = _TS_AGENT_NAME.read_text(encoding="utf-8")

    def literal(name: str) -> str:
        match = re.search(rf"^export const {name} = /(.+)/;\s*$", source, flags=re.M)
        if match is None:
            raise AssertionError(f"{name} not found in {_TS_AGENT_NAME}")
        return match.group(1)

    # The composition the API dispatches to, pinned so the Python model below is it.
    if "const name = `${base}-${machineId}`;" not in source:
        raise AssertionError("machineAgentName no longer composes `${base}-${machineId}`")
    id_src, name_src = literal("PER_MACHINE_ID_RE"), literal("AGENT_NAME_RE")
    for src in (id_src, name_src):
        # A JS ^...$ without flags is a whole-string match; fullmatch is its equal.
        assert src.startswith("^") and src.endswith("$"), src
    return re.compile(id_src[1:-1]), re.compile(name_src[1:-1])


def _ts_machine_agent_name(base: str, machine_id: str) -> str | None:
    """Python model of worker-agent-name.ts machineAgentName, from its own regexes."""
    id_re, name_re = _ts_contract()
    if not id_re.fullmatch(machine_id):
        return None
    name = f"{base}-{machine_id}"
    return name if name_re.fullmatch(name) else None


def _node_machine_agent_names(base: str, machines: tuple[str, ...]) -> list | None:
    """Execute the REAL worker-agent-name.ts under node, when node can run TS."""
    node = shutil.which("node")
    if node is None:
        return None
    script = (
        "const m = await import(process.argv[1]);"
        "const base = process.argv[2]; const ids = JSON.parse(process.argv[3]);"
        "console.log(JSON.stringify(ids.map((id) => [m.machineAgentName(base, id),"
        " m.isReportedMachineAgentName(base, id, `${base}-${id}`),"
        " m.isMachineAgentNameUnder(base, `${base}-${id}`)])));"
    )
    try:
        proc = subprocess.run(
            [node, "--experimental-strip-types", "--no-warnings", "--input-type=module",
             "-e", script, _TS_AGENT_NAME.as_uri(), base, json.dumps(list(machines))],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None  # a node without type stripping; the source-level model still runs
    return json.loads(proc.stdout.strip().splitlines()[-1])


_ONE_JOB_FN = "agent._browser_one_job_per_machine_load"


class _ProcessFleet(unittest.TestCase):
    """Boot the simulated machines once per class; tests read their reports."""

    envs: list[dict[str, str]] = []
    reports: list[dict] = []

    @classmethod
    def setUpClass(cls):
        cls.reports = _run_fleet_of_processes(cls.envs, {"mode": "worker", "burst": _BURST})

    def require_sdk(self, report: dict) -> None:
        if not report["real"]:
            self.skipTest("livekit-agents is not installed: the SDK-driven checks need it")


class TestFifteenPerMachineWorkers(_ProcessFleet):
    """(1) + (2): 15 machines, flag on, each its own process."""

    envs = [{**_ON, "FLY_MACHINE_ID": m} for m in _MACHINES]

    def test_the_pool_is_the_owner_cap_of_distinct_machines(self):
        self.assertEqual(len(_MACHINES), _POOL)
        self.assertEqual(len(set(_MACHINES)), _POOL)
        self.assertEqual(len(self.reports), _POOL)
        self.assertEqual([r["machine"] for r in self.reports], list(_MACHINES))

    def test_each_machine_registers_its_own_name(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                expected = f"{_BASE}-{report['machine']}"
                self.assertTrue(report["per_machine"])
                self.assertEqual(report["base"], _BASE)
                self.assertEqual(report["registered"], expected)
                self.assertEqual(report["options"]["agent_name"], expected)
        names = [r["registered"] for r in self.reports]
        self.assertEqual(len(set(names)), _POOL, "two machines share a LiveKit name")
        self.assertNotIn(_BASE, names)

    def test_each_name_is_exactly_what_the_api_dispatches_to(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.assertEqual(report["registered"],
                                 _ts_machine_agent_name(_BASE, report["machine"]))

    def test_the_real_ts_helper_agrees_when_node_can_run_it(self):
        executed = _node_machine_agent_names(_BASE, _MACHINES)
        if executed is None:
            # No node that strips types here: the source-level model above stands.
            return
        registered = {r["machine"]: r["registered"] for r in self.reports}
        for machine, (name, reported_ok, under_base) in zip(_MACHINES, executed):
            with self.subTest(machine=machine):
                self.assertEqual(name, registered[machine])
                self.assertTrue(reported_ok)
                self.assertTrue(under_base)

    def test_each_machine_reports_the_name_it_registered(self):
        # The API stores the reported name on the lease and dispatches to it: a
        # worker that registered one name and reported another would get no job.
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.assertTrue(report["r1_readiness"])
                self.assertEqual(report["readiness"],
                                 [{"livekit_host": _HOST, "agent_name": report["registered"]}])

    def test_each_machine_has_the_one_job_gate(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                opts = report["options"]
                self.assertEqual(opts["load_fnc"], "fn:" + _ONE_JOB_FN)
                self.assertEqual(opts["load_threshold"], 0.75)
                self.assertEqual(opts["num_idle_processes"], 1)
                self.assertEqual(opts["prewarm_fnc"], "fn:agent._prewarm_post_machine_ready")

    def test_the_real_sdk_server_carries_the_name_and_the_gate(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.require_sdk(report)
                server = report["server"]
                # run_worker_app's R1 seam, not the historical cli.run_app(options).
                self.assertEqual(report["start_path"], "agent_server")
                self.assertEqual(server["agent_name"], report["registered"])
                self.assertEqual(server["load_fnc"], "fn:" + _ONE_JOB_FN)
                self.assertEqual(server["load_threshold"], 0.75)
                self.assertEqual(server["num_idle_processes"], 1)
                self.assertFalse(server["cloud_agents"])  # custom load_fnc is honoured
                self.assertEqual(server["drain_timeout"], 60)

    def test_a_simultaneous_burst_is_accepted_exactly_once(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.require_sdk(report)
                sc = report["scenario"]
                self.assertFalse(sc["cpu_default_load"])
                self.assertEqual(len(sc["burst_accepted"]), 1, sc["burst_accepted"])
                # Declined, NOT terminated: LiveKit may still place each elsewhere.
                self.assertEqual(sc["burst_refused_terminate"], [False])
                self.assertEqual(sc["launched_after_burst"], sc["burst_accepted"])
                self.assertEqual(sc["active_after_burst"], 1)
                # The agent participant is published under the per-machine name.
                self.assertEqual(sc["burst_agent_attr"], [report["registered"]])

    def test_a_busy_worker_declines_and_a_free_one_accepts_again(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.require_sdk(report)
                sc = report["scenario"]
                self.assertFalse(sc["busy_accepted"])
                self.assertEqual(sc["active_while_busy"], 1)
                self.assertTrue(sc["after_end_accepted"])

    def test_the_launch_window_is_covered(self):
        # Accepted, not yet assigned: no process exists, the reserved slot alone
        # must refuse the next offer.
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.require_sdk(report)
                sc = report["scenario"]
                self.assertEqual(sc["active_in_window"], 0)
                self.assertEqual(sc["reserved_in_window"], 1)
                self.assertFalse(sc["window_accepted"])
                self.assertEqual(sc["active_at_end"], 1)
                self.assertEqual(len(sc["launched_total"]), 2)
                self.assertEqual(sc["launched_total"][-1], "AJ_after_end")


class TestFlagAbsentIsToday(_ProcessFleet):
    """(3): the key absent (how PR #378 ships), on the R1 lane and the Cloud lane."""

    envs = _FLAG_ABSENT_ENVS

    def test_every_machine_registers_the_shared_base(self):
        for env, report in zip(self.envs, self.reports):
            with self.subTest(env=env):
                self.assertFalse(report["per_machine"])
                self.assertEqual(report["registered"], _BASE)
                self.assertEqual(report["options"]["agent_name"], _BASE)

    def test_readiness_bodies_are_the_pre_m019_bodies(self):
        for env, report in zip(self.envs, self.reports):
            with self.subTest(env=env):
                if env.get("R1_READINESS_HOST") == "on":
                    self.assertEqual(report["readiness"], [{"livekit_host": _HOST}])
                else:
                    self.assertEqual(report["readiness"], [{}])  # legacy {app, machine_id}

    def test_no_one_job_gate_without_its_own_opt_in(self):
        for env, report in zip(self.envs, self.reports):
            with self.subTest(env=env):
                load = report["options"].get("load_fnc")
                self.assertNotEqual(load, "fn:" + _ONE_JOB_FN)
                if report["real"]:
                    # The SDK's own CPU average and default threshold, as before.
                    self.assertEqual(report["server"]["load_fnc"],
                                     "fn:livekit.agents.worker._DefaultLoadCalc.get_load"
                                     "@_DefaultLoadCalc")
                    self.assertEqual(report["server"]["load_threshold"],
                                     {"dev": "inf", "prod": "0.7"})
                    self.assertEqual(report["start_path"],
                                     "agent_server" if env.get("R1_READINESS_HOST") == "on"
                                     else "worker_options")
                else:
                    self.assertIsNone(load)

    def test_options_do_not_vary_with_the_machine(self):
        # Flag absent, a machine's identity never reaches its options.
        by_lane: dict[str, list[dict]] = {}
        for env, report in zip(self.envs[:6], self.reports[:6]):
            by_lane.setdefault(env["LIVEKIT_URL"], []).append(report["options"])
        for lane, options in by_lane.items():
            with self.subTest(lane=lane):
                self.assertEqual(len(options), 3)
                self.assertTrue(all(o == options[0] for o in options))

    def test_job_acceptance_is_the_cpu_gated_acceptance_of_today(self):
        # Today (and on origin/main) the named browser worker is gated only by the
        # SDK's CPU average: the launch window is refused by the reserved slot, and
        # once the first job runs at ~0 CPU a second one IS accepted. Concurrency
        # stays safe only because the API admits one interview (setting default 1).
        for env, report in zip(self.envs, self.reports):
            with self.subTest(env=env):
                self.require_sdk(report)
                sc = report["scenario"]
                self.assertTrue(sc["cpu_default_load"])
                self.assertEqual(len(sc["burst_accepted"]), 1)
                self.assertTrue(sc["busy_accepted"])
                self.assertTrue(sc["after_end_accepted"])
                self.assertEqual(sc["burst_agent_attr"], [_BASE])


class TestOneJobSecretAloneIsToday(_ProcessFleet):
    """(3) cont.: BROWSER_WORKER_ONE_JOB=on with the flag absent is the pre-M019
    one-job gate on the shared name, unchanged."""

    envs = [{**_R1, "BROWSER_WORKER_ONE_JOB": "on", "FLY_MACHINE_ID": m} for m in _MACHINES[:2]]

    def test_shared_name_with_the_one_job_gate(self):
        for report in self.reports:
            with self.subTest(machine=report["machine"]):
                self.assertEqual(report["registered"], _BASE)
                self.assertEqual(report["options"]["load_fnc"], "fn:" + _ONE_JOB_FN)
                self.assertEqual(report["options"]["load_threshold"], 0.75)
                if report["real"]:
                    sc = report["scenario"]
                    self.assertEqual(len(sc["burst_accepted"]), 1)
                    self.assertFalse(sc["busy_accepted"])
                    self.assertFalse(sc["window_accepted"])


class TestFleetDispatch(unittest.TestCase):
    """(2) + (4) across the pool: LiveKit offers a job for name N only to workers
    registered under exactly N."""

    @classmethod
    def setUpClass(cls):
        cls.report = _run_machine(
            dict(_ON), {"mode": "fleet", "machines": list(_MACHINES), "base": _BASE})

    def setUp(self):
        if not self.report["real"]:
            self.skipTest("livekit-agents is not installed: the SDK-driven checks need it")

    def test_fifteen_interviews_land_one_per_leased_machine(self):
        names = self.report["names"]
        self.assertEqual(len(set(names.values())), _POOL)
        for i, machine in enumerate(_MACHINES):
            jid = f"AJ_session_{i:02d}"
            with self.subTest(job=jid):
                # Offered to its own machine ONLY, and accepted there.
                self.assertEqual(self.report["lease_offered"][jid], [machine])
                self.assertEqual(self.report["lease_placement"][jid], [machine])
        self.assertEqual(self.report["active_per_machine"], {m: 1 for m in _MACHINES})

    def test_an_interview_for_a_busy_machine_goes_nowhere_else(self):
        self.assertEqual(self.report["over_cap_offered"], [_MACHINES[0]])
        self.assertEqual(self.report["over_cap_placed"], [])
        self.assertEqual(self.report["active_after"], {m: 1 for m in _MACHINES})

    def test_names_no_machine_registered_reach_no_worker(self):
        # Including the shared base: once per-machine names are on, an API that
        # still dispatched to the base would reach nobody (the gate defers then).
        self.assertEqual(self.report["AJ_base"], [])
        self.assertEqual(self.report["AJ_unknown"], [])
        self.assertEqual(self.report["AJ_other_base"], [])


if __name__ == "__main__":
    unittest.main()
