/**
 * Notes are human words. They are never sent to any AI and never labelled AI, so the only code that
 * may read `recruiter_notes` is the two routes that hand them back to staff. A scorer, a prompt builder
 * or a worker that wanted them would have to appear in the list below, which is a decision, not an
 * accident. A fence on the text of the source, like `r1-room-isolation.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const WORKER = path.resolve(here, '../../../voice-livekit');

function sourceFiles(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '__tests__', '.venv', 'tests', '__pycache__'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

describe('recruiter notes stay human', () => {
  it('are read only by the routes that give them back to staff', () => {
    const readers = sourceFiles(SRC, '.ts')
      .filter((file) => readFileSync(file, 'utf8').includes('recruiter_notes'))
      .map((file) => relative(SRC, file))
      .sort();
    expect(readers).toEqual(['routes/ashby-review.ts', 'routes/notes.ts']);
  });

  it('never reach the voice worker', () => {
    const readers = sourceFiles(WORKER, '.py').filter((file) => readFileSync(file, 'utf8').includes('recruiter_notes'));
    expect(readers).toEqual([]);
  });

  it('leave the notes routes with no AI client in reach', () => {
    const imports = [...readFileSync(path.join(SRC, 'routes/notes.ts'), 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const name of imports) expect(name).not.toMatch(/deepseek|gemini|anthropic|openai|assistant|scor|prompt/i);
  });
});
