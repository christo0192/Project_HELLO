// Synthetic parser child: emits non-JSON, standing in for a document the
// extractor cannot make sense of. No heap or timeout can turn this into a
// success — that is the point.
process.stdin.resume();
process.stdin.on('end', () => { process.stdout.write('<<not json>>'); });
