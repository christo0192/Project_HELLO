#!/usr/bin/env node
// Synthetic test child: writes a canary to stderr then exits nonzero. Proves
// the parent never surfaces child stderr in errors/logs.
process.stdin.resume();
process.stderr.write('CANARY-CHILD-STDERR-do-not-leak-9f2\n');
process.exit(1);
