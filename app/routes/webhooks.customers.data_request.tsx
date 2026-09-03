import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Mandatory compliance webhook: a customer has asked a merchant for the data
// this app holds on them. Shopify doesn't relay data back to the customer
// itself - the payload only tells you what to go retrieve, and the app must
// be able to produce it to the store owner within 30 days (there's no
// requirement that this webhook's own response body carry it).
// authenticate.webhook() verifies the HMAC before this handler runs and
// throws a 401 automatically if it's invalid.
//
// This app has no data-export/delivery UI yet, so the minimal compliant
// action is: find every record tied to this customer and log it in a
// structured, greppable form the merchant/support process can pull from
// within the 30-day window. Only logged-in visitors have a customerId to
// match against - see the identical caveat in webhooks.customers.redact.
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
      const sessions = await prisma.negotiationSession.findMany({
        where: { shopId: shopRow.id, customerId: gid },
        include: { offers: true },
      });
      console.log(
        `[customers/data_request] ${sessions.length} session(s) for customer ${gid} on ${shop}:`,
        JSON.stringify(sessions),
      );
    }
  }

  return new Response();
};
