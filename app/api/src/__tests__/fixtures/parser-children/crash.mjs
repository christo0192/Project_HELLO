#!/usr/bin/env node
// Synthetic test child: nonzero exit → ParserError('child_exit').
process.stdin.resume();
process.exit(3);
