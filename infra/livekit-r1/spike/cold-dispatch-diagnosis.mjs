// Direct (non-test-runner) cold-start dispatch probe.  Dispatch occurs before
// loading Chromium so startup overhead cannot turn this into a warm-path test.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const spikeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(spikeDir, '../../..');
const require = createRequire(new URL('../../../app/api/package.json', import.meta.url));
const { AccessToken, RoomServiceClient, AgentDispatchClient, TrackSource } = require('livekit-server-sdk');
const { chromium } = require('playwright');
const url = process.env.R1_SPIKE_URL;
const apiKey = process.env.R1_SPIKE_API_KEY;
const apiSecret = process.env.R1_SPIKE_API_SECRET;
const workerLog = process.env.R1_SPIKE_WORKER_LOG;
const workerStartedAtMs = Number(process.env.R1_SPIKE_WORKER_STARTED_MS || 0);
const resultFile = process.env.R1_SPIKE_RESULT_FILE || 's0-f3-cold-config-b-sanitized.json';
const probeTimeoutMs = Number(process.env.R1_SPIKE_CYCLE_TIMEOUT_MS || 30000);
if (!url || !apiKey || !apiSecret || !workerLog || !workerStartedAtMs) throw new Error('missing required diagnostic environment');
if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1000 || probeTimeoutMs > 30000) throw new Error('invalid R1_SPIKE_CYCLE_TIMEOUT_MS');

const room = `r1-spike-cold-${Date.now()}`;
const candidateIdentity = 'r1-spike-candidate';
const roomService = new RoomServiceClient(url, apiKey, apiSecret);
const dispatch = new AgentDispatchClient(url, apiKey, apiSecret);
const beforeLog = existsSync(workerLog) ? await readFile(workerLog, 'utf8') : '';
function timestampOf(log, message, roomName) {
  for (const line of log.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (record.message === message && (!roomName || record.message.includes(`room=${roomName}`))) {
        return Date.parse(record.timestamp);
      }
    } catch { /* non-JSON stderr lines are not timing evidence */ }
  }
  return null;
}
let registeredAtMs = timestampOf(beforeLog, 'registered worker');
const dispatchStartedAt = Date.now();
await roomService.createRoom({ name: room, emptyTimeout: 600, maxParticipants: 4 });
await dispatch.createDispatch(room, 'r1-spike', { metadata: JSON.stringify({ purpose: 'S0-F cold race probe' }) });
const accessToken = new AccessToken(apiKey, apiSecret, { identity: candidateIdentity, name: 'S0-F candidate', ttl: '15m' });
accessToken.addGrant({ roomJoin: true, room, canPublish: true, canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false });
const candidateToken = await accessToken.toJwt();

const server = createServer(async (req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await readFile(resolve(spikeDir, 'index.html')));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const result = {
  check: 'S0-F3 Config B cold dispatch diagnosis',
  probeTimeoutMs,
  dispatchCreated: true,
  workerStartToDispatchMs: dispatchStartedAt - workerStartedAtMs,
  workerRegisteredBeforeDispatch: /registered worker/i.test(beforeLog),
  workerStartToRegistrationMs: registeredAtMs === null ? null : registeredAtMs - workerStartedAtMs,
  registrationToDispatchMs: registeredAtMs === null ? null : dispatchStartedAt - registeredAtMs,
  workerReceivedJob: false,
  availabilityAccepted: false,
  agentJoinedByParticipantList: false,
  audioReceived: false,
  maxParticipantCount: 0,
  maxInboundAudioBytes: 0,
  dispatchToWorkerReceivedMs: null,
  dispatchToAvailabilityAcceptedMs: null,
  registrationToAvailabilityAcceptedMs: null,
  dispatchToAgentJoinMs: null,
  dispatchToAudioMs: null,
  failureStage: null,
};
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByLabel('LiveKit URL').fill(url);
  await page.getByLabel('Candidate token').fill(candidateToken);
  await page.getByRole('button', { name: 'Join with camera + microphone' }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent || '';
    return status.startsWith('Joined.') || status.startsWith('NO-GO: no selected UDP');
  }, { timeout: 30000 });
  const deadline = Date.now() + probeTimeoutMs;
  while (Date.now() < deadline) {
    const log = existsSync(workerLog) ? await readFile(workerLog, 'utf8') : '';
    registeredAtMs ??= timestampOf(log, 'registered worker');
    if (registeredAtMs !== null) {
      result.workerStartToRegistrationMs ??= registeredAtMs - workerStartedAtMs;
      result.registrationToDispatchMs ??= dispatchStartedAt - registeredAtMs;
    }
    if (log.includes(`S0F_DISPATCH_RECEIVED room=${room}`)) {
      result.workerReceivedJob = true;
      result.dispatchToWorkerReceivedMs ??= Date.now() - dispatchStartedAt;
    }
    if (log.includes(`S0F_AVAILABILITY_ACCEPTED room=${room}`)) {
      result.availabilityAccepted = true;
      const acceptedAtMs = timestampOf(log, `S0F_AVAILABILITY_ACCEPTED room=${room}`, room);
      result.dispatchToAvailabilityAcceptedMs ??= acceptedAtMs === null ? Date.now() - dispatchStartedAt : acceptedAtMs - dispatchStartedAt;
      result.registrationToAvailabilityAcceptedMs ??= registeredAtMs === null || acceptedAtMs === null ? null : acceptedAtMs - registeredAtMs;
    }
    const participants = await roomService.listParticipants(room);
    result.maxParticipantCount = Math.max(result.maxParticipantCount, participants.length);
    if (participants.some((participant) => participant.identity !== candidateIdentity)) {
      result.agentJoinedByParticipantList = true;
      result.dispatchToAgentJoinMs ??= Date.now() - dispatchStartedAt;
    }
    const state = JSON.parse(await page.locator('#summary').textContent());
    const bytes = Math.max(0, ...state.samples.flatMap((sample) => sample.inbound).map((item) => item.bytesReceived || 0));
    result.maxInboundAudioBytes = Math.max(result.maxInboundAudioBytes, bytes);
    if (result.maxInboundAudioBytes > 0) {
      result.audioReceived = true;
      result.dispatchToAudioMs ??= Date.now() - dispatchStartedAt;
    }
    if (result.workerReceivedJob && result.availabilityAccepted && result.agentJoinedByParticipantList && result.audioReceived) break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  if (!result.workerReceivedJob) result.failureStage = 'worker did not receive dispatched job';
  else if (!result.availabilityAccepted) result.failureStage = 'worker received job but no worker acceptance/assignment marker';
  else if (!result.agentJoinedByParticipantList) result.failureStage = 'worker accepted job but agent never joined room';
  else if (!result.audioReceived) result.failureStage = 'agent joined but no inbound echoed audio';
} catch (error) {
  result.failureStage = `test operation failed: ${String(error).replace(/eyJ[^\s]+/g, '[redacted]').replace(/https?:\/\/[^\s]+/g, '[url-redacted]')}`;
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
await writeFile(resolve(spikeDir, resultFile), JSON.stringify(result, null, 2) + '\n');
console.log('SANITIZED_SPIKE_RESULT=' + JSON.stringify(result));
