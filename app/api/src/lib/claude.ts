import { spawn } from 'node:child_process';
import { env } from './env.js';

export interface ClaudeOptions {
  model?: string;
  system?: string;       // appended to system prompt
  timeoutMs?: number;
}

/**
 * Run the Claude Code CLI in headless print mode as a pure text transformer.
 * The prompt is piped via stdin to avoid shell-escaping issues on Windows.
 * Returns the assistant's final text output (trimmed).
 *
 * This is the "brain" of the bot in v1 — zero API cost, rides the user's
 * Claude subscription. Swap for the Anthropic API later by reimplementing
 * runClaude()/runClaudeJSON() with the same signatures.
 */
export function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
  const model = opts.model ?? env.claudeModel;
  const timeoutMs = opts.timeoutMs ?? env.claudeTimeoutMs;
  const args = ['-p', '--model', model, '--max-turns', '1'];
  if (opts.system) args.push('--append-system-prompt', opts.system);

  return new Promise((resolve, reject) => {
    // shell:true so Windows resolves claude.cmd on PATH.
    const child = spawn(env.claudeBin, args, { shell: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude CLI (${env.claudeBin}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude CLI exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Strip ```json fences / prose and return the first JSON object/array found. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[[{]/);
  if (start === -1) return body.trim();
  // find matching last bracket
  const lastObj = body.lastIndexOf('}');
  const lastArr = body.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  return end > start ? body.slice(start, end + 1) : body.slice(start).trim();
}

/** Run claude and parse the result as JSON. Retries once on parse failure. */
export async function runClaudeJSON<T = unknown>(prompt: string, opts: ClaudeOptions = {}): Promise<T> {
  const instruction =
    '\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown code fences, no commentary before or after.';
  const raw = await runClaude(prompt + instruction, opts);
  try {
    return JSON.parse(extractJson(raw)) as T;
  } catch {
    // one retry with a stricter nudge
    const raw2 = await runClaude(
      prompt + instruction + ' Your previous reply was not valid JSON. Return JSON only.',
      opts,
    );
    return JSON.parse(extractJson(raw2)) as T;
  }
}
