import assert from "node:assert/strict";
import test from "node:test";
import { assertSpikeUrl } from "./spike-host.mjs";

test("spike URL fence accepts only the dedicated spike FQDN", () => {
  for (const url of [
    "wss://project-hello-r1-rtc-spike.fly.dev",
    "https://project-hello-r1-rtc-spike.fly.dev/path",
  ]) {
    assert.equal(assertSpikeUrl(url).hostname, "project-hello-r1-rtc-spike.fly.dev");
  }
});

test("spike URL fence rejects all other endpoint forms", () => {
  for (const url of [
    "wss://example.livekit.cloud",
    "wss://project-hello-r1-rtc.fly.dev",
    "wss://project-hello-r1-rtc-spike.fly.dev.evil.com",
    "wss://evilproject-hello-r1-rtc-spike.fly.dev",
    "wss://user@project-hello-r1-rtc-spike.fly.dev",
    "wss://@project-hello-r1-rtc-spike.fly.dev",
    "wss://:@project-hello-r1-rtc-spike.fly.dev",
    "wss://project-hello-r1-rtc-spike.fly.dev:7880",
    "https://project-hello-r1-rtc-spike.fly.dev:443",
    "http://project-hello-r1-rtc-spike.fly.dev",
  ]) {
    assert.throws(() => assertSpikeUrl(url));
  }
});
