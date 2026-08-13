#!/usr/bin/env node
// Synthetic test child: exits 0 with no stdout → ParserError('no_output').
process.stdin.resume();
process.exit(0);
