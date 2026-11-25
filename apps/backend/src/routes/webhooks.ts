import { Router } from "express";
import { randomUUID } from "node:crypto";
import { matchStore } from "../store/index.js";
import type { MatchRecord } from "../store/match-store.js";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { requireSignature } from "../middleware/request-signature.js";
import { Permission } from "../services/permissions.js";
import {
  createWebhookSecret,
  validateWebhookUrl,
} from "../services/webhooks.js";
import { ErrorCode, errorEnvelope } from "../errors/errorResponse.js";

const router = Router();
router.use(authenticate);

router.get(
  "/",
  requirePermission(Permission.READ_ONLY),
  async (req, res, next) => {
    try {
      return res.json(await matchStore.listWebhookSubscriptions(req.address!));
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/",
  requirePermission(Permission.SUBMIT_RESULTS),
  requireSignature,
  async (req, res, next) => {
    const { matchId, url } = req.body ?? {};
    if (!Number.isSafeInteger(matchId) || matchId < 0) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            ErrorCode.VALIDATION_ERROR,
            "matchId must be a non-negative integer",
          ),
        );
    }

    let match: MatchRecord | null;
    try {
      match = await matchStore.findByMatchId(matchId);
    } catch (error) {
      return next(error);
    }
    if (!match) {
      return res
        .status(404)
        .json(errorEnvelope(ErrorCode.NOT_FOUND, "Match not found"));
    }
    if (
      match.player1.toUpperCase() !== req.address!.toUpperCase() &&
      match.player2.toUpperCase() !== req.address!.toUpperCase()
    ) {
      return res
        .status(403)
        .json(
          errorEnvelope(
            ErrorCode.FORBIDDEN,
            "Only a match participant can subscribe to its webhooks",
          ),
        );
    }

    let endpoint: string;
    try {
      endpoint = await validateWebhookUrl(url);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid webhook URL";
      return res
        .status(400)
        .json(errorEnvelope(ErrorCode.VALIDATION_ERROR, message));
    }

    const secret = createWebhookSecret();
    try {
      const id = randomUUID();
      const subscription = await matchStore.createWebhookSubscription({
        id,
        matchId,
        owner: req.address!,
        url: endpoint,
        secret,
      });
      return res.status(201).json({
        id,
        matchId,
        owner: subscription.owner,
        url: endpoint,
        secret,
        createdAt: subscription.createdAt,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to create webhook subscription";
      if (message.includes("UNIQUE constraint")) {
        return res
          .status(409)
          .json(
            errorEnvelope(
              ErrorCode.CONFLICT,
              "This webhook subscription already exists",
            ),
          );
      }
      return next(error);
    }
  },
);

router.delete(
  "/:id",
  requirePermission(Permission.SUBMIT_RESULTS),
  requireSignature,
  async (req, res, next) => {
    try {
      const deleted = await matchStore.deleteWebhookSubscription(
        req.params.id,
        req.address!,
      );
      if (!deleted) {
        return res
          .status(404)
          .json(
            errorEnvelope(
              ErrorCode.NOT_FOUND,
              "Webhook subscription not found",
            ),
          );
      }
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
