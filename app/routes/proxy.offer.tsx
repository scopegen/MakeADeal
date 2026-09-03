import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  checkRateLimit,
  createNegotiatedDraftOrder,
  getRateLimitKey,
  resolveEffectiveLimits,
} from "../models/negotiation-engine.server";
import {
  classifySegment,
  evaluateSegmentedOffer,
  getAcceptedMessage,
  getNoPriceMessage,
} from "../models/negotiation-tiers.server";
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

  const startingPrice = Number(negotiationSession.startingPrice);

  async function acceptAt(price: number) {
    let draftOrder: { id: string; invoiceUrl: string };
    try {
      // Both cached on the session at /start - no extra API round-trip
      // needed here beyond the draftOrderCreate call itself. See the
      // schema comment on NegotiationSession.currencyCode for why this
      // matters: accept used to make three sequential Admin API calls,
      // which was the actual cause of it timing out through the app-proxy
      // layer under normal latency.
      draftOrder = await createNegotiatedDraftOrder(
        adminClient,
        negotiationSession!.variantId,
        price,
        negotiationSession!.currencyCode,
        negotiationSession!.id,
      );
    } catch (err) {
      return Response.json(
        { error: "draft_order_failed", detail: String(err) },
        { status: 502 },
      );
    }

    await prisma.negotiationSession.update({
      where: { id: negotiationSession!.id },
      data: {
        status: "ACCEPTED",
        currentOfferPrice: price,
        draftOrderId: draftOrder.id,
        draftOrderExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });

    return Response.json({
      status: "ACCEPTED",
      message: getAcceptedMessage(price),
      price,
      checkoutUrl: draftOrder.invoiceUrl,
    });
  }

  if (action === "decline") {
    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: { status: "DECLINED" },
    });
    return Response.json({ status: "DECLINED", message: getDeclinedMessage() });
  }

  if (action === "accept") {
    if (negotiationSession.currentOfferPrice === null) {
      return Response.json({ error: "nothing_to_accept" }, { status: 400 });
    }
    return acceptAt(Number(negotiationSession.currentOfferPrice));
  }

  if (action === "counter") {
    const offerPrice = Number(offerPriceRaw);
    // No parseable price in the message - doesn't consume a round or error
    // out, just asks conversationally for one. Doesn't touch currentRound
    // or segment at all, so a chatty "hi"/"maybe" reply before any real
    // offer costs nothing.
    if (!offerPriceRaw || !Number.isFinite(offerPrice) || offerPrice <= 0) {
      return Response.json({ status: "ACTIVE", message: getNoPriceMessage() });
    }

    // Classified once, on the first valid offer only - never reassigned
    // afterward even if a later offer would classify differently. See the
    // schema comment on NegotiationSession.segment.
    let segment = negotiationSession.segment;
    if (!segment) {
      const percentFloor =
        startingPrice * (1 - limits.maxDiscountPercent / 100);
      const floorPrice =
        limits.floorPriceOverride !== null
          ? Math.max(percentFloor, limits.floorPriceOverride)
          : percentFloor;
      const maxDiscountAmount = startingPrice * (limits.maxDiscountPercent / 100);
      segment = classifySegment(offerPrice, floorPrice, maxDiscountAmount);
      await prisma.negotiationSession.update({
        where: { id: negotiationSession.id },
        data: { segment },
      });
    }

    const evaluation = evaluateSegmentedOffer(
      segment,
      startingPrice,
      limits.maxDiscountPercent,
      limits.floorPriceOverride,
      negotiationSession.currentRound,
      offerPrice,
    );

    await prisma.negotiationOffer.create({
      data: {
        sessionId: negotiationSession.id,
        round: negotiationSession.currentRound + 1,
        actor: "CUSTOMER",
        offerPrice,
      },
    });

    if (evaluation.outcome === "ACCEPTED") {
      await prisma.negotiationOffer.create({
        data: {
          sessionId: negotiationSession.id,
          round: negotiationSession.currentRound + 1,
          actor: "BOT",
          offerPrice: evaluation.price,
          messageText: "accepted",
        },
      });
      return acceptAt(evaluation.price);
    }

    if (evaluation.outcome === "ASK_FOR_MORE") {
      // No price attached - only reachable at tier 1 of Can-Be-Converted/
      // Too-Low (see the noPrice flag on Tier in negotiation-tiers.server).
      // Advances the round so the next real offer lands on tier 2, but
      // there's nothing to log as an offer price or set as currentOfferPrice
      // yet.
      await prisma.negotiationSession.update({
        where: { id: negotiationSession.id },
        data: { currentRound: evaluation.round },
      });
      await prisma.negotiationOffer.create({
        data: {
          sessionId: negotiationSession.id,
          round: evaluation.round,
          actor: "BOT",
          messageText: evaluation.message,
        },
      });
      return Response.json({
        status: "ACTIVE",
        message: evaluation.message,
        round: evaluation.round,
      });
    }

    if (evaluation.outcome === "FLOOR_HELD") {
      // currentRound still advances by one each turn even though the
      // segment's tier table is exhausted (evaluateSegmentedOffer keeps
      // returning the same floor price regardless) - purely so the offer
      // history log shows a monotonically increasing round number per
      // exchange, not repeats.
      const nextRound = negotiationSession.currentRound + 1;
      await prisma.negotiationSession.update({
        where: { id: negotiationSession.id },
        data: { currentRound: nextRound, currentOfferPrice: evaluation.price },
      });
      await prisma.negotiationOffer.create({
        data: {
          sessionId: negotiationSession.id,
          round: nextRound,
          actor: "BOT",
          offerPrice: evaluation.price,
          messageText: evaluation.message,
        },
      });
      return Response.json({
        status: "ACTIVE",
        floorReached: true,
        message: evaluation.message,
        price: evaluation.price,
      });
    }

    // COUNTERED
    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: {
        currentRound: evaluation.round,
        currentOfferPrice: evaluation.price,
      },
    });
    await prisma.negotiationOffer.create({
      data: {
        sessionId: negotiationSession.id,
        round: evaluation.round,
        actor: "BOT",
        offerPrice: evaluation.price,
        messageText: evaluation.message,
      },
    });
    return Response.json({
      status: "ACTIVE",
      message: evaluation.message,
      price: evaluation.price,
      round: evaluation.round,
      finalTier: evaluation.isFinalTier,
    });
  }

  return Response.json({ error: "unknown_action" }, { status: 400 });
}
