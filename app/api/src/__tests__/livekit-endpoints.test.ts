/** Per-lane LiveKit endpoint isolation fences. */

import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  accessTokenFor,
  browserLiveKitEndpoint,
  cloudLiveKitEndpoint,
  requireBrowserLiveKitConfigured,
} from '../lib/livekit-endpoints.js';
import { loadLiveKitPhoneConfig } from '../integrations/livekit-phone/config.js';

const originalR1Environment = {
  target: process.env.BROWSER_LIVEKIT_TARGET,
  url: process.env.R1_LIVEKIT_URL,
  apiKey: process.env.R1_LIVEKIT_API_KEY,
  apiSecret: process.env.R1_LIVEKIT_API_SECRET,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('BROWSER_LIVEKIT_TARGET', originalR1Environment.target);
  restore('R1_LIVEKIT_URL', originalR1Environment.url);
  restore('R1_LIVEKIT_API_KEY', originalR1Environment.apiKey);
  restore('R1_LIVEKIT_API_SECRET', originalR1Environment.apiSecret);
});

function verifyHs256(token: string, secret: string): void {
  const [header, payload, signature, extra] = token.split('.');
  expect(header).toBeTruthy();
  expect(payload).toBeTruthy();
  expect(signature).toBeTruthy();
  expect(extra).toBeUndefined();
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature!, 'base64url');
  expect(actual.length).toBe(expected.length);
  expect(timingSafeEqual(actual, expected)).toBe(true);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(item);
    return entry.name.endsWith('.ts') ? [item] : [];
  });
}

describe('browser LiveKit endpoint selection', () => {
  it('defaults to the Cloud triple for unset or non-r1 targets', () => {
    const cloud = cloudLiveKitEndpoint();
    delete process.env.BROWSER_LIVEKIT_TARGET;
    expect(browserLiveKitEndpoint()).toEqual(cloud);

    process.env.BROWSER_LIVEKIT_TARGET = 'cloud';
    expect(browserLiveKitEndpoint()).toEqual(cloud);

    process.env.BROWSER_LIVEKIT_TARGET = 'R1';
    expect(browserLiveKitEndpoint()).toEqual(cloud);
  });

  it('uses the R1 triple only for the exact r1 target and signs R1 JWTs with it', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.example.test';
    process.env.R1_LIVEKIT_API_KEY = 'r1-test-key';
    process.env.R1_LIVEKIT_API_SECRET = 'r1-test-secret';

    const endpoint = requireBrowserLiveKitConfigured();
    expect(endpoint).toEqual({
      url: 'wss://r1.example.test',
      apiKey: 'r1-test-key',
      apiSecret: 'r1-test-secret',
      target: 'r1',
    });

    const jwt = await accessTokenFor(endpoint, { identity: 'candidate-test', ttl: '5m' }).toJwt();
    verifyHs256(jwt, 'r1-test-secret');
    expect(() => verifyHs256(jwt, cloudLiveKitEndpoint().apiSecret)).toThrow();
  });

  it('fails closed instead of falling back to Cloud when selected R1 is incomplete', () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.example.test';
    delete process.env.R1_LIVEKIT_API_KEY;
    delete process.env.R1_LIVEKIT_API_SECRET;

    expect(() => requireBrowserLiveKitConfigured()).toThrow(
      'R1_LIVEKIT_URL, R1_LIVEKIT_API_KEY, and R1_LIVEKIT_API_SECRET must be set',
    );
  });

  it('leaves the phone configuration on the Cloud pair even when R1 is selected', () => {
    const config = loadLiveKitPhoneConfig({
      BROWSER_LIVEKIT_TARGET: 'r1',
      R1_LIVEKIT_URL: 'wss://r1.example.test',
      R1_LIVEKIT_API_KEY: 'r1-test-key',
      R1_LIVEKIT_API_SECRET: 'r1-test-secret',
      LIVEKIT_API_KEY: 'cloud-test-key',
      LIVEKIT_API_SECRET: 'cloud-test-secret',
    } as NodeJS.ProcessEnv);
    expect(config.apiKey).toBe('cloud-test-key');
    expect(config.apiSecret).toBe('cloud-test-secret');
  });

  // This imports the full Express application and can exceed Vitest's default
  // five-second unit-test timeout on Windows worktrees with spaces in the path.
  it('imports the API with malformed or absent optional R1 values', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'not a URL';
    delete process.env.R1_LIVEKIT_API_KEY;
    delete process.env.R1_LIVEKIT_API_SECRET;
    await expect(import('../app.js')).resolves.toHaveProperty('createApp');
  }, 60_000);
});

describe('phone source isolation', () => {
  const src = fileURLToPath(new URL('../', import.meta.url));
  const phoneDirectories = [
    path.join(src, 'lib', 'phone-runtime'),
    path.join(src, 'lib', 'phone-canary1'),
    ...readdirSync(path.join(src, 'integrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('livekit-phone'))
      .map((entry) => path.join(src, 'integrations', entry.name)),
  ];
  const phoneRoutes = readdirSync(path.join(src, 'routes'))
    .filter((name) => /^phone.*\.ts$/.test(name))
    .map((name) => path.join(src, 'routes', name));

  it('does not let a phone-only module import the browser endpoint seam or name R1 credentials', () => {
    const files = [
      ...phoneDirectories.flatMap(sourceFiles),
      ...phoneRoutes,
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/livekit-endpoints|R1_LIVEKIT/);
    }
  });
});
