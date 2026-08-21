// Synthetic parser child: echoes its OWN spawn contract back as the extracted
// text so the parent's spawn behaviour (argv, NODE_OPTIONS, binary stdin) can
// be asserted without mocking node:child_process. Reads and DISCARDS stdin.
let stdinBytes = 0;
process.stdin.on('data', (c) => { stdinBytes += c.length; });
process.stdin.on('end', () => {
  const text = JSON.stringify({
    argv: process.argv.slice(2),
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    stdinBytes,
  });
  process.stdout.write(JSON.stringify({ ok: true, text, totalLength: text.length }));
});
