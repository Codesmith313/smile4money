const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const PERCENTILES = [0.5, 0.9, 0.95, 0.99];
const DEFAULT_RECENT_WINDOW_SIZE = 10_000;

interface HttpRequestMetrics {
  count: number;
  durationSumSeconds: number;
  bucketCounts: number[];
}

export interface HttpMetrics {
  record(
    method: string,
    route: string,
    status: number,
    durationMs: number,
  ): void;
  render(): string;
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
    normalized,
  )
    ? normalized
    : "OTHER";
}

function normalizeRoute(route: string): string {
  const normalized = route.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

function nearestRankPercentile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1];
}

export function createHttpMetrics(
  recentWindowSize = DEFAULT_RECENT_WINDOW_SIZE,
): HttpMetrics {
  if (!Number.isSafeInteger(recentWindowSize) || recentWindowSize < 1) {
    throw new Error("Recent HTTP metrics window must be a positive integer");
  }

  const requests = new Map<string, HttpRequestMetrics>();
  const recentDurationsSeconds: number[] = [];
  let nextRecentIndex = 0;

  return {
    record(method, route, status, durationMs) {
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("HTTP metrics status must be between 100 and 599");
      }
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(
          "HTTP request duration must be finite and non-negative",
        );
      }

      const normalizedMethod = normalizeMethod(method);
      const normalizedRoute = normalizeRoute(route);
      const durationSeconds = durationMs / 1000;
      const key = JSON.stringify([normalizedMethod, normalizedRoute, status]);
      let metric = requests.get(key);
      if (!metric) {
        metric = {
          count: 0,
          durationSumSeconds: 0,
          bucketCounts: DURATION_BUCKETS_SECONDS.map(() => 0),
        };
        requests.set(key, metric);
      }

      metric.count += 1;
      metric.durationSumSeconds += durationSeconds;
      for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
        if (durationSeconds <= DURATION_BUCKETS_SECONDS[index]) {
          metric.bucketCounts[index] += 1;
        }
      }

      if (recentDurationsSeconds.length < recentWindowSize) {
        recentDurationsSeconds.push(durationSeconds);
      } else {
        recentDurationsSeconds[nextRecentIndex] = durationSeconds;
        nextRecentIndex = (nextRecentIndex + 1) % recentWindowSize;
      }
    },

    render() {
      const lines = [
        "# HELP http_requests_total Total number of completed HTTP requests, excluding /metrics.",
        "# TYPE http_requests_total counter",
      ];

      const sortedRequests = [...requests.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      for (const [key, metric] of sortedRequests) {
        const [method, route, status] = JSON.parse(key) as [
          string,
          string,
          number,
        ];
        const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`;
        lines.push(`http_requests_total{${labels}} ${metric.count}`);
      }

      lines.push(
        "# HELP http_request_duration_seconds HTTP request duration distribution in seconds.",
        "# TYPE http_request_duration_seconds histogram",
      );
      for (const [key, metric] of sortedRequests) {
        const [method, route, status] = JSON.parse(key) as [
          string,
          string,
          number,
        ];
        const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`;
        DURATION_BUCKETS_SECONDS.forEach((bucket, index) => {
          lines.push(
            `http_request_duration_seconds_bucket{${labels},le="${bucket}"} ${metric.bucketCounts[index]}`,
          );
        });
        lines.push(
          `http_request_duration_seconds_bucket{${labels},le="+Inf"} ${metric.count}`,
          `http_request_duration_seconds_sum{${labels}} ${metric.durationSumSeconds}`,
          `http_request_duration_seconds_count{${labels}} ${metric.count}`,
        );
      }

      lines.push(
        `# HELP http_request_duration_seconds_quantile Exact response-time percentile in seconds over the most recent ${recentWindowSize} completed requests, excluding /metrics.`,
        "# TYPE http_request_duration_seconds_quantile gauge",
      );
      if (recentDurationsSeconds.length > 0) {
        for (const percentile of PERCENTILES) {
          const value = nearestRankPercentile(
            recentDurationsSeconds,
            percentile * 100,
          );
          lines.push(
            `http_request_duration_seconds_quantile{quantile="${percentile}"} ${value}`,
          );
        }
      }

      return `${lines.join("\n")}\n`;
    },
  };
}

export const httpMetrics = createHttpMetrics();
