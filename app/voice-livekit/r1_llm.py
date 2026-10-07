"""R1-only DeepSeek construction and response guards.

This module has no phone imports or mutable shared provider configuration.  The
stream timeout in ``r1_session`` remains the authority for the per-turn wall
clock; the helper here makes standalone deadline tests possible as well.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, Awaitable
from urllib.parse import urlparse

DEFAULT_MODEL = "deepseek-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
TURN_DEADLINE_SEC = 12.0
ALLOWED_MODELS = frozenset({DEFAULT_MODEL})
LEARNER_TEMPERATURE = 0.6
# The shadow judge GRADES (plan 5.9): its family quality is max-latched in the tracker and its
# probes release needs, and both feed the commitment grade.  Sampling it at the learner's 0.6
# would let the same conversation earn WEAK, MEDIUM or STRONG on different runs, so it runs
# greedy.  No ``seed`` is sent: the DeepSeek API documentation lists no such parameter.
JUDGE_TEMPERATURE = 0.0


class R1LLMConfigurationError(RuntimeError):
    """R1's fail-closed provider configuration error."""


def r1_llm_config(
    environ: dict[str, str] | None = None, *, temperature: float = LEARNER_TEMPERATURE
) -> dict[str, Any]:
    """Return the only allowed DeepSeek configuration with thinking disabled.

    ``temperature`` is the one knob that differs by role: the learner speaks at 0.6, the
    judge grades at 0.  Everything else (model, host, key, thinking, token cap) is shared.
    """
    if environ is None:
        # Keep literal getenv calls visible to the repository's env-contract scanner.
        model = os.getenv("R1_LLM_MODEL") or DEFAULT_MODEL
        base_url = os.getenv("R1_LLM_BASE_URL") or DEFAULT_BASE_URL
        api_key = os.getenv("DEEPSEEK_API_KEY")
    else:
        model = environ.get("R1_LLM_MODEL") or DEFAULT_MODEL
        base_url = environ.get("R1_LLM_BASE_URL") or DEFAULT_BASE_URL
        api_key = environ.get("DEEPSEEK_API_KEY")
    parsed = urlparse(base_url)
    valid_url = (
        parsed.scheme == "https"
        and parsed.hostname == "api.deepseek.com"
        and parsed.username is None
        and parsed.password is None
        and parsed.port is None
        and parsed.path in ("", "/v1")
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )
    if not valid_url or model not in ALLOWED_MODELS:
        raise R1LLMConfigurationError("r1_llm_not_deepseek")
    if not api_key:
        raise R1LLMConfigurationError("r1_llm_key_missing")
    return {
        "model": model,
        "base_url": base_url,
        "api_key": api_key,
        "temperature": temperature,
        "reasoning_effort": "none",
        "extra_body": {"thinking": {"type": "disabled"}, "max_tokens": 300},
    }


def build_r1_llm(
    environ: dict[str, str] | None = None, *, temperature: float = LEARNER_TEMPERATURE
) -> Any:
    """Build the isolated OpenAI-compatible client with one retry below R1's wall clock."""
    config = r1_llm_config(environ, temperature=temperature)
    try:
        import httpx
        from livekit.plugins import openai
    except ImportError as exc:  # Bare unit tests intentionally do not install SDK plugins.
        raise R1LLMConfigurationError("r1_llm_dependency_unavailable") from exc
    return openai.LLM(
        **config,
        timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0),
        max_retries=1,
    )


def build_r1_judge_llm(environ: dict[str, str] | None = None) -> Any:
    """Build the shadow judge's client: R1's own DeepSeek client, sampled deterministically."""
    return build_r1_llm(environ, temperature=JUDGE_TEMPERATURE)


async def with_turn_deadline(
    awaitable: Awaitable[Any],
    timeout: float = TURN_DEADLINE_SEC,
) -> Any:
    """Enforce a generation wall clock; SSE keepalives must not count as progress."""
    return await asyncio.wait_for(awaitable, timeout=timeout)


def assert_thinking_disabled(usage: Any) -> None:
    """Reject observed reasoning tokens; callers pass the SDK usage object directly."""
    reasoning = getattr(usage, "reasoning_tokens", 0)
    if reasoning and reasoning > 0:
        raise RuntimeError("r1_llm_reasoning_tokens_observed")


def r1_provenance(environ: dict[str, str] | None = None) -> dict[str, Any]:
    """Build R1 provenance through the shared validator without changing its contract."""
    model = (
        os.getenv("R1_LLM_MODEL")
        if environ is None
        else environ.get("R1_LLM_MODEL")
    ) or DEFAULT_MODEL
    from provenance import create_provenance

    return create_provenance(
        provider="deepseek",
        requested_model=model,
        workload="screening",
        prompt_template_version="r1-pr4a-unpinned",
        inference_params={"temperature": LEARNER_TEMPERATURE, "max_tokens": 300},
    )
