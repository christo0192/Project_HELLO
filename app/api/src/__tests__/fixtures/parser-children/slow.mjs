#!/usr/bin/env node
// Synthetic test child: never produces output (parent timeout must kill it).
process.stdin.resume();
setTimeout(() => {}, 60_000);
