/**
 * ProviderSchemaError is thrown when a chess provider returns a payload the
 * parser does not recognise: a missing field, a wrong type, or a result code
 * outside the known set.
 *
 * This is deliberately not mapped to any MatchResult. A provider changing its
 * schema must stop settlement and surface as a failed poll, never silently
 * settle a wager as a draw or a win (issue #121).
 *
 * Optional diagnostic context (url, attempt, traceId) and a raw response
 * snippet can be attached so that schema changes are logged with full context
 * (issue #2107).
 */
export interface ProviderSchemaErrorContext {
  /** The request URL that produced the unrecognised payload. */
  url?: string;
  /** The attempt number (1-based) on which the schema error occurred. */
  attempt?: number;
  /** Correlation id for tracing the poll that produced the error. */
  traceId?: string;
  /** A truncated snippet of the raw response body for diagnostics. */
  responseSnippet?: string;
}

export class ProviderSchemaError extends Error {
  public readonly url?: string;
  public readonly attempt?: number;
  public readonly traceId?: string;
  public readonly responseSnippet?: string;

  constructor(
    public readonly provider: "lichess" | "chessdotcom",
    message: string,
    context: ProviderSchemaErrorContext = {},
  ) {
    const details: string[] = [];
    if (context.url !== undefined) {
      details.push(`url=${context.url}`);
    }
    if (context.attempt !== undefined) {
      details.push(`attempt=${context.attempt}`);
    }
    if (context.traceId !== undefined) {
      details.push(`traceId=${context.traceId}`);
    }
    if (context.responseSnippet !== undefined) {
      details.push(`response=${context.responseSnippet}`);
    }

    const suffix = details.length > 0 ? ` [${details.join(", ")}]` : "";
    super(`${provider} response schema not recognised: ${message}${suffix}`);
    this.name = "ProviderSchemaError";
    this.url = context.url;
    this.attempt = context.attempt;
    this.traceId = context.traceId;
    this.responseSnippet = context.responseSnippet;
    Object.setPrototypeOf(this, ProviderSchemaError.prototype);
  }
}