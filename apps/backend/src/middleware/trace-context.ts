/**
 * Trace context middleware (issue #123).
 *
 * Continues the caller's W3C trace (`traceparent` / `tracestate`) or valid
 * `X-Trace-ID`, or starts a new trace. The active context is available to
 * logs and downstream requests for the lifetime of the request.
 *
 * Mount it before every other middleware so their log lines carry the ids.
 */
import type { NextFunction, Request, Response } from "express";
import {
  contextFromHeaders,
  formatTraceparent,
  runWithTraceContext,
} from "../tracing/trace-context.js";

export function traceContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = contextFromHeaders(
      req.header("traceparent"),
      req.header("tracestate"),
      req.header("x-trace-id"),
    );
    res.setHeader("traceparent", formatTraceparent(ctx));
    res.setHeader("x-request-id", ctx.spanId);
    res.setHeader("x-correlation-id", ctx.traceId);
    res.setHeader("x-trace-id", ctx.traceId);
    runWithTraceContext(ctx, () => next());
  };
}

export default traceContext;
