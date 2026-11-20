/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */
const DEFAULT_DEDUP_WINDOW_MS = 60 * 1000;
class Logger {
    constructor() {
        this.dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;
        this.errorDedup = new Map();
    }
    log(level, context, message) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...context,
        };
        console.log(JSON.stringify(logEntry));
    }
    debug(context, message) {
        if (typeof context === 'string') {
            this.log('debug', {}, context);
        }
        else {
            this.log('debug', context, message || '');
        }
    }
    info(context, message) {
        if (typeof context === 'string') {
            this.log('info', {}, context);
        }
        else {
            this.log('info', context, message || '');
        }
    }
    warn(context, message) {
        if (typeof context === 'string') {
            this.log('warn', {}, context);
        }
        else {
            this.log('warn', context, message || '');
        }
    }
    error(context, message) {
        let ctx;
        let msg;
        if (typeof context === 'string') {
            ctx = {};
            msg = context;
        }
        else {
            ctx = context || {};
            msg = message || '';
        }
        const key = this.getErrorKey(ctx, msg);
        const now = Date.now();
        const existing = this.errorDedup.get(key);
        if (existing && now - existing.firstSeen < this.dedupWindowMs) {
            existing.count += 1;
            return;
        }
        if (existing) {
            this.log('info', {
                deduplicated: true,
                suppressedCount: existing.count,
                windowMs: this.dedupWindowMs,
                errorKey: key,
            }, `Suppressed ${existing.count} duplicate error(s) in the last ${this.dedupWindowMs}ms`);
        }
        this.errorDedup.set(key, { firstSeen: now, count: 0 });
        this.log('error', ctx, msg);
    }
    getErrorKey(context, message) {
        const err = context && context.error;
        const stack = err && err.stack ? err.stack : '';
        const name = err && err.name ? err.name : '';
        return `${name}|${message}|${stack}`;
    }
}
export default new Logger();
