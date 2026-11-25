import type { ErrorRequestHandler } from "express";
import { errorToHttpStatus } from "../errors/errorToHttpStatus.js";
import {
  errorEnvelope,
  statusToErrorCode,
  userFacingErrorMessage,
} from "../errors/errorResponse.js";
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
  const details = status < 500 ? extractDetails(error) : undefined;

  res
    .status(status)
    .json(errorEnvelope(code, userFacingErrorMessage(status), details));
};
