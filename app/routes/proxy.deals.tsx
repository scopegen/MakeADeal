import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  checkRateLimit,
  getRateLimitKey,
} from "../models/negotiation-engine.server";
import { getRateLimitedMessage } from "../models/negotiation-copy.server";
import { removeDealFromBag, shopperFrom } from "../models/deal-bag.server";

// Storefront-facing: POST https://{shop}/apps/negotiate/deals
// Multi-product deals: the chat's "Your deals" list. Body: action
// ("remove"), sessionId (the deal to remove), anonymousId (whose bag), and
// displayCurrency/displayRate like /offer. Answers with the updated bag, or
// bag: null once it's empty - see removeDealFromBag in deal-bag.server.ts.
//
// Only the shopper's own bag is ever touched: the deal has to be in the bag
// found for their customer account or browser id.
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    if (!admin || !session) {
      return Response.json({ error: "not_installed" }, { status: 404 });
    }
    const shop = await getShopByDomain(session.shop);

    // Own bucket, like /start's and /offer's.
    const rateLimitOk = await checkRateLimit(
      shop.id,
      getRateLimitKey(request) + ":deals",
      { max: 100, windowMs: 10 * 60 * 1000 },
    );
    if (!rateLimitOk) {
      return Response.json(
        { error: "rate_limited", message: getRateLimitedMessage(null) },
        { status: 429 },
      );
    }

    if (!shop.multiDealsEnabled) {
      return Response.json({ error: "not_available" }, { status: 404 });
    }

    const formData = await request.formData();
    if (String(formData.get("action") ?? "") !== "remove") {
      return Response.json({ error: "unknown_action" }, { status: 400 });
    }

    const result = await removeDealFromBag(admin, {
      shopId: shop.id,
      settings: shop,
      shopper: shopperFrom(request, formData.get("anonymousId")),
      sessionId: String(formData.get("sessionId") ?? ""),
      displayParams: formData,
    });
    if (!result.ok) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ bag: result.view });
  } catch (err) {
    // Same reasoning as proxy.offer.tsx's catch-all: a clean JSON error, the
    // detail only in our own logs.
    console.error("[proxy.deals] unhandled exception", err);
    return Response.json({ error: "unhandled_exception" }, { status: 500 });
  }
};
