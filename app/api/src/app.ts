import express from 'express';
import cors from 'cors';
import { env } from './lib/env.js';
import { rolesRouter } from './routes/roles.js';
import { resumesRouter } from './routes/resumes.js';
import { candidatesRouter } from './routes/candidates.js';
import { screeningRouter } from './routes/screening.js';
import { assessRouter } from './routes/assess.js';
import { livekitRouter } from './routes/livekit.js';
import {
  malformedJsonHandler,
  oversizedJsonHandler,
  multerErrorHandler,
  zodErrorHandler,
  finalErrorHandler,
} from './lib/validation.js';

export function createApp() {
  const app = express();
  const allowedOrigins = new Set(
    env.webOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked origin: ${origin}`));
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, model: env.claudeModel }));

  app.use('/api/roles', rolesRouter);
  app.use('/api/resumes', resumesRouter);
  app.use('/api/candidates', candidatesRouter);
  app.use('/api/screening', screeningRouter);
  app.use('/api/livekit', livekitRouter);
  app.use('/api/assess', assessRouter);

  // ── Global error handlers (order matters: specific first) ─────────
  app.use(malformedJsonHandler);
  app.use(oversizedJsonHandler);
  app.use(multerErrorHandler);
  app.use(zodErrorHandler);
  app.use(finalErrorHandler);

  return app;
}
