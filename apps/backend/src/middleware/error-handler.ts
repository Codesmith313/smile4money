import type { ErrorRequestHandler } from "express";
import { errorToHttpStatus } from "../errors/errorToHttpStatus.js";
import {
  errorEnvelope,
  statusToErrorCode,
  userFacingErrorMessage,
} from "../errors/errorResponse.js";
import logger from "../logger.js";

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = errorToHttpStatus(err);
  const code = statusToErrorCode(status);
  logger.error({ status, error_code: code }, "http_error");
  res.status(status).json(errorEnvelope(code, userFacingErrorMessage(status)));
};

export default errorHandler;
