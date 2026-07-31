# Seeded SHELL-FALSE-THEN-TRUE fixture for TST-05 (scripts/sast.test.mjs).
# Regression test for F2: a SAFE subprocess.run with shell=False on one line
# followed by an UNSAFE subprocess.run with shell=True on another line must
# ONLY flag the unsafe line (correct-line attribution). The original [\s\S]*?
# gap could span both lines and mis-attribute or false-positive.
import subprocess


def safe_then_unsafe(cmd, args):
    # Line 9: SAFE — shell=False. Must NOT be flagged.
    subprocess.run([cmd, *args], shell=False)
    # Line 11: UNSAFE — shell=True. MUST be flagged HERE.
    subprocess.run(cmd, shell=True)
    return 0
