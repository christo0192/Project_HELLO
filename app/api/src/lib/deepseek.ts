/**
 * deepseek.ts — DeepSeek HTTP runner with circuit breaker, timeout,
 * bounded response parsing, JSON extraction, and deterministic errors.
 *
 * OUTBOUND BOUNDARY: HTTPS POST to an OpenAI-compatible chat-completions API.
 * No provider secret is logged or returned in errors.
 */

import { env } from './env.js';
import { createLogger } from './logger.js';
import {
  BusinessError,
  CircuitBreaker,
  DefaultTimerSet,
  isProviderFailure,
  MonotonicClock,
  ProviderError,
  type Clock,
  type TimerSet,
} from './provider-resilience.js';

const deepseekLogger = createLogger('deepseek');

export type DeepseekErrorCategory =
  | 'timeout'
  | 'missing_api_key'
  | 'connection'
  | 'protocol'
  | 'parse_error'
  | 'output_limit'
  /**
   * JSON-mode answer with blank `content`. DeepSeek documents that JSON Output
   * "may occasionally return empty content". Raised ONLY when the caller asked
   * for `responseFormat: 'json_object'` — a blank answer on the plain path
   * keeps its historical treatment (the JSON runner's own re-ask, then
   * `parse_error`). Not a breaker failure: it is a provider hiccup, not an
   * outage, and `isProviderFailure` does not list it.
   */
  | 'empty_content';

export class DeepseekError extends Error {
  public readonly category: DeepseekErrorCategory;
  public readonly status: number | null;

  constructor(category: DeepseekErrorCategory, status: number | null = null) {
    super(category);
    this.name = 'DeepseekError';
    this.category = category;
    this.status = status;
  }
}

export function isDeepseekProviderFailure(err: unknown): boolean {
  if (err instanceof DeepseekError) {
    return err.category !== 'parse_error' && err.category !== 'empty_content';
  }
  return isProviderFailure(err);
}

export interface DeepseekOptions {
  model?: string;
  system?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * reasoning_effort override. An empty string (or unset) OMITS the field from
   * the request body — which on V4-Flash means MODEL-DEFAULT reasoning, NOT
   * "off" (V4-Flash thinks by default when the field is absent; PR #238).
   * 'none' disables reasoning; 'high' / 'xhigh' increase it. Any non-empty
   * string is forwarded verbatim as `reasoning_effort`. Falls back to
   * env.deepseekReasoningEffort when unset.
   */
  reasoningEffort?: string;
  /**
   * Provider-enforced JSON output. When `'json_object'`, the request carries
   * `response_format: { type: 'json_object' }` (DeepSeek "JSON Output" mode) so
   * the model is constrained to emit one valid JSON object instead of prose
   * wrapped around JSON. OPT-IN per call, never a default: the provider
   * requires the word "json" to appear in the prompt, and a caller whose
   * prompt lacks it would turn a good request into a 4xx. Only callers that
   * already `JSON.parse` the answer and whose prompt asks for JSON set this.
   */
  responseFormat?: 'json_object';
}

/**
 * Prefix-cache accounting surfaced from the DeepSeek `usage` object. DeepSeek
 * context caching is AUTOMATIC (no request flag); the provider reports how many
 * prompt tokens were served from cache vs recomputed. Non-negative integers;
 * a field the provider omitted (or a non-DeepSeek response) reports 0.
 */
export interface DeepseekCacheUsage {
  hitTokens: number;
  missTokens: number;
}

/** Sink for prefix-cache accounting. Never throws into the request path. */
export type DeepseekCacheSink = (usage: DeepseekCacheUsage) => void;

export interface DeepseekTransportRequest {
  url: string;
  init: RequestInit;
}

export interface DeepseekTransportResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type DeepseekTransport = (
  req: DeepseekTransportRequest,
) => Promise<DeepseekTransportResponse>;

export interface DeepseekRunnerDeps {
  transport: DeepseekTransport;
  clock: Clock;
  timers: TimerSet;
  breaker: CircuitBreaker;
  /** Prefix-cache accounting sink. Defaults to a structured-log emitter. */
  cacheSink: DeepseekCacheSink;
}

export interface DeepseekRunner {
  runDeepseek(prompt: string, opts?: DeepseekOptions): Promise<string>;
  runDeepseekJSON<T>(prompt: string, opts?: DeepseekOptions): Promise<T>;
  runDeepseekJSONWithProvenance<T>(
    prompt: string,
    opts?: DeepseekOptions,
  ): Promise<{ data: T; requestedModel: string }>;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';

function defaultTransport(req: DeepseekTransportRequest): Promise<DeepseekTransportResponse> {
  return fetch(req.url, req.init) as Promise<DeepseekTransportResponse>;
}

function validateRuntimeOverrides(opts: DeepseekOptions): void {
  if (opts.timeoutMs !== undefined) {
    const t = opts.timeoutMs;
    if (typeof t !== 'number' || !Number.isFinite(t) || !Number.isInteger(t) || t < 0) {
      throw new TypeError('timeoutMs must be a non-negative integer');
    }
    if (t > 300_000) throw new TypeError('timeoutMs must not exceed 300000');
  }
  if (opts.maxOutputBytes !== undefined) {
    const b = opts.maxOutputBytes;
    if (typeof b !== 'number' || !Number.isFinite(b) || !Number.isInteger(b) || b <= 0) {
      throw new TypeError('maxOutputBytes must be a positive integer');
    }
    if (b > 500 * 1024 * 1024) throw new TypeError('maxOutputBytes must not exceed 500 MiB');
  }
  if (opts.model !== undefined) {
    if (typeof opts.model !== 'string' || opts.model.trim().length === 0) {
      throw new TypeError('model must be a non-empty string');
    }
    if (opts.model.length > 200) throw new TypeError('model must not exceed 200 characters');
  }
  if (opts.system !== undefined) {
    if (typeof opts.system !== 'string') throw new TypeError('system must be a string');
    if (opts.system.length > 4000) throw new TypeError('system must not exceed 4000 characters');
  }
  if (opts.reasoningEffort !== undefined) {
    if (typeof opts.reasoningEffort !== 'string') {
      throw new TypeError('reasoningEffort must be a string');
    }
    if (opts.reasoningEffort.length > 64) {
      throw new TypeError('reasoningEffort must not exceed 64 characters');
    }
  }
  if (opts.responseFormat !== undefined && opts.responseFormat !== 'json_object') {
    throw new TypeError("responseFormat must be 'json_object' when given");
  }
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[[{]/);
  if (start === -1) return body.trim();
  const lastObj = body.lastIndexOf('}');
  const lastArr = body.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  return end > start ? body.slice(start, end + 1) : body.slice(start).trim();
}

function parseContent(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new DeepseekError('protocol');
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new DeepseekError('protocol');
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first.message?.content ?? first.text;
  if (typeof content !== 'string') throw new DeepseekError('protocol');
  return content.trim();
}

/** Coerce a provider-reported token count to a non-negative safe integer. */
function coerceTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Parse `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` from an
 * already-successful response body. Never throws: a body that is not JSON, has
 * no usage object, or omits the cache fields (older or non-DeepSeek responses)
 * reports zeros so the caller can still record a metric point.
 */
function extractCacheUsage(rawBody: string): DeepseekCacheUsage {
  try {
    const parsed = JSON.parse(rawBody) as { usage?: unknown };
    const usage = parsed.usage;
    if (usage === null || typeof usage !== 'object') return { hitTokens: 0, missTokens: 0 };
    const u = usage as Record<string, unknown>;
    return {
      hitTokens: coerceTokenCount(u.prompt_cache_hit_tokens),
      missTokens: coerceTokenCount(u.prompt_cache_miss_tokens),
    };
  } catch {
    return { hitTokens: 0, missTokens: 0 };
  }
}

/**
 * Default cache sink: emit ONE structured metric line per successful call. The
 * logger's metadata allowlist does not carry cache-token keys, so counts ride
 * the allowlisted `error_type` string as `resume_model_cache:hit-<n>:miss-<m>`
 * — a stable, greppable marker for verifying prefix-cache hits at scale. The
 * separators (`:` `-`) are inside the logger's SAFE_IDENT allowlist so the
 * field is never dropped. Wrapped so a logging fault can never surface on the
 * request path.
 */
export function formatCacheMarker(usage: DeepseekCacheUsage): string {
  return `resume_model_cache:hit-${usage.hitTokens}:miss-${usage.missTokens}`;
}

function defaultCacheSink(usage: DeepseekCacheUsage): void {
  try {
    deepseekLogger.info('unknown_event', { error_type: formatCacheMarker(usage) });
  } catch {
    /* metric logging must never break inference */
  }
}

export function createDeepseekRunner(deps?: Partial<DeepseekRunnerDeps>): DeepseekRunner {
  const transport = deps?.transport ?? defaultTransport;
  const clock = deps?.clock ?? MonotonicClock;
  const timers = deps?.timers ?? DefaultTimerSet;
  const cacheSink = deps?.cacheSink ?? defaultCacheSink;
  const breaker = deps?.breaker ?? new CircuitBreaker({
    failureThreshold: env.breakerFailureThreshold,
    cooldownMs: env.breakerCooldownMs,
    clock,
    timers,
  });

  async function runDeepseek(prompt: string, opts: DeepseekOptions = {}): Promise<string> {
    validateRuntimeOverrides(opts);
    const apiKey = process.env.DEEPSEEK_API_KEY ?? env.deepseekApiKey;
    if (!apiKey) throw new DeepseekError('missing_api_key');

    const model = opts.model ?? env.deepseekModel;
    const timeoutMs = opts.timeoutMs ?? env.deepseekTimeoutMs;
    const maxOutputBytes = opts.maxOutputBytes ?? env.deepseekMaxOutputBytes;
    // Empty string ⇒ omit reasoning_effort (fast default, no 400 risk).
    const reasoningEffort = opts.reasoningEffort ?? env.deepseekReasoningEffort;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });

    // Stable request body. `reasoning_effort` is added ONLY when non-empty so
    // the default fast path sends a byte-identical prompt prefix (the automatic
    // prefix cache keys on that prefix — do not reorder or mutate it).
    const requestBody: {
      model: string;
      messages: typeof messages;
      temperature: number;
      reasoning_effort?: string;
      response_format?: { type: 'json_object' };
    } = { model, messages, temperature: 0.2 };
    if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
      requestBody.reasoning_effort = reasoningEffort;
    }
    // Appended AFTER the messages, so the cached prompt prefix is untouched:
    // the automatic prefix cache keys on message tokens, not on this field.
    if (opts.responseFormat === 'json_object') {
      requestBody.response_format = { type: 'json_object' };
    }

    return breaker.call(async () => {
      try {
        timer = timers.setTimeout(() => controller.abort(), timeoutMs);
        const response = await transport({
          url: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
          init: {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          },
        });
        const raw = await response.text();
        if (Buffer.byteLength(raw, 'utf8') > maxOutputBytes) {
          throw new DeepseekError('output_limit');
        }
        if (!response.ok) throw new DeepseekError('protocol', response.status);
        const content = parseContent(raw);
        if (opts.responseFormat === 'json_object' && content === '') {
          throw new DeepseekError('empty_content');
        }
        // Surface automatic prefix-cache accounting. Extraction never throws;
        // the sink is wrapped so it cannot fault the request path.
        cacheSink(extractCacheUsage(raw));
        return content;
      } catch (err) {
        if (err instanceof DeepseekError) throw err;
        if ((err as { name?: string })?.name === 'AbortError') throw new DeepseekError('timeout');
        if (err instanceof ProviderError) throw err;
        throw new DeepseekError('connection');
      } finally {
        if (timer !== null) timers.clearTimeout(timer);
      }
    });
  }

  async function runDeepseekJSON<T = unknown>(prompt: string, opts: DeepseekOptions = {}): Promise<T> {
    const raw = await runDeepseek(prompt, opts);
    try {
      return JSON.parse(extractJson(raw)) as T;
    } catch {
      const raw2 = await runDeepseek(prompt, opts);
      try {
        return JSON.parse(extractJson(raw2)) as T;
      } catch {
        throw new BusinessError();
      }
    }
  }

  async function runDeepseekJSONWithProvenance<T = unknown>(
    prompt: string,
    opts: DeepseekOptions = {},
  ): Promise<{ data: T; requestedModel: string }> {
    const requestedModel = opts.model ?? env.deepseekModel;
    const data = await runDeepseekJSON<T>(prompt, opts);
    return { data, requestedModel };
  }

  return { runDeepseek, runDeepseekJSON, runDeepseekJSONWithProvenance };
}

const defaultRunner = createDeepseekRunner();
export const runDeepseek = defaultRunner.runDeepseek;
export const runDeepseekJSON = defaultRunner.runDeepseekJSON;
export const runDeepseekJSONWithProvenance = defaultRunner.runDeepseekJSONWithProvenance;
