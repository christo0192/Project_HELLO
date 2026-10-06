import playwrightTest from '../../../app/api/node_modules/playwright/test.js';
const { test } = playwrightTest;
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { assertSpikeUrl } from './spike-host.mjs';

const execFileAsync = promisify(execFile);
const spikeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(spikeDir, '../../..');
const apiDir = resolve(root, 'app/api');
const url = 'wss://project-hello-r1-rtc-spike.fly.dev';
assertSpikeUrl(url);
const require = createRequire(new URL('../../../app/api/package.json', import.meta.url));
const { RoomServiceClient } = require('livekit-server-sdk');
const workerLog = process.env.R1_SPIKE_WORKER_LOG;
const workerStartedAtMs = Number(process.env.R1_SPIKE_WORKER_STARTED_MS || 0);
const cycleCount = Number(process.env.R1_SPIKE_CYCLE_COUNT || 10);
const cycleTimeoutMs = Number(process.env.R1_SPIKE_CYCLE_TIMEOUT_MS || 30000);
const resultFile = process.env.R1_SPIKE_RESULT_FILE || 's0-f3-config-b-sanitized.json';
if (!Number.isInteger(cycleCount) || cycleCount < 1 || cycleCount > 20) {
  throw new Error('R1_SPIKE_CYCLE_COUNT must be an integer from 1 through 20');
}
if (!Number.isInteger(cycleTimeoutMs) || cycleTimeoutMs < 1000 || cycleTimeoutMs > 30000) {
  throw new Error('R1_SPIKE_CYCLE_TIMEOUT_MS must be an integer from 1000 through 30000');
}
const server = createServer(async (req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await readFile(resolve(spikeDir, 'index.html')));
});
let port;

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test.beforeAll(async () => { await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); port = server.address().port; });
test.afterAll(async () => { await new Promise((ok) => server.close(ok)); });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const cleanError = (error) => String(error).replace(/eyJ[^\s]+/g, '[redacted]').replace(/https?:\/\/[^\s]+/g, '[url-redacted]');
async function mint() {
  const { stdout } = await execFileAsync('node', [resolve(spikeDir, 'mint-token.mjs')], { cwd: apiDir, env: process.env });
  return JSON.parse(stdout);
}
async function logs() {
  if (!workerLog || !existsSync(workerLog)) return '';
  return readFile(workerLog, 'utf8');
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
  return Math.round(performance.now() - started);
}
async function state(page) { return JSON.parse(await page.locator('#summary').textContent()); }
function signalAt(log, signal, room) { return log.includes(`${signal} room=${room}`); }
function loadUpdates(log) {
  return log.split(/\r?\n/).flatMap((line) => {
    try {
      const record = JSON.parse(line);
      if (!['worker is at full capacity, marking as unavailable', 'worker is below capacity, marking as available'].includes(record.message)) return [];
      return [{ message: record.message, load: record.load, threshold: record.threshold, timestamp: record.timestamp }];
    } catch { return []; }
  });
}

test('S0-F3 Config B dispatched echo cycles', async ({ browser }) => {
  test.setTimeout(600000);
  const page = await browser.newPage();
  const roomService = new RoomServiceClient(url, process.env.R1_SPIKE_API_KEY, process.env.R1_SPIKE_API_SECRET);
  const cycles = [];
  for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
    const dispatchStartedAt = Date.now();
    const before = await logs();
    const row = {
      cycle,
      coldStart: cycle === 1,
      dispatchCreated: false,
      workerRegisteredBeforeDispatch: /registered worker/i.test(before),
      workerReceivedJob: false,
      availabilityAccepted: false,
      workerAgentConnected: false,
      workerAudioPublished: false,
      agentJoinedByParticipantList: false,
      audioReceived: false,
      participantListObserved: false,
      candidateJoinMs: null,
      dispatchToWorkerReceivedMs: null,
      dispatchToAvailabilityAcceptedMs: null,
      dispatchToAgentJoinMs: null,
      dispatchToAudioMs: null,
      maxParticipantCount: 0,
      maxInboundAudioBytes: 0,
      failureStage: null,
    };
    if (cycle === 1 && workerStartedAtMs > 0) row.workerStartToDispatchMs = dispatchStartedAt - workerStartedAtMs;
    try {
      const minted = await mint();
      row.dispatchCreated = true;
      row.candidateJoinMs = await join(page, minted.candidate.token);
      const deadline = Date.now() + cycleTimeoutMs;
      while (Date.now() < deadline) {
        const currentLog = await logs();
        if (signalAt(currentLog, 'S0F_DISPATCH_RECEIVED', minted.room)) {
          row.workerReceivedJob = true;
          row.dispatchToWorkerReceivedMs ??= Date.now() - dispatchStartedAt;
        }
        if (signalAt(currentLog, 'S0F_AVAILABILITY_ACCEPTED', minted.room)) {
          row.availabilityAccepted = true;
          row.dispatchToAvailabilityAcceptedMs ??= Date.now() - dispatchStartedAt;
        }
        row.workerAgentConnected ||= signalAt(currentLog, 'S0F_AGENT_CONNECTED', minted.room);
        row.workerAudioPublished ||= signalAt(currentLog, 'S0F_AUDIO_PUBLISHED', minted.room);
        let participants = [];
        try { participants = await roomService.listParticipants(minted.room); }
        catch (error) { row.participantListError = cleanError(error); }
        if (participants.length) row.participantListObserved = true;
        row.maxParticipantCount = Math.max(row.maxParticipantCount, participants.length);
        if (participants.some((participant) => participant.identity !== minted.candidate.identity)) {
          row.agentJoinedByParticipantList = true;
          row.dispatchToAgentJoinMs ??= Date.now() - dispatchStartedAt;
        }
        const current = await state(page);
        const maxBytes = Math.max(0, ...current.samples.flatMap((sample) => sample.inbound).map((item) => item.bytesReceived || 0));
        row.maxInboundAudioBytes = Math.max(row.maxInboundAudioBytes, maxBytes);
        if (row.maxInboundAudioBytes > 0) {
          row.audioReceived = true;
          row.dispatchToAudioMs ??= Date.now() - dispatchStartedAt;
        }
      if (row.workerReceivedJob && row.availabilityAccepted && row.agentJoinedByParticipantList && row.audioReceived) break;
        await sleep(500);
      }
      if (!row.workerReceivedJob) row.failureStage = 'worker did not receive dispatched job';
      else if (!row.availabilityAccepted) row.failureStage = 'worker received job but no worker acceptance/assignment marker';
      else if (!row.agentJoinedByParticipantList) row.failureStage = 'worker accepted job but agent never joined room';
      else if (!row.audioReceived) row.failureStage = 'agent joined but no inbound echoed audio';
      await page.getByRole('button', { name: 'Leave' }).click();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Left.', { timeout: 10000 });
      await sleep(500);
    } catch (error) {
      row.failureStage = row.failureStage || `test operation failed: ${cleanError(error)}`;
      try { await page.getByRole('button', { name: 'Leave' }).click({ timeout: 1000 }); } catch { /* no active room */ }
    }
    cycles.push(row);
    // Persist boundaries after every cycle: an interrupted long-running browser
    // job must not discard already-observed dispatch evidence.
    await writeFile(resolve(spikeDir, resultFile), JSON.stringify({
      check: 'S0-F3 Config B dispatch diagnosis',
      status: 'in-progress',
      cycleCount,
      cycleTimeoutMs,
      loadThresholdOverride: process.env.R1_SPIKE_LOAD_THRESHOLD === 'inf' ? 'inf' : 'default',
      cycles,
    }, null, 2) + '\n');
  }
  const allWorkerLog = await logs();
  const result = {
    check: 'S0-F3 Config B dispatch diagnosis',
    cycleCount,
    cycleTimeoutMs,
    loadThresholdOverride: process.env.R1_SPIKE_LOAD_THRESHOLD === 'inf' ? 'inf' : 'default',
    workerLogSignals: ['S0F_DISPATCH_RECEIVED', 'S0F_AVAILABILITY_ACCEPTED', 'S0F_AGENT_CONNECTED', 'S0F_AUDIO_PUBLISHED'],
    workerLoadStatusUpdates: loadUpdates(allWorkerLog),
    cycles,
  };
  await writeFile(resolve(spikeDir, resultFile), JSON.stringify(result, null, 2) + '\n');
  console.log('SANITIZED_SPIKE_RESULT=' + JSON.stringify(result));
});
