/** R1's route fixture is intentionally separate from the broad OpenAPI suite:
 * these endpoints are added as an isolated lane and every mounted operation
 * must retain a documented success response before a web client is built. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ROUTES, isPublicRoute } from '../lib/auth.js';
import { r1CandidateRouter } from '../routes/r1-candidate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(path.resolve(here, '../../openapi/openapi.yaml'), 'utf8');

const fixtures = [
  ['/api/candidates/{id}/interview-rounds', 'get', '200'],
  ['/api/candidates/{id}/interview-rounds', 'post', '201'],
  ['/api/interview-rounds/{id}/cancel', 'post', '200'],
  ['/api/interview-rounds/{id}/reissue', 'post', '200'],
  ['/api/interview-rounds/{id}/grant-retake', 'post', '200'],
  ['/api/interview-rounds/{id}/cancel-pending-reject', 'post', '200'],
  ['/api/admin/r1/settings', 'get', '200'],
  ['/api/admin/r1/settings', 'put', '200'],
  ['/api/interview-rounds/availability', 'get', '200'],
  ['/api/admin/r1/usage', 'get', '200'],
  ['/api/internal/r1/context', 'post', '200'],
  ['/api/internal/r1/usage', 'post', '201'],
  ['/api/internal/r1/admin-log', 'post', '201'],
  // PR-3: the candidate-facing surface and the worker's attempt outcome.
  ['/api/r1/status', 'post', '200'],
  ['/api/r1/consent-template', 'post', '200'],
  ['/api/r1/consent', 'post', '201'],
  ['/api/r1/consent/withdraw', 'post', '200'],
  ['/api/r1/preflight', 'post', '200'],
  ['/api/r1/attempts', 'post', '201'],
  ['/api/r1/exchange', 'post', '200'],
  ['/api/internal/r1/attempt-outcome', 'post', '201'],
] as const;

describe('R1 OpenAPI route fixtures', () => {
  for (const [route, method, success] of fixtures) {
    it(`${method.toUpperCase()} ${route} documents its ${success} response`, () => {
      const start = spec.indexOf(`  ${route}:`);
      const afterStart = start === -1 ? '' : spec.slice(start + route.length + 4);
      const nextPath = afterStart.indexOf('\n  /');
      const section = nextPath === -1 ? afterStart : afterStart.slice(0, nextPath);
      expect(section, `missing ${route}`).not.toBe('');
      expect(section).toMatch(new RegExp(`^    ${method}:`, 'm'));
      expect(section).toMatch(new RegExp(`'${success}'\\s*:`, 'm'));
      expect(section).toMatch(/tags: \[r1\]/);
    });
  }
});

function sectionFor(route: string): string {
  const start = spec.indexOf(`  ${route}:`);
  const afterStart = start === -1 ? '' : spec.slice(start + route.length + 4);
  const nextPath = afterStart.indexOf('\n  /');
  return nextPath === -1 ? afterStart : afterStart.slice(0, nextPath);
}

describe('R1 candidate surface contract', () => {
  const candidate = fixtures
    .filter(([route]) => route.startsWith('/api/r1/'))
    .map(([route, method]) => ({ route, method: method.toUpperCase() }));

  it('mounts exactly the documented candidate routes, and each is public by exact path', () => {
    const mounted = (r1CandidateRouter as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route!.methods)
        .map((method) => `${method.toUpperCase()} /api/r1${layer.route!.path}`))
      .sort();
    const documented = candidate.map(({ route, method }) => `${method} ${route}`).sort();
    expect(mounted).toEqual(documented);
    for (const { route, method } of candidate) {
      expect(isPublicRoute(method, route), `${method} ${route}`).toBe(true);
    }
    const publicR1 = PUBLIC_ROUTES
      .filter((entry) => entry.path.startsWith('/api/r1/'))
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    expect(publicR1).toEqual(documented);
  });

  it('marks every candidate route security: [] and documents its failure modes', () => {
    for (const { route } of candidate) {
      expect(sectionFor(route), route).toMatch(/security: \[\]/);
    }
    for (const route of ['/api/r1/status', '/api/r1/consent', '/api/r1/consent/withdraw']) {
      expect(sectionFor(route), route).toMatch(/'404'\s*:/);
    }
    expect(sectionFor('/api/r1/preflight')).toMatch(/'429'\s*:/);
    expect(sectionFor('/api/r1/exchange')).toMatch(/'202'\s*:/);
  });

  it('keeps near misses out of the public allowlist (exact method and path only)', () => {
    for (const [method, path] of [
      ['GET', '/api/r1/status'],
      // The notice is a POST (the link token rides in the body): a GET is not public.
      ['GET', '/api/r1/consent-template'],
      ['POST', '/api/r1/status/'],
      ['POST', '/api/r1/exchange/extra'],
      ['POST', '/api/r1'],
      ['POST', '/api/internal/r1/attempt-outcome'],
      ['GET', '/api/interview-rounds/x/cancel'],
      ['POST', '/api/r1/consent/withdraw/'],
    ] as const) {
      expect(isPublicRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
