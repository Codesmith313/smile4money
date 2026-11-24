import express from 'express';
import healthRouter from './routes/health.js';
import matchRouter from './routes/matches.js';
import validateGameRouter from './routes/validate-game.js';
import reviewRouter from './routes/oracle-review.js';
import oracleRouter from './routes/oracle.js';
import historyRouter from './routes/oracle-history.js';
import playerIdentityRouter from './routes/player-identity.js';
import metricsRouter from './routes/metrics.js';
import statusRouter from './routes/status.js';
import {
  ErrorCode,
  errorEnvelope,
  userFacingErrorMessage,
} from './errors/errorResponse.js';
import { requestLogging } from './middleware/request-logging.js';
import { httpRequestMetrics } from './middleware/http-metrics.js';
import { traceContext } from './middleware/trace-context.js';
import { apiErrorHandler } from './middleware/error-handler.js';
import { corsMiddleware } from './middleware/cors.js';
import { authenticate } from './middleware/authenticate.js';
import { sessionStore } from './auth/session-store.js';

export const app = express();

app.use(traceContext());
app.use(httpRequestMetrics());
// #2130 — CORS restricted to whitelisted frontend domains (env.corsAllowedOrigins)
app.use(corsMiddleware());

app.use(express.json());
// #1722 — logs method/path/status/duration at INFO (no body ever); request
// bodies are only logged at DEBUG, and only after sensitive-field redaction.
app.use(requestLogging());
app.use('/metrics', metricsRouter);
app.use('/health', healthRouter);
// #2133/#2134/#2135 — match search/filter, cursor pagination, and statistics
// routes are all served by matchRouter under /api/matches. The router must
// register its specific paths (e.g. GET /statistics) before any parameterized
// routes (e.g. GET /:id) so they are not shadowed; no extra wiring is needed here.
app.use('/api/matches', matchRouter);
app.use('/api/validate-game', validateGameRouter);
app.use('/api/oracle/reviews', reviewRouter);
app.use('/api/oracle/history', historyRouter);
app.use('/api/oracle', oracleRouter);
app.use('/api/player-identity', playerIdentityRouter);
app.use('/status', statusRouter);

// #2129 — session termination: revokes the current session and returns 204
app.post('/auth/logout', authenticate, (req, res) => {
  if (req.sessionId) {
    sessionStore.revoke(req.sessionId);
  }
  res.status(204).end();
});

app.use((_req, res) => {
  res
    .status(404)
    .json(
      errorEnvelope(
        ErrorCode.NOT_FOUND,
        userFacingErrorMessage(404),
        { method: req.method, path: req.originalUrl ?? req.url },
      ),
    );
});

app.use(apiErrorHandler);

export default app;
