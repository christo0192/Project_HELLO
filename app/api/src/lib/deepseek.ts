/**
 * deepseek.ts — DeepSeek HTTP runner with circuit breaker, timeout,
 * bounded response parsing, JSON extraction, and deterministic errors.
 *
 * OUTBOUND BOUNDARY: HTTPS POST to an OpenAI-compatible chat-completions API.
 * No provider secret is logged or returned in errors.
 */

import { env } from './env.js';
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

export type DeepseekErrorCategory =
  | 'timeout'
  | 'missing_api_key'
  | 'connection'
  | 'protocol'
  | 'parse_error'
  | 'output_limit';

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
  if (err instanceof DeepseekError) return err.category !== 'parse_error';
  return isProviderFailure(err);
}

export interface DeepseekOptions {
  model?: string;
  system?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

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

export function createDeepseekRunner(deps?: Partial<DeepseekRunnerDeps>): DeepseekRunner {
  const transport = deps?.transport ?? defaultTransport;
  const clock = deps?.clock ?? MonotonicClock;
  const timers = deps?.timers ?? DefaultTimerSet;
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
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });

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
            body: JSON.stringify({ model, messages, temperature: 0.2 }),
            signal: controller.signal,
          },
        });
        const raw = await response.text();
        if (Buffer.byteLength(raw, 'utf8') > maxOutputBytes) {
          throw new DeepseekError('output_limit');
        }
        if (!response.ok) throw new DeepseekError('protocol', response.status);
        return parseContent(raw);
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
