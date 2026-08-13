#!/usr/bin/env node
// Synthetic test child: emits non-JSON stdout so the parent maps it to a
// stable ParserError('bad_output'). No real parsing.
process.stdin.resume();
process.stdout.write('this is not json at all\n');
process.exit(0);
