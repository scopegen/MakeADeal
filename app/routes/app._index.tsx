import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  const sessions = await prisma.negotiationSession.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Prisma Decimal fields don't survive React Router's client-side data
  // transport as real Decimal instances - .toString() works fine during SSR
  // but produces "[object Object]" after client-side hydration deserializes
  // the payload, which fails hydration for the whole page (and, worse,
  // leaves the client router in a broken state for every navigation after
  // it - this was the actual root cause behind the Rules pages' navigation
  // never visually updating, not anything in the Rules routes themselves).
  // Converting to plain strings here means server and client always agree.
  return {
    sessions: sessions.map((s) => ({
      ...s,
      startingPrice: s.startingPrice.toString(),
      currentOfferPrice: s.currentOfferPrice?.toString() ?? null,
    })),
  };
};

const STATUS_TONE: Record<
  string,
  "info" | "success" | "critical" | "neutral"
> = {
  ACTIVE: "info",
  ACCEPTED: "success",
  DECLINED: "critical",
  EXPIRED: "neutral",
};

export default function NegotiationsLog() {
  const { sessions } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Negotiations">
      <s-section>
        {sessions.length === 0 ? (
          <s-stack direction="block" gap="base" alignItems="center">
            <s-paragraph>
              No negotiations yet. Once the storefront widget is live and a
              visitor starts negotiating on a product with negotiation turned
              on, sessions will show up here.
            </s-paragraph>
            <s-link href="/app/rules">Go to rules</s-link>
          </s-stack>
        ) : (
          <s-table variant="auto" paginate={false}>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Round</s-table-header>
              <s-table-header format="numeric">Starting price</s-table-header>
              <s-table-header format="numeric">Current offer</s-table-header>
              <s-table-header>Trigger</s-table-header>
              <s-table-header>Started</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sessions.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>{s.productId}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[s.status] ?? "neutral"}>
                      {s.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{s.currentRound}</s-table-cell>
                  <s-table-cell>{s.startingPrice}</s-table-cell>
                  <s-table-cell>{s.currentOfferPrice ?? "—"}</s-table-cell>
                  <s-table-cell>{s.triggerType}</s-table-cell>
                  <s-table-cell>
                    {new Date(s.createdAt).toLocaleString()}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
