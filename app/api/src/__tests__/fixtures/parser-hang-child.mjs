// Synthetic parser child: never answers, so the parent's SIGKILL timeout runs.
process.stdin.resume();
setInterval(() => {}, 1000);
