import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Mandatory compliance webhook: a store owner has asked to delete a specific
// customer's data. Must complete within 30 days of receipt.
// authenticate.webhook() verifies the HMAC before this handler runs and
// throws a 401 automatically if it's invalid.
//
// Only logged-in visitors have anything to redact here - NegotiationSession
// only ever sets customerId for those (see proxy.start.tsx); an anonymous
// visitor gets anonymousId instead, which has no Shopify customer identity
// to redact against, and is covered separately by the 30-day retention purge
// job on NegotiationSession.expiresAt instead.
//
// Deleting the matching NegotiationSession rows is enough on its own -
// NegotiationOffer has onDelete: Cascade on its session relation (verified
// against the live schema), so every offer/price/message tied to those
// sessions is removed in the same transaction, not left orphaned.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

  const customerId = (payload as { customer?: { id?: number | string } })
    .customer?.id;
  if (customerId != null) {
    const shopRow = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });
    if (shopRow) {
      const gid = `gid://shopify/Customer/${customerId}`;
      const { count } = await prisma.negotiationSession.deleteMany({
        where: { shopId: shopRow.id, customerId: gid },
      });
      console.log(
        `[customers/redact] deleted ${count} session(s) for customer ${gid} on ${shop}`,
      );
    }
  }

  return new Response();
};
