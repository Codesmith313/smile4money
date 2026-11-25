import { Router } from "express";
import {
  sponsorPolicy,
  sponsorTransaction,
} from "../services/transaction-sponsor.js";
import { ErrorCode, errorEnvelope } from "../errors/errorResponse.js";
import {
  authenticate,
  requirePermission,
  Permission,
} from "../middleware/auth.js";
import { requireSignature } from "../middleware/requestSignature.js";
const router = Router();
// A valid allowlisted player's transaction signature is the authorization.
// Sponsorship is a critical operation: it requires an authenticated caller
// with the submit_results scope and a valid HMAC-SHA256 request signature.
router.post(
  "/sponsor",
  authenticate,
  requirePermission(Permission.submit_results),
  requireSignature,
  async (req, res) => {
    if (process.env.FEE_SPONSOR_ENABLED !== "true")
      return res
        .status(503)
        .json(
          errorEnvelope(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Fee sponsorship is currently unavailable. Please try again later.",
          ),
        );
    if (
      typeof req.body?.signedTxXdr !== "string" ||
      req.body.signedTxXdr.length > 30000 ||
      req.body.optIn !== true
    )
      return res
        .status(400)
        .json(
          errorEnvelope(
            ErrorCode.VALIDATION_ERROR,
            "A signed transaction and explicit opt-in are required.",
          ),
        );
    try {
      return res.json(
        await sponsorTransaction(
          req.body.signedTxXdr,
          req.body.optIn,
          sponsorPolicy(),
        ),
      );
    } catch {
      // Neither secret keys nor request XDR are returned to clients.
      return res.status(400).json(
        errorEnvelope(
          ErrorCode.VALIDATION_ERROR,
          "Sponsorship was not approved. Check eligibility, limits, signature, expiry, and prior submission.",
        ),
      );
    }
  },
);
export default router;