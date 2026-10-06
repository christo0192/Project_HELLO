import playwrightTest from '../../../app/api/node_modules/playwright/test.js';
const { test, expect } = playwrightTest;
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


const execFileAsync = promisify(execFile);
const spikeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(spikeDir, '../../..');
const apiDir = resolve(root, 'app/api');
const url = 'wss://project-hello-r1-rtc-spike.fly.dev';
const server = createServer(async (req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await readFile(resolve(spikeDir, 'index.html')));
});
let port;
async function saveResult(name, value) {
  await writeFile(resolve(spikeDir, name), JSON.stringify(value, null, 2) + '\n');
}
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test.beforeAll(async () => { await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); port = server.address().port; });
test.afterAll(async () => { await new Promise((ok) => server.close(ok)); });

async function mint() {
  const { stdout } = await execFileAsync('node', [resolve(spikeDir, 'mint-token.mjs')], { cwd: apiDir, env: process.env });
  return JSON.parse(stdout);
}
async function join(page, token) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByLabel('LiveKit URL').fill(url);
  await page.getByLabel('Candidate token').fill(token);
  const started = performance.now();
  await page.getByRole('button', { name: 'Join with camera + microphone' }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent || '';
    return status.startsWith('Joined.') || status.startsWith('NO-GO: no selected UDP');
  }, { timeout: 30000 });
  return performance.now() - started;
}
async function summary(page) { return JSON.parse(await page.locator('#summary').textContent()); }
function cleanSamples(state) {
  return state.samples.map((sample) => ({
    at: sample.at,
    pairs: sample.pairs,
    outbound: sample.outbound,
    inbound: sample.inbound,
    udpSelected: sample.udpSelected,
  }));
}

test('S0-F1 UDP pair: 90 seconds of camera/microphone stats', async ({ browser }) => {
  test.setTimeout(130000);
  const page = await browser.newPage();
  const minted = await mint();
  const joinMs = await join(page, minted.candidate.token);
  await page.waitForTimeout(90000);
  const state = await summary(page);
  const result = { check: 'S0-F1', joinMs: Math.round(joinMs), samples: cleanSamples(state), errors: state.errors, result: state.result };
  await saveResult('s0-f1-sanitized.json', result);
  console.log('SANITIZED_SPIKE_RESULT=' + JSON.stringify(result));
  await page.getByRole('button', { name: 'Leave' }).click();
});

test('S0-F2-lite: ten reconnect cycles', async ({ browser }) => {
  const page = await browser.newPage();
  const cycles = [];
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    const minted = await mint();
    try {
      const joinMs = await join(page, minted.candidate.token);
      await page.waitForTimeout(1000);
      const state = await summary(page);
      cycles.push({ cycle, success: true, joinMs: Math.round(joinMs), pairs: state.samples.at(-1)?.pairs || [] });
      await page.getByRole('button', { name: 'Leave' }).click();
      await expect(page.locator('#status')).toHaveText('Left.');
    } catch (error) { cycles.push({ cycle, success: false, error: String(error).replace(/eyJ[^\s]+/g, '[redacted]') }); }
  }
  const result = { check: 'S0-F2-lite', cycles };
  await saveResult('s0-f2-sanitized.json', result);
  console.log('SANITIZED_SPIKE_RESULT=' + JSON.stringify(result));
});

test('S0-F3-lite: five dispatched echo-agent joins and inbound audio', async ({ browser }) => {
  test.setTimeout(180000);
  const page = await browser.newPage();
  const cycles = [];
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const dispatchStart = performance.now();
    const minted = await mint();
    try {
      await join(page, minted.candidate.token);
      await expect.poll(async () => (await summary(page)).remoteTrackEvents.length, { timeout: 30000 }).toBeGreaterThan(0);
      await page.waitForTimeout(6000);
      const state = await summary(page);
      const eventAt = state.remoteTrackEvents.at(-1)?.at;
      const inbound = state.samples.flatMap((sample) => sample.inbound).map((item) => item.bytesReceived || 0);
      cycles.push({ cycle, success: true, dispatchToTrackMs: Math.round(performance.now() - dispatchStart), remoteTrackAt: eventAt, maxInboundAudioBytes: Math.max(0, ...inbound) });
      await page.getByRole('button', { name: 'Leave' }).click();
      await expect(page.locator('#status')).toHaveText('Left.');
    } catch (error) { cycles.push({ cycle, success: false, error: String(error).replace(/eyJ[^\s]+/g, '[redacted]') }); }
  }
  const result = { check: 'S0-F3-lite', cycles };
  await saveResult('s0-f3-sanitized.json', result);
  console.log('SANITIZED_SPIKE_RESULT=' + JSON.stringify(result));
});
