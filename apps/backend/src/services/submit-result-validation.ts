export interface SubmitResultValidationIssue {
  field: string;
  message: string;
}

export function validateSubmitResultInputDetailed(
  input: unknown,
): SubmitResultValidationIssue[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [{ field: "body", message: "Request body must be an object" }];
  }

  const body = input as Record<string, unknown>;
  const errors: SubmitResultValidationIssue[] = [];

  if (
    typeof body.matchId !== "number" ||
    !Number.isSafeInteger(body.matchId) ||
    body.matchId < 0
  ) {
    errors.push({
      field: "matchId",
      message: "matchId must be a non-negative safe integer",
    });
  }
  if (typeof body.gameId !== "string" || body.gameId.trim().length === 0) {
    errors.push({ field: "gameId", message: "gameId is required" });
  } else if (body.gameId.length >= 512) {
    errors.push({ field: "gameId", message: "gameId is too long" });
  }
  if (body.platform !== "lichess" && body.platform !== "chessdotcom") {
    errors.push({
      field: "platform",
      message: "platform must be lichess or chessdotcom",
    });
  }
  if (body.username !== undefined && typeof body.username !== "string") {
    errors.push({ field: "username", message: "username must be a string" });
  } else if (
    body.platform === "chessdotcom" &&
    (typeof body.username !== "string" || body.username.trim().length === 0)
  ) {
    errors.push({
      field: "username",
      message: "username is required for chessdotcom",
    });
  }

  return errors;
}
