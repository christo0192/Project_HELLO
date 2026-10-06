"""Exact disposable endpoint fence shared by the local spike workers."""

from urllib.parse import urlparse


SPIKE_HOST = "project-hello-r1-rtc-spike.fly.dev"


def assert_spike_url(value: str, name: str = "LIVEKIT_URL") -> None:
    """Accept only the disposable spike HTTPS/WSS host, with no userinfo or port."""
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an absolute wss:// or https:// URL") from exc
    if (
        parsed.scheme not in {"wss", "https"}
        or (parsed.hostname or "").lower() != SPIKE_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
    ):
        raise RuntimeError(
            f"{name} must use the approved disposable spike host without credentials or a port"
        )
