import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  await db.shop.upsert({
    where: { shopDomain: shop },
    create: { shopDomain: shop, uninstalledAt: new Date() },
    update: { uninstalledAt: new Date() },
  });

  return new Response();
};
