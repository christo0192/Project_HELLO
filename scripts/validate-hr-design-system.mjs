#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const css = readFileSync(resolve(root, 'app/web/src/index.css'), 'utf8').toLowerCase();
const app = readFileSync(resolve(root, 'app/web/src/App.tsx'), 'utf8');

const approved = [
  '#f4f6fb', '#ffffff', '#dbe1ec', '#eaeef6',
  '#0f172a', '#334155', '#6b7391', '#4e6ba6',
  '#398aa2', '#1e7590', '#b45a72', '#a16207',
];
const missing = approved.filter((value) => !css.includes(value));
if (missing.length) {
  console.error(`HR palette missing from global CSS: ${missing.join(', ')}`);
  process.exit(1);
}
if (/\.dark\s*\{[\s\S]*--surface:\s*#0c1624/.test(css)) {
  console.error('unapproved alternate dark surface found in global CSS');
  process.exit(1);
}

const expectedRoutes = [
  '/login', '/candidate/join', '/privacy-notice', '/status', '/appeal',
  '/dashboard', '/roles', '/candidates', '/candidates/:id',
  '/sessions/:sessionId', '/screening/:sessionId', '/phone-calendar',
  '/admin', '/mission-control', '/ashby-mission-control',
  '/ashby/review/:applicationLinkId', '/mfa/*',
];
const missingRoutes = expectedRoutes.filter((route) => !app.includes(`path="${route}"`));
if (missingRoutes.length) {
  console.error(`expected routed surfaces are missing: ${missingRoutes.join(', ')}`);
  process.exit(1);
}

const refs = process.argv.slice(2);
const absentRefs = refs.filter((path) => !existsSync(resolve(path)));
if (absentRefs.length) {
  console.error(`visual reference files not found: ${absentRefs.join(', ')}`);
  process.exit(1);
}

console.log(`HR design validation passed: ${approved.length} palette anchors, ${expectedRoutes.length} routed surfaces`);
if (refs.length) console.log(`visual references present: ${refs.length}`);
