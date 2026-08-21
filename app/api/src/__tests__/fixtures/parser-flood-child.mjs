// Synthetic parser child: floods stdout so the parent's byte-length output
// bound can be exercised.
process.stdin.resume();
const chunk = 'x'.repeat(4096);
const timer = setInterval(() => { process.stdout.write(chunk); }, 1);
setTimeout(() => { clearInterval(timer); process.exit(0); }, 2000);
