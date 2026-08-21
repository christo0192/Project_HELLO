// Synthetic parser child: exits non-zero after writing a would-be leaky
// message to stderr, so the parent's stable `child_exit` code is asserted.
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('libpdf: cannot open /tmp/resume-secret.pdf\n');
  process.exit(3);
});
