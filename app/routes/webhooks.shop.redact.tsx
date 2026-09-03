import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory compliance webhook: fires ~48h after a shop uninstalls the app.
// Everything this app stored for that shop must actually be deleted here -
// not just the access token (already cleared by webhooks.app.uninstalled).
// authenticate.webhook() verifies the HMAC before this handler runs and
// throws a 401 automatically if it's invalid.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

  // Defensive: session rows should already be gone via app/uninstalled, but
  // don't assume that webhook fired cleanly.
  await db.session.deleteMany({ where: { shop } });

  // Deleting the Shop row is the actual full-purge point: every negotiation
  // table (NegotiationRule, Ladder/LadderStep, NegotiationSession/
  // NegotiationOffer, OfferLink, RateLimitBucket) has onDelete: Cascade on
  // its shopId relation - verified against the live DB's FK constraints,
  // not just the Prisma schema declaration - so this one delete purges
  // everything scoped to this shop, not just the lifecycle row itself.
  await db.shop.deleteMany({ where: { shopDomain: shop } });

  return new Response();
};
