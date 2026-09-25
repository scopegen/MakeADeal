import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  checkRateLimit,
  getRateLimitKey,
  resolveEffectiveLimits,
} from "../models/negotiation-engine.server";
import { processNegotiationAction } from "../models/negotiation-offer.server";
import {
  getDeclinedMessage,
  getExpiredMessage,
  getRateLimitedMessage,
} from "../models/negotiation-copy.server";

// Storefront-facing: POST https://{shop}/apps/negotiate/offer
// Body: sessionId (required), action ("counter" | "accept" | "decline"),
// offerPrice (required when action=counter, but a missing/unparseable price
// no longer hard-errors - see the "no price found" branch below).
//
// Top-level catch-all: an unhandled exception here doesn't just fail this
// request, it gets replaced by Shopify's own generic fallback page at the
// app-proxy layer with a bare 500 - actually harder to debug than a clean
// JSON error would be (this is how a real bug - a missing Protected
// Customer Data grant - stayed hidden through several rounds of diagnosis).
// Logs server-side rather than returning err.message/stack to the client:
// this is a public, storefront-facing endpoint, and leaking internal error
// detail to any anonymous caller is its own problem.
export const action = async (args: ActionFunctionArgs) => {
  try {
    return await runOfferAction(args);
  } catch (err) {
    console.error("[proxy.offer] unhandled exception", err);
    return Response.json({ error: "unhandled_exception" }, { status: 500 });
  }
};

async function runOfferAction({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return Response.json({ error: "not_installed" }, { status: 404 });
  }

  // Re-bind after the narrowing check above: TypeScript can't carry the
  // "admin is defined" narrowing into the acceptAt closure defined below,
  // since closures capture by reference, not by narrowed snapshot.
  const adminClient = admin;

  const shop = await getShopByDomain(session.shop);

  // ":offer" suffix keeps this counter separate from /start's bucket -
  // without it the two endpoints would share one counter per IP+window.
  const rateLimitOk = await checkRateLimit(
    shop.id,
    getRateLimitKey(request) + ":offer",
    { max: 200, windowMs: 10 * 60 * 1000 },
  );
  if (!rateLimitOk) {
    // No session loaded yet at this point (rate limiting is a blanket
    // per-IP throttle, checked before we even know which session this is
    // for) - falls back to the generic default, same as /start's rate
    // limit response does.
    return Response.json(
      { error: "rate_limited", message: getRateLimitedMessage(null) },
      { status: 429 },
    );
  }

  const formData = await request.formData();
  const sessionId = String(formData.get("sessionId") ?? "");
  const action = String(formData.get("action") ?? "");
  const offerPriceRaw = formData.get("offerPrice");

  const negotiationSession = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
  });

  if (!negotiationSession || negotiationSession.shopId !== shop.id) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }

  if (negotiationSession.expiresAt < new Date()) {
    // Uses the rule snapshotted at session-start (may be null if that rule
    // was since deleted - getExpiredMessage falls back to a generic
    // default either way, same pattern as the rate-limited path above).
    const rule = negotiationSession.ruleId
      ? await prisma.negotiationRule.findUnique({
          where: { id: negotiationSession.ruleId },
        })
      : null;
    return Response.json({
      status: "EXPIRED",
      message: getExpiredMessage(rule),
    });
  }

  if (negotiationSession.status !== "ACTIVE") {
    return Response.json(
      { error: "session_not_active", status: negotiationSession.status },
      { status: 409 },
    );
  }

  const limits = await resolveEffectiveLimits(
    adminClient,
    shop.id,
    negotiationSession.productId,
  );
  if (!limits) {
    // Settings changed underneath an in-flight session - decline rather
    // than negotiate against limits that no longer exist.
    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: { status: "DECLINED" },
    });
    return Response.json({
      status: "DECLINED",
      message: getDeclinedMessage(),
    });
  }

  return processNegotiationAction({
    admin: adminClient,
    negotiationSession,
    limits,
    action,
    offerPriceRaw,
  });
}
