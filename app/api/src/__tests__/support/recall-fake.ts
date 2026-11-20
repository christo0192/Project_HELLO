/**
 * An in-memory Recall.ai double for tests (S01 plan T3), shared with the later Meet slices.
 *
 * It speaks the subset of the REST API the client uses and behaves like Recall where it matters:
 * - `Authorization: Token <apiKey>` is checked on every call (401 otherwise).
 * - `POST /api/v1/bot/` answers 201 with a deterministic lowercase UUID, echoing `join_at` and
 *   `metadata`, with one `ready` status change.
 * - POST responses are cached by `Idempotency-Key` + method + path, so a replay returns the SAME
 *   bot without creating another (Recall caches for an hour; 429/507 are never cached).
 * - `GET` of an unknown bot is 404; `DELETE` is 204, or 405 once the bot was dispatched
 *   (`markDispatched`, or after `leave_call`).
 * - `leave_call` answers 200 with the bot and an appended `call_ended` status change.
 * - `output_media` POST/DELETE answer 200 `{}`.
 * - `failNext` injects one canned response for the next call (e.g. 429 with `Retry-After: 7`).
 *
 * `calls` records `{method, path, headers, body}` with the authorization value replaced by
 * `<redacted>` and the body parsed as JSON (null when absent). Responses include `meeting_url`,
 * `recordings` and `recording_config`, so tests can prove the client's parser drops them.
 *
 * Never shipped: `tsconfig.build.json` excludes `src/__tests__`.
 */
import type { RecallTransport, RecallTransportRequest, RecallTransportResponse } from '../../integrations/recall/client.js';

/** Low-entropy fixture key (never a real-looking secret). */
export const FAKE_RECALL_API_KEY = 'recall-fake-' + 'k'.repeat(24);

const DEFAULT_NOW = () => new Date('2026-12-01T10:00:00.000Z');

export interface FakeRecallCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeRecallStatusChange {
  code: string;
  sub_code: string | null;
  message: string;
  created_at: string;
}

export interface FakeRecallBot {
  id: string;
  meeting_url: unknown;
  join_at: string | null;
  metadata: Record<string, string>;
  status_changes: FakeRecallStatusChange[];
  dispatched: boolean;
  outputMedia: 'none' | 'webpage';
  /** The last create body, as sent. */
  request: Record<string, unknown>;
}

export interface FakeRecallCannedResponse {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as-is; anything else is JSON-encoded. Omitted = empty body. */
  body?: unknown;
}

export interface FakeRecall {
  transport: RecallTransport;
  calls: FakeRecallCall[];
  bots: Map<string, FakeRecallBot>;
  /** Answer the NEXT call with this response instead of the simulated API. */
  failNext(status: number, opts?: { headers?: Record<string, string>; body?: unknown }): void;
  /** Append a status change to a bot (e.g. `in_call_recording`). */
  setStatus(botId: string, code: string, subCode?: string | null): void;
  /** The bot was sent to its call: DELETE now answers 405. */
  markDispatched(botId: string): void;
}

function response(status: number, body: unknown = undefined, headers: Record<string, string> = {}): RecallTransportResponse {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const BOT_ROUTE = /^\/api\/v1\/bot\/([^/]+)\/(?:(leave_call|output_media)\/)?$/;

export function createFakeRecall(options: { apiKey?: string; now?: () => Date } = {}): FakeRecall {
  const apiKey = options.apiKey ?? FAKE_RECALL_API_KEY;
  const now = options.now ?? DEFAULT_NOW;
  const calls: FakeRecallCall[] = [];
  const bots = new Map<string, FakeRecallBot>();
  const canned: FakeRecallCannedResponse[] = [];
  const idempotencyCache = new Map<string, { status: number; body: unknown }>();
  let counter = 0;

  const statusChange = (code: string, subCode: string | null = null): FakeRecallStatusChange => ({
    code,
    sub_code: subCode,
    message: `fake ${code}`,
    created_at: now().toISOString(),
  });

  const botJson = (bot: FakeRecallBot) => ({
    id: bot.id,
    meeting_url: bot.meeting_url,
    bot_name: bot.request.bot_name ?? 'Meeting Notetaker',
    join_at: bot.join_at,
    metadata: { ...bot.metadata },
    status_changes: bot.status_changes.map((change) => ({ ...change })),
    recordings: [],
    recording_config: bot.request.recording_config ?? null,
    output_media: bot.outputMedia === 'none' ? null : bot.request.output_media ?? null,
  });

  const requireBot = (botId: string): FakeRecallBot => {
    const bot = bots.get(botId);
    if (!bot) throw new Error(`fake recall: unknown bot ${botId}`);
    return bot;
  };

  const simulate = (method: string, path: string, body: unknown): { status: number; body?: unknown } => {
    if (path === '/api/v1/bot/') {
      if (method !== 'POST') return { status: 405, body: { detail: 'Method not allowed.' } };
      const request = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      if (typeof request.meeting_url !== 'string') {
        return { status: 400, body: { meeting_url: ['This field is required.'] } };
      }
      counter += 1;
      const id = `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
      const metadata = (request.metadata && typeof request.metadata === 'object' ? request.metadata : {}) as Record<string, string>;
      const bot: FakeRecallBot = {
        id,
        meeting_url: { meeting_id: String(request.meeting_url).split('/').pop(), platform: 'google_meet' },
        join_at: typeof request.join_at === 'string' ? request.join_at : null,
        metadata: { ...metadata },
        status_changes: [statusChange('ready')],
        dispatched: false,
        outputMedia: request.output_media ? 'webpage' : 'none',
        request,
      };
      bots.set(id, bot);
      return { status: 201, body: botJson(bot) };
    }

    const match = BOT_ROUTE.exec(path);
    if (!match) return { status: 404, body: { detail: 'Not found.' } };
    const [, botId, action] = match;
    const bot = bots.get(botId);
    if (!bot) return { status: 404, body: { detail: 'Not found.' } };

    if (action === undefined) {
      if (method === 'GET') return { status: 200, body: botJson(bot) };
      if (method === 'DELETE') {
        if (bot.dispatched) return { status: 405, body: { detail: 'Method "DELETE" not allowed.' } };
        bots.delete(botId);
        return { status: 204 };
      }
      return { status: 405, body: { detail: 'Method not allowed.' } };
    }
    if (action === 'leave_call') {
      if (method !== 'POST') return { status: 405, body: { detail: 'Method not allowed.' } };
      bot.dispatched = true;
      bot.status_changes.push(statusChange('call_ended', 'bot_received_leave_call'));
      return { status: 200, body: botJson(bot) };
    }
    // output_media
    if (method === 'POST') {
      bot.outputMedia = 'webpage';
      return { status: 200, body: {} };
    }
    if (method === 'DELETE') {
      bot.outputMedia = 'none';
      return { status: 200, body: {} };
    }
    return { status: 405, body: { detail: 'Method not allowed.' } };
  };

  const transport: RecallTransport = async (req: RecallTransportRequest) => {
    const url = new URL(req.url);
    const headers = lowerHeaders(req.headers);
    const body = parseBody(req.body);
    calls.push({
      method: req.method,
      path: url.pathname,
      headers: { ...headers, ...(headers.authorization !== undefined ? { authorization: '<redacted>' } : {}) },
      body,
    });

    const next = canned.shift();
    if (next) return response(next.status, next.body, next.headers);

    if (headers.authorization !== `Token ${apiKey}`) {
      return response(401, { detail: 'Invalid token.' });
    }

    const idempotencyKey = headers['idempotency-key'];
    const cacheKey = idempotencyKey !== undefined && req.method === 'POST'
      ? `${idempotencyKey} ${req.method} ${url.pathname}`
      : null;
    if (cacheKey !== null) {
      const cached = idempotencyCache.get(cacheKey);
      if (cached) return response(cached.status, cached.body);
    }
    const result = simulate(req.method, url.pathname, body);
    if (cacheKey !== null && result.status !== 429 && result.status !== 507) {
      idempotencyCache.set(cacheKey, { status: result.status, body: result.body });
    }
    return response(result.status, result.body);
  };

  return {
    transport,
    calls,
    bots,
    failNext(status, opts = {}) {
      canned.push({ status, headers: opts.headers, body: opts.body });
    },
    setStatus(botId, code, subCode = null) {
      requireBot(botId).status_changes.push(statusChange(code, subCode));
    },
    markDispatched(botId) {
      const bot = requireBot(botId);
      bot.dispatched = true;
      bot.status_changes.push(statusChange('joining_call'));
    },
  };
}
