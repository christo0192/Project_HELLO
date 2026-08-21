// Synthetic parser child: writes SYNTHETIC secrets to stderr to prove the
// parent discards it. No real credential or candidate data is used.
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('ada@example.com SUPER_SECRET_TOKEN_dGVzdA==\n');
  process.stdout.write(JSON.stringify({ ok: true, text: 'ok', totalLength: 2 }));
});
