import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import https from "node:https";
import axios from "axios";
import type { MatchStorePort, WebhookDelivery } from "../store/match-store.js";
import logger from "../logger.js";

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 8;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60 * 60 * 1_000;

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 0 ||
          b === 2 ||
          b === 168 ||
          (b === 88 && Number(address.split(".")[2]) === 99))) ||
      (a === 198 &&
        (b === 18 ||
          b === 19 ||
          (b === 51 && Number(address.split(".")[2]) === 100))) ||
      (a === 203 && b === 0 && Number(address.split(".")[2]) === 113)
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized !== "::" &&
      normalized !== "::1" &&
      !normalized.startsWith("fc") &&
      !normalized.startsWith("fd") &&
      !/^fe[89ab]/.test(normalized) &&
      !normalized.startsWith("::ffff:") &&
      !normalized.startsWith("2001:db8:") &&
      !normalized.startsWith("ff")
    );
  }
  return false;
}

export async function validateWebhookUrl(input: unknown): Promise<string> {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("url must be a string no longer than 2048 characters");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("url must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    isIP(url.hostname)
  ) {
    throw new Error(
      "url must be a public HTTPS endpoint without credentials or a fragment",
    );
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("url hostname could not be resolved");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error(
      "url hostname must resolve exclusively to public IP addresses",
    );
  }
  return url.toString();
}

export function createWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signWebhookPayload(
  secret: string,
  timestamp: string,
  payload: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  payload: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, payload));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function postWebhook(delivery: WebhookDelivery): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(
    delivery.secret,
    timestamp,
    delivery.payload,
  );
  const agent = new https.Agent({
    lookup: (
      hostname: string,
      options: LookupOptions,
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => {
      void lookup(hostname, { all: true, verbatim: true })
        .then((addresses) => {
          if (
            addresses.length === 0 ||
            addresses.some(({ address }) => !isPublicAddress(address))
          ) {
            callback(
              new Error("Webhook hostname resolved to a non-public address"),
            );
            return;
          }
          if (options.all) {
            callback(null, addresses);
            return;
          }
          const address = addresses[0];
          callback(null, address.address, address.family);
        })
        .catch((error: NodeJS.ErrnoException) => callback(error));
    },
  });
  try {
    const response = await axios.post(delivery.url, delivery.payload, {
      timeout: WEBHOOK_TIMEOUT_MS,
      maxRedirects: 0,
      proxy: false,
      httpsAgent: agent,
      validateStatus: () => true,
      headers: {
        "content-type": "application/json",
        "x-smile4money-event": delivery.eventId,
        "x-smile4money-timestamp": timestamp,
        "x-smile4money-signature": signature,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
    }
  } finally {
    agent.destroy();
  }
}

export async function deliverWebhookBatch(
  store: MatchStorePort,
  send: (delivery: WebhookDelivery) => Promise<void> = postWebhook,
  now = Date.now(),
): Promise<void> {
  const deliveries = await store.getDueWebhookDeliveries(now, 25);
  for (const delivery of deliveries) {
    try {
      await send(delivery);
      await store.completeWebhookDelivery(delivery.id, { success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = delivery.attempts + 1 >= MAX_ATTEMPTS;
      const delay = Math.min(
        BASE_RETRY_MS * 2 ** delivery.attempts,
        MAX_RETRY_MS,
      );
      await store.completeWebhookDelivery(delivery.id, {
        success: false,
        error: message,
        nextAttemptAt: now + delay,
        terminal,
      });
      logger.warn(
        {
          delivery_id: delivery.id,
          event_id: delivery.eventId,
          attempt: delivery.attempts + 1,
          terminal,
        },
        terminal
          ? "webhook_delivery_exhausted"
          : "webhook_delivery_retry_scheduled",
      );
    }
  }
}

export function startWebhookRetryWorker(
  store: MatchStorePort,
  intervalMs = 5_000,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const run = () => {
    if (inFlight) return;
    inFlight = deliverWebhookBatch(store)
      .catch((error) =>
        logger.error({ error }, "webhook_delivery_worker_failed"),
      )
      .finally(() => {
        inFlight = undefined;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
