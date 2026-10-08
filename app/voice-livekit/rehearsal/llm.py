"""LLM plumbing of the rehearsal harness: the key, the ledger, the clients and the 402 stop.

* ``load_api_env`` reads ``DEEPSEEK_API_KEY`` from ``app/api/.env`` into a plain dict (never
  into ``os.environ``); the dict goes to ``r1_llm.build_r1_llm(env)`` and to ``HttpxDeepSeek``.
  Nothing here prints, logs, repr()s or stores the key, and every error text is passed through
  a ``Scrubber`` before it leaves a client.
* ``Ledger`` counts calls, tokens, seconds and an estimated cost per role, enforces a budget and
  carries the one FATAL condition a sweep must stop on: an exhausted DeepSeek balance.
* ``HttpxDeepSeek`` is the pooled raw-HTTP client for the advisor simulator and the rubric
  judge (their models are not R1's whitelisted learner model, so ``build_r1_llm`` cannot build
  them).  HTTP 402 raises ``InsufficientBalance`` and marks the ledger fatal.
* ``RecordingProvider`` wraps any learner provider (the production client, or the offline
  fake) so the runner can keep the raw text before the guard, the first-token time and the
  token usage of every learner call, which the SDK seams otherwise discard.

No module-level import of httpx or the LiveKit SDK: the offline tests run on bare Python.
"""
from __future__ import annotations

import asyncio
import inspect
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Iterable, Mapping

from r1_replies import delta_text

KEY_NAME = "DEEPSEEK_API_KEY"
ENV_FILE_VAR = "REHEARSAL_ENV_FILE"
API_ROOT = "https://api.deepseek.com"
CHAT_URL = f"{API_ROOT}/v1/chat/completions"
BALANCE_URL = f"{API_ROOT}/user/balance"
TOP_UP_MESSAGE = (
    "The DeepSeek account behind app/api/.env has no balance (HTTP 402 Insufficient Balance). "
    "Top it up at https://platform.deepseek.com and run the sweep again."
)

# Estimated USD per million tokens (S0-B measurements, not re-verified against the live price
# list because the account had no balance): uncached input, cached input, output.
PRICE_IN_PER_M = 0.30
PRICE_CACHED_PER_M = 0.03
PRICE_OUT_PER_M = 1.20


class RehearsalLLMError(RuntimeError):
    """Base class of the harness's provider errors (texts are always scrubbed)."""


class MissingKey(RehearsalLLMError):
    """No DeepSeek key was found where the harness looks for it."""


class InsufficientBalance(RehearsalLLMError):
    """DeepSeek answered HTTP 402: the account has no balance.  A sweep stops cleanly."""


class BudgetExceeded(RehearsalLLMError):
    """The estimated spend passed ``--budget-usd``.  A sweep stops cleanly."""


class ProviderError(RehearsalLLMError):
    """Any other provider failure (auth, bad request, exhausted retries)."""


# ------------------------------------------------------------------------------------ key
def find_env_file(start: Path | None = None) -> Path | None:
    """``REHEARSAL_ENV_FILE``, else the nearest ``app/api/.env`` above ``start``.

    A git worktree has no ``.env`` (it is gitignored), so the walk continues up to the main
    checkout: ``.claude/worktrees/<name>/app/voice-livekit/rehearsal`` is three levels below it.
    """
    explicit = os.environ.get(ENV_FILE_VAR)
    if explicit:
        path = Path(explicit)
        return path if path.is_file() else None
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "app" / "api" / ".env"
        if candidate.is_file():
            return candidate
    return None


_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def read_dotenv_value(path: Path, name: str) -> str | None:
    """One value of a dotenv file, read without touching the process environment."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for raw in text.splitlines():
        match = _LINE.match(raw)
        if match is None or match.group(1) != name:
            continue
        value = match.group(2)
        quoted = re.match(r"""^(['"])(.*?)\1""", value)
        if quoted is not None:
            return quoted.group(2)
        return re.split(r"\s+#", value, maxsplit=1)[0].strip()
    return None


def load_api_env(path: Path | None = None) -> dict[str, str]:
    """``{DEEPSEEK_API_KEY: ...}`` read from the dev env file; raises ``MissingKey``."""
    env_file = path or find_env_file()
    if env_file is None:
        raise MissingKey(
            f"no app/api/.env found; set {ENV_FILE_VAR} to a dotenv file holding {KEY_NAME}"
        )
    value = read_dotenv_value(env_file, KEY_NAME)
    if not value:
        raise MissingKey(f"{KEY_NAME} is not set in {env_file.name}")
    return {KEY_NAME: value}


class Scrubber:
    """Replaces the secrets it was given (and anything shaped like a bearer key) in a text."""

    _SHAPES = (
        re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}"),
        re.compile(r"\bsk-[A-Za-z0-9]{8,}"),
    )

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets = tuple(sorted({s for s in secrets if s and len(s) >= 8}, key=len, reverse=True))

    def __call__(self, text: object) -> str:
        cleaned = str(text)
        for secret in self._secrets:
            cleaned = cleaned.replace(secret, "<redacted>")
        for shape in self._SHAPES:
            cleaned = shape.sub("<redacted>", cleaned)
        return cleaned

    def __repr__(self) -> str:  # never show what it hides
        return "Scrubber(<redacted>)"


def describe_error(exc: BaseException, scrub: Callable[[object], str], limit: int = 200) -> str:
    """``TypeName: message`` with secrets scrubbed and the length bounded."""
    return scrub(f"{type(exc).__name__}: {exc}")[:limit]


def status_of(exc: BaseException) -> int | None:
    """The HTTP status an SDK or httpx error carries, looking through the cause chain."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        for attr in ("status_code", "status"):
            value = getattr(current, attr, None)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        inner = getattr(current, "error", None)
        # The SDK wraps the API error (ErrorEvent -> LLMError -> APIStatusError); follow it
        # whatever its type, then the usual cause chain.
        current = inner if inner is not None else (
            getattr(current, "__cause__", None) or getattr(current, "__context__", None)
        )
    return None


def is_insufficient_balance(exc: BaseException) -> bool:
    return status_of(exc) == 402 or "insufficient balance" in str(exc).lower()


# ---------------------------------------------------------------------------------- ledger
@dataclass
class Ledger:
    """Calls, tokens, seconds and estimated cost by role, plus the fatal stop condition."""

    budget_usd: float | None = None
    calls: dict[str, int] = field(default_factory=dict)
    prompt_tokens: dict[str, int] = field(default_factory=dict)
    cached_tokens: dict[str, int] = field(default_factory=dict)
    completion_tokens: dict[str, int] = field(default_factory=dict)
    seconds: dict[str, float] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    fatal: str | None = None
    fatal_message: str = ""

    def record(self, role: str, usage: Mapping[str, Any] | None, seconds: float | None) -> None:
        self.calls[role] = self.calls.get(role, 0) + 1
        usage = usage or {}
        self.prompt_tokens[role] = self.prompt_tokens.get(role, 0) + int(usage.get("prompt") or 0)
        self.cached_tokens[role] = self.cached_tokens.get(role, 0) + int(usage.get("cached") or 0)
        self.completion_tokens[role] = self.completion_tokens.get(role, 0) + int(
            usage.get("completion") or 0
        )
        self.seconds[role] = self.seconds.get(role, 0.0) + float(seconds or 0.0)

    def note_error(self, message: str) -> None:
        if len(self.errors) < 50:
            self.errors.append(message)

    def mark_fatal(self, code: str, message: str) -> None:
        if self.fatal is None:
            self.fatal, self.fatal_message = code, message

    @property
    def cost_usd(self) -> float:
        total = 0.0
        for role in self.calls:
            prompt = self.prompt_tokens.get(role, 0)
            cached = min(self.cached_tokens.get(role, 0), prompt)
            total += (prompt - cached) * PRICE_IN_PER_M / 1e6
            total += cached * PRICE_CACHED_PER_M / 1e6
            total += self.completion_tokens.get(role, 0) * PRICE_OUT_PER_M / 1e6
        return total

    @property
    def over_budget(self) -> bool:
        return self.budget_usd is not None and self.cost_usd > self.budget_usd

    def merge(self, other: "Ledger | Mapping[str, Any]") -> None:
        """Add another ledger (or its ``summary``) in: the process pool returns summaries."""
        data = other.summary() if isinstance(other, Ledger) else other
        for key, target in (
            ("calls", self.calls),
            ("prompt_tokens", self.prompt_tokens),
            ("cached_tokens", self.cached_tokens),
            ("completion_tokens", self.completion_tokens),
        ):
            for role, value in (data.get(key) or {}).items():
                target[role] = target.get(role, 0) + int(value)
        for role, value in (data.get("seconds") or {}).items():
            self.seconds[role] = self.seconds.get(role, 0.0) + float(value)
        for message in data.get("errors") or []:
            self.note_error(str(message))
        if data.get("fatal"):
            self.mark_fatal(str(data["fatal"]), str(data.get("fatal_message") or ""))

    def summary(self) -> dict[str, Any]:
        return {
            "calls": dict(self.calls),
            "prompt_tokens": dict(self.prompt_tokens),
            "cached_tokens": dict(self.cached_tokens),
            "completion_tokens": dict(self.completion_tokens),
            "seconds": {role: round(value, 2) for role, value in self.seconds.items()},
            "estimated_cost_usd": round(self.cost_usd, 5),
            "budget_usd": self.budget_usd,
            "errors": list(self.errors),
            "fatal": self.fatal,
            "fatal_message": self.fatal_message,
        }


def usage_dict(usage: Any) -> dict[str, int]:
    """Prompt / cached / completion tokens from an SDK usage object or an API usage dict."""
    if usage is None:
        return {"prompt": 0, "cached": 0, "completion": 0}

    def pick(*names: str) -> int:
        for name in names:
            value = usage.get(name) if isinstance(usage, Mapping) else getattr(usage, name, None)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return int(value)
        return 0

    return {
        "prompt": pick("prompt_tokens"),
        "cached": pick("prompt_cached_tokens", "prompt_cache_hit_tokens", "cached_tokens"),
        "completion": pick("completion_tokens"),
    }


# -------------------------------------------------------------------------- raw HTTP client
@dataclass(frozen=True)
class Completion:
    text: str
    usage: dict[str, int]
    seconds: float
    model: str


class HttpxDeepSeek:
    """A pooled, non-streaming DeepSeek chat client (advisor simulator, rubric judge).

    ``thinking`` is a top-level field in raw HTTP (the SDK client sends it under
    ``extra_body``).  429 and 5xx are retried with backoff; 402 is final.
    """

    def __init__(
        self,
        env: Mapping[str, str],
        ledger: Ledger,
        *,
        timeout: float = 60.0,
        max_attempts: int = 4,
        transport: Any = None,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        key = env.get(KEY_NAME)
        if not key:
            raise MissingKey(f"{KEY_NAME} is not set")
        self._key = key
        self._scrub = Scrubber([key])
        self.ledger = ledger
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._transport = transport
        self._sleep = sleep
        self._client: Any = None

    def __repr__(self) -> str:
        return "HttpxDeepSeek(<redacted>)"

    def _http(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout),
                headers={"Authorization": f"Bearer {self._key}"},
                transport=self._transport,
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _check_state(self) -> None:
        if self.ledger.fatal == "insufficient_balance":
            raise InsufficientBalance(self.ledger.fatal_message or TOP_UP_MESSAGE)
        if self.ledger.over_budget:
            raise BudgetExceeded(
                f"estimated spend ${self.ledger.cost_usd:.3f} passed the budget "
                f"${self.ledger.budget_usd:.2f}"
            )

    def _insufficient(self) -> InsufficientBalance:
        self.ledger.mark_fatal("insufficient_balance", TOP_UP_MESSAGE)
        return InsufficientBalance(TOP_UP_MESSAGE)

    async def balance(self) -> dict[str, Any]:
        """``GET /user/balance``: ``{is_available, total, http_status}`` (no key in the result)."""
        import httpx

        try:
            response = await self._http().get(BALANCE_URL)
        except httpx.HTTPError as exc:
            raise ProviderError(f"balance check failed: {describe_error(exc, self._scrub)}") from None
        if response.status_code in (401, 403):
            raise ProviderError("balance check failed: the DeepSeek key was rejected (auth)")
        if response.status_code != 200:
            raise ProviderError(f"balance check failed: HTTP {response.status_code}")
        body = response.json() if response.content else {}
        infos = body.get("balance_infos") or []
        total = infos[0].get("total_balance") if infos and isinstance(infos[0], dict) else None
        return {
            "is_available": bool(body.get("is_available")),
            "total": total,
            "http_status": response.status_code,
        }

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        temperature: float,
        max_tokens: int,
        json_mode: bool = False,
        role: str = "advisor",
    ) -> Completion:
        import httpx

        self._check_state()
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
            "thinking": {"type": "disabled"},
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        last = "no attempt was made"
        for attempt in range(self._max_attempts):
            started = time.perf_counter()
            try:
                response = await self._http().post(CHAT_URL, json=body)
            except httpx.HTTPError as exc:
                last = describe_error(exc, self._scrub)
                await self._sleep(min(8.0, 1.0 * (2**attempt)))
                continue
            elapsed = time.perf_counter() - started
            status = response.status_code
            if status == 402:
                raise self._insufficient()
            if status in (401, 403):
                raise ProviderError("the DeepSeek key was rejected (auth)")
            if status == 429 or status >= 500:
                last = f"HTTP {status}"
                retry_after = response.headers.get("retry-after", "")
                delay = float(retry_after) if retry_after.replace(".", "", 1).isdigit() else 1.0 * (2**attempt)
                await self._sleep(min(30.0, delay))
                continue
            if status >= 400:
                raise ProviderError(f"HTTP {status}: {self._scrub(response.text[:200])}")
            try:
                data = response.json()
                text = data["choices"][0]["message"]["content"] or ""
            except (ValueError, KeyError, IndexError, TypeError):
                raise ProviderError("the DeepSeek reply had an unexpected shape") from None
            usage = usage_dict(data.get("usage"))
            self.ledger.record(role, usage, elapsed)
            return Completion(str(text), usage, elapsed, model)
        self.ledger.note_error(f"{role}: gave up after {self._max_attempts} attempts ({last})")
        raise ProviderError(f"gave up after {self._max_attempts} attempts ({last})")


async def preflight(
    client: HttpxDeepSeek, models: Iterable[str], *, probe: bool = True
) -> dict[str, Any]:
    """Balance first, then one tiny chat per model.  Raises ``InsufficientBalance`` on a 402."""
    state = await client.balance()
    result: dict[str, Any] = {"balance": state, "models": {}}
    if not state["is_available"]:
        raise client._insufficient()
    if not probe:
        return result
    for model in dict.fromkeys(models):
        try:
            await client.complete(
                [{"role": "user", "content": "Reply with the single word ok."}],
                model=model,
                temperature=0.0,
                max_tokens=5,
                role="preflight",
            )
            result["models"][model] = "ok"
        except InsufficientBalance:
            raise
        except ProviderError as exc:
            result["models"][model] = str(exc)[:120]
    return result


# --------------------------------------------------------------------- learner provider side
def make_live_learner_provider(
    env: Mapping[str, str], ledger: Ledger, *, learner: Any = None
) -> Callable[[list], Any]:
    """The production learner client (``r1_llm.build_r1_llm``) as a ``provider(messages)``.

    Exactly what ``R1Agent.llm_node`` hands the SDK: the filtered messages as a chat context,
    no tools.  Chunks are passed through unchanged, so the session's own guard, cutoff and
    failure counting see what they see in production.
    """
    from r1_llm import build_r1_llm
    from r1_session import _chat_context_from

    learner = learner if learner is not None else build_r1_llm(dict(env))

    async def stream(messages: list[dict[str, str]]) -> AsyncIterator[Any]:
        async with learner.chat(chat_ctx=_chat_context_from(messages)) as chunks:
            async for chunk in chunks:
                yield chunk

    return stream


def make_live_judge_runner(
    env: Mapping[str, str], ledger: Ledger, *, judge_llm: Any = None
) -> Callable[[list], Any]:
    """The shadow judge on R1's own judge client (temperature 0), as ``judge_runner``."""
    from r1_llm import build_r1_judge_llm
    from r1_session import _chat_context_from

    holder: dict[str, Any] = {} if judge_llm is None else {"llm": judge_llm}
    scrub = Scrubber([env.get(KEY_NAME, "")])

    async def run(messages: list[dict[str, str]]) -> str:
        if "llm" not in holder:
            holder["llm"] = build_r1_judge_llm(dict(env))
        started = time.perf_counter()
        parts: list[str] = []
        usage = None
        try:
            async with holder["llm"].chat(chat_ctx=_chat_context_from(messages)) as chunks:
                async for chunk in chunks:
                    parts.append(delta_text(chunk))
                    usage = getattr(chunk, "usage", None) or usage
        except Exception as exc:  # noqa: BLE001
            if is_insufficient_balance(exc):
                ledger.mark_fatal("insufficient_balance", TOP_UP_MESSAGE)
            ledger.note_error(f"shadow_judge: {describe_error(exc, scrub)}")
            raise
        ledger.record("shadow_judge", usage_dict(usage), time.perf_counter() - started)
        return "".join(parts)

    return run


class RecordingProvider:
    """Wraps a learner ``provider(messages)`` and keeps one log entry per model call.

    Each entry holds the raw text the model produced (before the guard), the first-token and
    total times, the token usage and any error.  ``take()`` returns and clears the entries
    made since the last call, which is how the runner attaches them to an exchange.
    """

    def __init__(
        self,
        inner: Callable[[list], Any],
        ledger: Ledger,
        *,
        scrub: Callable[[object], str] | None = None,
        role: str = "learner",
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self._inner = inner
        self._ledger = ledger
        self._scrub = scrub or Scrubber()
        self._role = role
        self._clock = clock
        self._entries: list[dict[str, Any]] = []

    def __call__(self, messages: list[dict[str, str]]) -> AsyncIterator[Any]:
        entry: dict[str, Any] = {
            "raw": "",
            "first_token": None,
            "total": None,
            "usage": None,
            "error": None,
            "prompt_chars": sum(len(m.get("content", "")) for m in messages),
        }
        self._entries.append(entry)
        return self._stream(messages, entry)

    async def _stream(self, messages: list[dict[str, str]], entry: dict[str, Any]) -> AsyncIterator[Any]:
        started = self._clock()
        try:
            source = self._inner(messages)
            if inspect.isawaitable(source):
                source = await source
            async for item in source:
                text = delta_text(item)
                if text:
                    if entry["first_token"] is None:
                        entry["first_token"] = self._clock() - started
                    entry["raw"] += text
                usage = getattr(item, "usage", None)
                if usage is not None:
                    entry["usage"] = usage_dict(usage)
                yield item
        except Exception as exc:  # noqa: BLE001 - recorded, then the session decides
            entry["error"] = describe_error(exc, self._scrub)
            if is_insufficient_balance(exc):
                self._ledger.mark_fatal("insufficient_balance", TOP_UP_MESSAGE)
            self._ledger.note_error(f"{self._role}: {entry['error']}")
            raise
        finally:
            entry["total"] = self._clock() - started
            self._ledger.record(self._role, entry["usage"], entry["total"])

    def take(self) -> list[dict[str, Any]]:
        entries, self._entries = self._entries, []
        return entries
