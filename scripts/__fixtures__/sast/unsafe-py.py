# Seeded UNSAFE fixture for TST-05 (scripts/sast.test.mjs).
# Intentional dangerous-code patterns that the offline SAST must flag.
import subprocess
import os
import pickle


def handle(cmd: str, blob: bytes):
    # S101: subprocess with shell=True
    subprocess.run(cmd, shell=True)
    # S102: os.system
    os.system(cmd)
    # S103: dynamic exec
    exec(cmd)
    # S104: unsafe pickle deserialization
    return pickle.loads(blob)
