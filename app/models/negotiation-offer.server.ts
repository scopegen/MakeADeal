import type { NegotiationSession } from "@prisma/client";
import prisma from "../db.server";
import { createNegotiatedDraftOrder } from "./negotiation-engine.server";
import type { AdminGraphqlClient } from "./draft-order-lookup.server";
import {
  classifySegment,
  evaluateSegmentedOffer,
  getAcceptedAtListPriceMessage,
  getAcceptedMessage,
  getNoPriceMessage,
} from "./negotiation-tiers.server";
import { getDeclinedMessage } from "./negotiation-copy.server";

// The decision for one customer action on an already-loaded, already-
// validated session (owned by the shop, not expired, ACTIVE, limits still
// resolvable). Shared by /offer (every message after the first) and /start
// (the shopper's first message, handled in the same request that creates the
// session - see proxy.start.tsx), so both behave identically.
//
// Returns a plain Response so each caller can pass it straight back (or, for
// /start, read its JSON and embed it).
export async function processNegotiationAction({
  admin,
  negotiationSession,
  limits,
  action,
  offerPriceRaw,
}: {
  admin: AdminGraphqlClient;
  negotiationSession: NegotiationSession;
  limits: { maxDiscountPercent: number; floorPriceOverride: number | null };
  action: string;
  offerPriceRaw: FormDataEntryValue | null;
}): Promise<Response> {
  const startingPrice = Number(negotiationSession.startingPrice);

  async function acceptAt(price: number, atOrAboveListPrice = false) {
    let draftOrder: { id: string; invoiceUrl: string };
    try {
      // Both cached on the session at /start - no extra API round-trip
      // needed here beyond the draftOrderCreate call itself. See the
      // schema comment on NegotiationSession.currencyCode for why this
      // matters: accept used to make three sequential Admin API calls,
      // which was the actual cause of it timing out through the app-proxy
      // layer under normal latency.
      draftOrder = await createNegotiatedDraftOrder(
        admin,
        negotiationSession.variantId,
        price,
        negotiationSession.currencyCode,
        negotiationSession.id,
      );
    } catch (err) {
      return Response.json(
        { error: "draft_order_failed", detail: String(err) },
        { status: 502 },
      );
    }

    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: {
        status: "ACCEPTED",
        currentOfferPrice: price,
        draftOrderId: draftOrder.id,
        draftOrderExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });

    return Response.json({
      status: "ACCEPTED",
      message: atOrAboveListPrice
        ? getAcceptedAtListPriceMessage(price)
        : getAcceptedMessage(price),
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
      return acceptAt(evaluation.price, evaluation.atOrAboveListPrice);
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
