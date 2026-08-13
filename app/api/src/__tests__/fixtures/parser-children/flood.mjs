#!/usr/bin/env node
// Synthetic test child: floods stdout to trigger ParserOutputExceededError.
process.stdin.resume();
process.stdout.write('x'.repeat(2_000_000));
