import { createHash } from 'node:crypto';
import { LOG_EVENTS } from './log-events.js';
import { traceLogFields } from './tracing/trace-context.js';

const ERROR_DEDUPLICATION_WINDOW_MS = 60_000;
const MAX_RECENT_ERRORS = 1_000;

const NUMERIC_FIELDS = new Set([
  'status',
  'duration_ms',
  'count',
  'duplicate_count',
  'store_count',
  'attempt',
  'attempts',
  'max_retries',
  'retry_delay_ms',
  'nextRetryDelayMs',
  'totalAttempts',
  'port',
  'value',
  'remaining',
  'cooldown',
  'failureCount',
  'durationMs',
  'queue_depth',
  'oldest_entry_age_ms',
  'success_rate',
  'processed',
  'failed',
  'progress_delta',
  'integrity_check_ms',
  'schema_version',
  'migration_version',
  'query_duration_ms',
  'slow_query_threshold_ms',
  'latency_ms',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'success_rate',
  'submissions_per_hour',
  'sample_count',
]);
const ENUM_FIELDS: Record<string, readonly string[]> = {
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  platform: ['lichess', 'chessdotcom'],
  state: ['CLOSED', 'OPEN', 'HALF_OPEN'],
  store: ['sqlite', 'memory', 'mongodb'],
  sqlite_error_code: ['SQLITE_BUSY', 'SQLITE_LOCKED'],
  metric: ['oracle_dlq_depth'],
  replay_result: ['success', 'failed'],
  stall_state: ['stalled', 'progressing'],
  integrity_status: ['ok', 'failed'],
  operation: ['submit_result', 'has_result', 'fetch_result'],
  config_field: ['endpoint', 'credential'],
  alert: ['degraded', 'ok'],
  auth_failure_reason: [
    'missing_header',
    'invalid_payload',
    'expired',
    'invalid_signature',
    'unknown',
  ],
};
const STRING_FIELD_PATTERNS: Record<string, RegExp> = {
  trace_id: /^[a-f0-9]{32}$/,
  correlation_id: /^[a-f0-9]{32}$/,
  span_id: /^[a-f0-9]{16}$/,
  parent_span_id: /^[a-f0-9]{16}$/,
  request_id: /^[a-f0-9]{16}$/,
  // Stellar account address (ed25519 public key, StrKey base32 encoding).
  user_id: /^G[A-Z2-7]{55}$/,
};

function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { type: 'NonErrorThrown', valueType: typeof error };
  }

  const type = /^[A-Z][A-Za-z0-9_$]{0,58}Error$/.test(error.name)
    ? error.name
    : 'Error';
  const stack = (error.stack ?? '')
    .split('\n')
    .slice(1)
    .filter((frame) => /^\s+at\s/.test(frame))
    .map((frame) =>
      frame
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/\b[GS][A-Z2-7]{55}\b/g, '[REDACTED]')
        .replace(/\b\+?\d[\d(). -]{7,}\d\b/g, '[REDACTED]')
        .replace(
          /([?&](?:access_token|api[_-]?key|password|secret|token)=)[^&\s)]+/gi,
          '$1[REDACTED]',
        ),
    );

  return { type, stack };
}

/** Unknown fields and all arbitrary strings/errors are masked at the sink. */
function safeLogValue(key: string, value: unknown): unknown {
  if (NUMERIC_FIELDS.has(key)) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : '[REDACTED]';
  }
  if (typeof value !== 'string') return '[REDACTED]';
  if (ENUM_FIELDS[key]?.includes(value)) return value;
  if (STRING_FIELD_PATTERNS[key]?.test(value)) return value;
  if (
    key === 'error_event' &&
    (LOG_EVENTS.has(value) || value === 'log_event')
  ) {
    return value;
  }
  return '[REDACTED]';
}

export function safeLogContext(
  context: object,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context as Record<string, unknown>)
      .filter(
        ([key, value]) =>
          key === 'error' ||
          NUMERIC_FIELDS.has(key) ||
          Object.prototype.hasOwnProperty.call(ENUM_FIELDS, key) ||
          Object.prototype.hasOwnProperty.call(STRING_FIELD_PATTERNS, key) ||
          key === 'error_event',
      )
      .map(([key, value]) => [key, safeLogValue(key, value)]),
  );
}

/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */

type LogContext = object;

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

interface RecentError {
  firstLoggedAt: number;
  duplicateCount: number;
  duplicateEventLogged: boolean;
  event: string;
  status?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

const SEVERITY_BY_LEVEL: Record<LogLevel, string> = {
  debug: 'info',
  info: 'info',
  warn: 'warning',
  error: 'error',
  critical: 'critical',
};

/**
 * Error severity classification, ordered from most to least severe.
 * Used to categorize errors for filtering and severity-based alerting.
 */
export type Severity = 'critical' | 'error' | 'warning' | 'info';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

/** Severities at or above this threshold raise an alert. */
const ALERT_SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'error']);

function configuredMinSeverity(): Severity {
  const raw = (process.env.LOG_MIN_SEVERITY || '').toLowerCase();
  if (raw === 'critical' || raw === 'error' || raw === 'warning' || raw === 'info') {
    return raw;
  }
  return 'info';
}

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'warning') {
    return 'warn';
  }
  if (
    raw === 'debug' ||
    raw === 'info' ||
    raw === 'warn' ||
    raw === 'error' ||
    raw === 'critical'
  ) {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/** Default suppression window for duplicate errors (1 minute). */
const DEFAULT_DEDUP_WINDOW_MS = 60_000;

function configuredDedupWindowMs(): number {
  const raw = Number(process.env.LOG_DEDUP_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEDUP_WINDOW_MS;
}

interface DedupEntry {
  firstSeen: number;
  suppressed: number;
}

class Logger {
  private readonly recentErrors = new Map<string, RecentError>();

  /** Exposed so callers can skip building an expensive log payload entirely when it won't be emitted. */
  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
  }

  /** Returns true when an error of the given severity passes the configured severity filter. */
  isSeverityEnabled(severity: Severity): boolean {
    return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[configuredMinSeverity()];
  }

  private log(level: LogLevel, context: LogContext, message: string): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      severity: SEVERITY_BY_LEVEL[level],
      service: 'smile4money-backend',
      message: LOG_EVENTS.has(message) ? message : 'log_event',
      ...safeLogContext(context),
      ...safeLogContext(traceLogFields()),
    };
    console.log(JSON.stringify(logEntry));
  }

  private logDeduplication(
    message: string,
    duplicateCount: number,
    status?: number,
  ): void {
    this.log(
      'error',
      {
        duplicate_count: duplicateCount,
        error_event: message,
        ...(status === undefined ? {} : { status }),
      },
      'error_deduplicated',
    );
  }

  private errorWithDeduplication(context: LogContext, message: string): void {
    if (!this.isLevelEnabled('error')) return;

    const now = Date.now();
    for (const [key, recent] of this.recentErrors) {
      if (now - recent.firstLoggedAt < ERROR_DEDUPLICATION_WINDOW_MS) continue;
      if (recent.duplicateCount > 1) {
        this.logDeduplication(
          recent.event,
          recent.duplicateCount,
          recent.status,
        );
      }
      this.recentErrors.delete(key);
    }

    const safeContext = safeLogContext(context);
    delete safeContext.request_id;
    delete safeContext.correlation_id;
    delete safeContext.trace_id;
    delete safeContext.span_id;
    delete safeContext.parent_span_id;
    const key = JSON.stringify([
      createHash('sha256').update(message.slice(0, 1024)).digest('hex'),
      safeContext,
    ]);
    const event = LOG_EVENTS.has(message) ? message : 'log_event';
    const recent = this.recentErrors.get(key);
    if (recent) {
      recent.duplicateCount += 1;
      if (!recent.duplicateEventLogged) {
        recent.duplicateEventLogged = true;
        this.logDeduplication(
          event,
          1,
          typeof safeContext.status === 'number'
            ? safeContext.status
            : undefined,
        );
      }
      return;
    }

    if (this.recentErrors.size >= MAX_RECENT_ERRORS) {
      const oldest = this.recentErrors.keys().next().value;
      if (oldest !== undefined) this.recentErrors.delete(oldest);
    }
    this.recentErrors.set(key, {
      firstLoggedAt: now,
      duplicateCount: 0,
      duplicateEventLogged: false,
      event,
      status:
        typeof safeContext.status === 'number' ? safeContext.status : undefined,
    });
    this.log('error', context, message);
  }

  debug(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('debug', {}, context);
    } else {
      this.log('debug', context, message || '');
    }
  }

  info(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('info', {}, context);
    } else {
      this.log('info', context, message || '');
    }
  }

  warn(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('warn', {}, context);
    } else {
      this.log('warn', context, message || '');
    }
  }

  error(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.errorWithDeduplication({}, context);
    } else {
      this.errorWithDeduplication(context, message || '');
    }
  }

  critical(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('critical', {}, context);
    } else {
      this.log('critical', context, message || '');
    }
  }
}

export default new Logger();
