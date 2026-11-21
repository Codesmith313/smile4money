import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import matchRouter from './routes/matches.js';
import validateGameRouter from './routes/validate-game.js';
import reviewRouter from './routes/oracle-review.js';
import oracleRouter from './routes/oracle.js';
import playerIdentityRouter from './routes/player-identity.js';
import { errorToHttpStatus } from './errors/errorToHttpStatus.js';
import {
  ErrorCode,
  errorEnvelope,
  statusToErrorCode,
  userFacingErrorMessage,
} from './errors/errorResponse.js';
import { requestLogging } from './middleware/request-logging.js';
import { traceContext } from './middleware/trace-context.js';
import logger from './logger.js';

/**
 * Parse the ALLOWED_ORIGINS environment variable into an array of origin strings.
 * Accepts a comma-separated list, e.g. "https://app.example.com,https://staging.example.com".
 * Falls back to the frontend URL in production or localhost in development.
 */
function getAllowedOrigins(): string[] {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  }
  if (process.env.FRONTEND_URL) {
    return [process.env.FRONTEND_URL];
  }
  // Development fallback — not used when ALLOWED_ORIGINS is set in production
  return ['http://localhost:5173'];
}

export const app = express();

app.use(traceContext());
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = getAllowedOrigins();
      // Allow server-to-server requests (no Origin header) and listed origins
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' is not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

app.use(express.json());
// #1722 — logs method/path/status/duration at INFO (no body ever); request
// bodies are only logged at DEBUG, and only after sensitive-field redaction.
app.use(requestLogging());
app.use('/health', healthRouter);
app.use('/api/matches', matchRouter);
app.use('/api/validate-game', validateGameRouter);
app.use('/api/oracle/reviews', reviewRouter);
app.use('/api/oracle', oracleRouter);
app.use('/api/player-identity', playerIdentityRouter);

// Public service status (#115). Mounted here, after the other routes, so the
// route list above stays untouched; the handler never throws.
import statusRouter from './routes/status.js';
app.use('/status', statusRouter);

app.use((_req, res) => {
  res
    .status(404)
    .json(errorEnvelope(ErrorCode.NOT_FOUND, userFacingErrorMessage(404)));
});

// Keep internal exception details in neither the response nor the logs.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status = errorToHttpStatus(err);
    const code = statusToErrorCode(status);
    logger.error({ status, error_code: code }, 'http_error');
    res.status(status).json(errorEnvelope(code, userFacingErrorMessage(status)));
  },
);

export default app;
