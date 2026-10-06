"""R1-only DeepSeek construction; this deliberately does not touch phone setup."""
from __future__ import annotations

import asyncio
import os
from urllib.parse import urlparse
from typing import Any, Awaitable

DEFAULT_MODEL = "deepseek-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
TURN_DEADLINE_SEC = 12.0


class R1LLMConfigurationError(RuntimeError):
    pass


def r1_llm_config(environ: dict[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    model = (os.getenv("R1_LLM_MODEL") if environ is None else env.get("R1_LLM_MODEL")) or DEFAULT_MODEL
    base_url = (os.getenv("R1_LLM_BASE_URL") if environ is None else env.get("R1_LLM_BASE_URL")) or DEFAULT_BASE_URL
    host = (urlparse(base_url).hostname or "").lower()
    if host != "api.deepseek.com" or not model.startswith("deepseek"):
        raise R1LLMConfigurationError("r1_llm_not_deepseek")
    if not env.get("DEEPSEEK_API_KEY"):
        raise R1LLMConfigurationError("r1_llm_key_missing")
    return {"model": model, "base_url": base_url, "api_key": env["DEEPSEEK_API_KEY"], "temperature": 0.6,
            "reasoning_effort": "none", "extra_body": {"thinking": {"type": "disabled"}, "max_tokens": 300}}


def build_r1_llm(environ: dict[str, str] | None = None) -> Any:
    config = r1_llm_config(environ)
    try:
        import httpx
        from livekit.plugins import openai
    except ImportError as exc:  # exercised by bare unittest stubs
        raise R1LLMConfigurationError("r1_llm_dependency_unavailable") from exc
    return openai.LLM(**config, timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0))


async def with_turn_deadline(awaitable: Awaitable[Any], timeout: float = TURN_DEADLINE_SEC) -> Any:
    """Wall-clock timeout: provider SSE keepalives are not progress."""
    task = asyncio.ensure_future(awaitable)
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if done:
        return task.result()
    task.cancel()
    raise TimeoutError("r1_llm_turn_deadline")


def assert_thinking_disabled(response: Any) -> None:
    usage = getattr(response, "usage", None)
    reasoning = getattr(usage, "reasoning_tokens", 0) if usage is not None else 0
    if reasoning and reasoning > 0:
        raise RuntimeError("r1_llm_reasoning_tokens_observed")


def r1_provenance(environ: dict[str, str] | None = None) -> dict[str, Any]:
    """Build R1 provenance through the shared validator without changing it."""
    env = os.environ if environ is None else environ
    model = (os.getenv("R1_LLM_MODEL") if environ is None else env.get("R1_LLM_MODEL")) or DEFAULT_MODEL
    from provenance import create_provenance
    return create_provenance(
        provider="deepseek", requested_model=model, workload="screening",
        prompt_template_version="r1-pr4a-unpinned",
        inference_params={"temperature": 0.6, "max_tokens": 300},
    )
