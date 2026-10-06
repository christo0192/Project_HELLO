"""Isolated text-only S0-B persona and latency harness.

Nothing in this package is imported by the LiveKit worker.  It deliberately
uses only the Python standard library plus the worker's pinned ``httpx``.
"""
