import type { ErrorRequestHandler } from "express";
import { errorToHttpStatus } from "../errors/errorToHttpStatus.js";
import { errorEnvelope, statusToErrorCode } from "../errors/errorResponse.js";
import logger from "../logger.js";

function extractDetails(error: unknown): unknown {
  if (error && typeof error === "object" && "details" in error) {
    return (error as { details?: unknown }).details;
  }
  return undefined;
}

export const apiErrorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  _next,
) => {
  const status = errorToHttpStatus(error);

  if (status >= 500) {
    logger.error({ status, method: req.method, error }, "http_request_failed");
  } else {
    logger.warn({ status, method: req.method, error }, "http_request_failed");
  }

  const code = statusToErrorCode(status);

  if (status >= 500) {
    // Hide internal details for server errors.
    res
      .status(status)
      .json(errorEnvelope(code, "An unexpected server error occurred."));
    return;
  }

  const message =
    error instanceof Error
      ? error.message
      : "The request could not be completed.";

  const details = extractDetails(error);

  res.status(status).json(errorEnvelope(code, message, details));
};