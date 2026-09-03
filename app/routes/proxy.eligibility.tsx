import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import { resolveEffectiveLimits } from "../models/negotiation-engine.server";

// Storefront-facing: GET https://{shop}/apps/negotiate/eligibility?productId=...
// Cheap read-only check so the widget only renders its button on products
// that are actually negotiable, without creating a NegotiationSession just
// from a page view.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return Response.json({ eligible: false });
  }

  const shop = await getShopByDomain(session.shop);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") ?? "";
  if (!productId) {
    return Response.json({ eligible: false });
  }

  const limits = await resolveEffectiveLimits(admin, shop.id, productId);
  if (!limits) {
    return Response.json({ eligible: false });
  }

  // The bot's name is the only merchant-configurable thing left in the
  // widget - colors, button text, and everything else are fixed (see the
  // widget's own file header comment). Comes from whichever rule won (see
  // resolveEffectiveLimits's overlap resolution), not a shop-wide singleton.
  return Response.json({
    eligible: true,
    config: {
      headerTitle: limits.rule.headerTitle ?? null,
    },
  });
};
