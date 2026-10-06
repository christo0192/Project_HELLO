#!/usr/bin/env node
/**
 * Disposable S0-F room/token helper. It intentionally resolves the existing
 * SDK from app/api instead of adding an independent dependency tree here.
 *
 * Required env: R1_SPIKE_URL, R1_SPIKE_API_KEY, R1_SPIKE_API_SECRET.
 * Optional: R1_SPIKE_ROOM (default r1-spike-<timestamp>).
 */
import { createRequire } from "node:module";
import { assertSpikeUrl } from "./spike-host.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const url = required("R1_SPIKE_URL");
assertSpikeUrl(url);
const apiKey = required("R1_SPIKE_API_KEY");
const apiSecret = required("R1_SPIKE_API_SECRET");
const room = process.env.R1_SPIKE_ROOM || `r1-spike-${Date.now()}`;
const require = createRequire(new URL("../../../app/api/package.json", import.meta.url));
const { AccessToken, RoomServiceClient, AgentDispatchClient, TrackSource } = require("livekit-server-sdk");

function candidateToken() {
  const accessToken = new AccessToken(apiKey, apiSecret, { identity: "r1-spike-candidate", name: "S0-F candidate", ttl: "15m" });
  accessToken.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
  });
  return accessToken.toJwt();
}

const roomService = new RoomServiceClient(url, apiKey, apiSecret);
await roomService.createRoom({ name: room, emptyTimeout: 60 * 10, maxParticipants: 4 });

// The echo worker is dispatch-only and never shares a production agent name.
const dispatch = new AgentDispatchClient(url, apiKey, apiSecret);
await dispatch.createDispatch(room, "r1-spike", JSON.stringify({ purpose: "S0-F media echo" }));

console.log(JSON.stringify({
  url,
  room,
  candidate: { identity: "r1-spike-candidate", token: await candidateToken() },
}, null, 2));
