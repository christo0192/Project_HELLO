# Seeded SAFE fixture for TST-05 (scripts/sast.test.mjs).
# subprocess with shell=False is the sanctioned pattern (S101 must NOT match).
import subprocess


def run_safe(cmd, args):
    # Argument-array form; shell=False is explicit and safe.
    subprocess.run([cmd, *args], shell=False)
    return 0
