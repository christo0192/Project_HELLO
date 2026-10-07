/** R1's route fixture is intentionally separate from the broad OpenAPI suite:
 * these endpoints are added as an isolated lane and every mounted operation
 * must retain a documented success response before a web client is built. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(path.resolve(here, '../../openapi/openapi.yaml'), 'utf8');

const fixtures = [
  ['/api/candidates/{id}/interview-rounds', 'get', '200'],
  ['/api/candidates/{id}/interview-rounds', 'post', '201'],
  ['/api/interview-rounds/{id}/cancel', 'post', '200'],
  ['/api/interview-rounds/{id}/reissue', 'post', '200'],
  ['/api/interview-rounds/{id}/grant-retake', 'post', '200'],
  ['/api/admin/r1/settings', 'get', '200'],
  ['/api/admin/r1/settings', 'put', '200'],
  ['/api/interview-rounds/availability', 'get', '200'],
  ['/api/admin/r1/usage', 'get', '200'],
  ['/api/internal/r1/context', 'post', '200'],
  ['/api/internal/r1/usage', 'post', '201'],
  ['/api/internal/r1/admin-log', 'post', '201'],
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
