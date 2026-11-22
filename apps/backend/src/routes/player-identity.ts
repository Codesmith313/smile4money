import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  confirmIdentityLink,
  createIdentityLinkChallenge,
} from '../services/player-identity.js';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';

const router = Router();
router.use(authenticate);

router.post('/challenge', (req, res) => {
  const { platform, username } = req.body ?? {};
  if (!req.address)
    return res
      .status(401)
      .json(
        errorEnvelope(
          ErrorCode.UNAUTHORIZED,
          'Sign in with a valid wallet and try again.',
        ),
      );
  try {
    const challenge = createIdentityLinkChallenge(
      req.address,
      platform,
      username,
    );
    return res.status(200).json(challenge);
  } catch {
    return res
      .status(400)
      .json(
        errorEnvelope(
          ErrorCode.VALIDATION_ERROR,
          'The identity-link request could not be completed. Check the platform and username, then try again.',
        ),
      );
  }
});

router.post('/confirm', async (req, res) => {
  const { nonce, signature } = req.body ?? {};
  if (typeof nonce !== 'string' || typeof signature !== 'string') {
    return res
      .status(400)
      .json(
        errorEnvelope(
          ErrorCode.VALIDATION_ERROR,
          'Both nonce and signature are required.',
        ),
      );
  }
  if (!req.address)
    return res
      .status(401)
      .json(
        errorEnvelope(
          ErrorCode.UNAUTHORIZED,
          'Sign in with a valid wallet and try again.',
        ),
      );
  if (!(await confirmIdentityLink(nonce, req.address, signature))) {
    return res
      .status(400)
      .json(
        errorEnvelope(
          ErrorCode.VALIDATION_ERROR,
          'This identity proof is invalid or expired. Request a new proof and try again.',
        ),
      );
  }
  return res.status(200).json({ linked: true });
});

export default router;
