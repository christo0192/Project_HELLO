import { createApp } from './app.js';
import { env } from './lib/env.js';

const app = createApp();

app.listen(env.port, () => {
  console.log(`\n  HR screening bot API → http://localhost:${env.port}`);
  console.log(`  Brain: claude -p --model ${env.claudeModel}`);
  console.log(`  Supabase schema: ${env.supabaseSchema}`);
  console.log(`  CORS origin: ${env.webOrigin}\n`);
});
