"""R1 rehearsal harness: simulated advisor calls against the REAL learner engine.

Run it from ``app/voice-livekit``::

    python -m rehearsal --calls 8 --personas strong,average --out <dir> [--offline]

What it does, call by call:

* an ADVISOR simulator (DeepSeek, or a scripted stand-in with ``--offline``) plays the
  candidate: five behaviours (strong, average, weak, pushy discounter, short answers);
* the LEARNER is the production code path: a real ``R1Interview`` driven through the same
  SDK seams the live session uses (``tests.test_r1_integration.Rig``), the real
  ``RolePlayEngine`` and the real guard, with the production DeepSeek client built by
  ``r1_llm.build_r1_llm`` (or a scripted fake model offline);
* a modelled clock advances the role-play seconds R the way real calls do (about 35 s per
  exchange), so the owed-move schedule, the close window and the 13:00 stall all fire;
* every call is written as JSON (rows in the database export schema, the plan of every
  learner turn, the raw model text before the guard, the administration log);
* deterministic metrics (``metrics``) and an LLM rubric judge (``judge``) score each call, and
  ``scorecard`` aggregates them against pass thresholds.

This package is NOT named ``r1_*``, is not copied into the worker image and never runs in CI
against the network.  Its unit tests (``tests/test_r1_rehearsal_*.py``) are offline.  The
API key (``DEEPSEEK_API_KEY`` in ``app/api/.env``) is read into an in-memory dict only; it is
never printed, logged or written, and every error text is scrubbed before it leaves a client.
"""

import sys
from pathlib import Path

HARNESS_VERSION = 1

# The worker modules (``r1_*``) and the test fakes (``tests``) sit next to this package; make
# them importable however the package itself was found (``python -m rehearsal`` from
# ``app/voice-livekit``, a PYTHONPATH entry, a spawned worker process).
_WORKER_DIR = str(Path(__file__).resolve().parents[1])
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)
