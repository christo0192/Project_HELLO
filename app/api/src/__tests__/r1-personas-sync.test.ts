/**
 * The review page names the AI learner, and the worker is the only place the names are written.
 * `lib/r1/personas.ts` holds a copy of the names and labels; this reads the worker's file and fails
 * the build the moment the two disagree, as `r1-scenario.test.ts` does for the scenario facts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { R1_PERSONAS, r1LearnerName, r1PersonaLabel } from '../lib/r1/personas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, '../../../voice-livekit/r1_personas.py'), 'utf8');

interface WorkerPersona {
  label: string;
  variants: Record<string, string>;
}

function workerPersonas(): Record<string, WorkerPersona> {
  const heads = [...source.matchAll(/\bid="(p\d_[a-z_]+)",\s*label="([^"]+)"/g)];
  const personas: Record<string, WorkerPersona> = {};
  heads.forEach((head, index) => {
    const block = source.slice(head.index, heads[index + 1]?.index ?? source.length);
    const variants: Record<string, string> = {};
    for (const variant of block.matchAll(/Variant\(\s*"(v\d)",\s*"([^"]+)",\s*"([^"]+)"/g)) {
      variants[variant[1]] = `${variant[2]} ${variant[3]}`;
    }
    personas[head[1]] = { label: head[2], variants };
  });
  return personas;
}

describe('the persona copy agrees with the worker', () => {
  it('reads the names it compares from the real file', () => {
    expect(Object.keys(workerPersonas())).toHaveLength(4);
  });

  it('has every persona, label and variant name the worker has, and no others', () => {
    expect(R1_PERSONAS).toEqual(workerPersonas());
  });
});

describe('the names a reader gets', () => {
  it('names the variant the worker recorded', () => {
    expect(r1LearnerName('p1_career_switcher', 'v2')).toBe('Priya Nair');
  });

  it('names nobody for an unknown persona, an unknown variant or the column default', () => {
    expect(r1LearnerName('p9_unknown', 'v1')).toBeNull();
    expect(r1LearnerName('p1_career_switcher', 'v9')).toBeNull();
    expect(r1LearnerName('p1_career_switcher', 'default')).toBeNull();
    expect(r1LearnerName('p1_career_switcher', null)).toBeNull();
  });

  it('never reads an inherited key as a persona', () => {
    expect(r1LearnerName('constructor', 'v1')).toBeNull();
    expect(r1LearnerName('p1_career_switcher', 'constructor')).toBeNull();
    expect(r1PersonaLabel('constructor')).toBeNull();
  });

  it('gives the label of a known persona', () => {
    expect(r1PersonaLabel('p4_research_scholar')).toBe('Research scholar');
  });
});
