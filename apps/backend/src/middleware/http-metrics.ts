import type { NextFunction, Request, Response } from "express";
import { performance } from "node:perf_hooks";
import { httpMetrics, type HttpMetrics } from "../services/http-metrics.js";

function routeTemplate(req: Request): string {
  if (typeof req.route?.path !== "string") {
    return "unmatched";
  }
  return `${req.baseUrl}${req.route.path}`;
}

export function httpRequestMetrics(metrics: HttpMetrics = httpMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/metrics") {
      next();
      return;
    }

    const startedAt = performance.now();
    res.once("finish", () => {
      metrics.record(
        req.method,
        routeTemplate(req),
        res.statusCode,
        Math.max(0, performance.now() - startedAt),
      );
    });

    next();
  };
}
