import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  NEGOTIATIONS_PAGE_SIZE,
  getPageWindow,
} from "../models/pagination";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  // 50 negotiations per page, newest first, paged with ?page=2 and so on.
  const total = await prisma.negotiationSession.count({
    where: { shopId: shop.id },
  });
  const pageWindow = getPageWindow(
    total,
    new URL(request.url).searchParams.get("page"),
    NEGOTIATIONS_PAGE_SIZE,
  );

  // id is only a tie-breaker, so two negotiations created in the same instant
  // can never swap places or repeat between pages.
  const sessions = await prisma.negotiationSession.findMany({
    where: { shopId: shop.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: pageWindow.skip,
    take: NEGOTIATIONS_PAGE_SIZE,
  });

  // Product titles aren't stored on the session (only productId is, same
  // "don't mirror Shopify data, look it up live" reasoning as the Rules
  // editor's own title lookups) - resolved here in one batched call rather
  // than showing the raw GID. A product deleted since the session happened
  // comes back with no title and falls back to showing the id, same as the
  // Rules editor's product picker does for a deleted product.
  const productIds = [...new Set(sessions.map((s) => s.productId))];
  const titleById = new Map<string, string>();
  if (productIds.length > 0) {
    const response = await admin.graphql(
      `#graphql
      query SessionProductTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on Product {
            title
          }
        }
      }`,
      { variables: { ids: productIds } },
    );
    const json = (await response.json()) as {
      data: { nodes: ({ id: string; title?: string } | null)[] };
    };
    for (const node of json.data.nodes ?? []) {
      if (node && typeof node.title === "string") {
        titleById.set(node.id, node.title);
      }
    }
  }

  // Prisma Decimal fields don't survive React Router's client-side data
  // transport as real Decimal instances - .toString() works fine during SSR
  // but produces "[object Object]" after client-side hydration deserializes
  // the payload, which fails hydration for the whole page (and, worse,
  // leaves the client router in a broken state for every navigation after
  // it - this was the actual root cause behind the Rules pages' navigation
  // never visually updating, not anything in the Rules routes themselves).
  // Converting to plain strings here means server and client always agree.
  return {
    // Only the fields the page shows, not the whole row: a row also carries
    // the shopper's customer id or browser id, which has no reason to be sent
    // to the browser.
    sessions: sessions.map((s) => ({
      id: s.id,
      status: s.status,
      createdAt: s.createdAt,
      productTitle: titleById.get(s.productId) ?? s.productId,
      startingPrice: s.startingPrice.toString(),
      currentOfferPrice: s.currentOfferPrice?.toString() ?? null,
    })),
    total,
    page: pageWindow.page,
    totalPages: pageWindow.totalPages,
    hasPrevious: pageWindow.hasPrevious,
    hasNext: pageWindow.hasNext,
    firstShown: sessions.length === 0 ? 0 : pageWindow.skip + 1,
    lastShown: pageWindow.skip + sessions.length,
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
  const {
    sessions,
    total,
    page,
    totalPages,
    hasPrevious,
    hasNext,
    firstShown,
    lastShown,
  } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Negotiations">
      <s-section>
        <s-banner tone="info" heading="Verifying negotiated orders">
          <s-paragraph>
            Orders created from an accepted negotiation are tagged{" "}
            <strong>Noodle</strong> in your order list. Use that tag to
            filter or verify which orders came from a negotiation.
          </s-paragraph>
        </s-banner>

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
              <s-table-header format="numeric">Starting price</s-table-header>
              <s-table-header format="numeric">Current offer</s-table-header>
              <s-table-header>Started</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sessions.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>{s.productTitle}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[s.status] ?? "neutral"}>
                      {s.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{s.startingPrice}</s-table-cell>
                  <s-table-cell>{s.currentOfferPrice ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {new Date(s.createdAt).toLocaleString()}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {/* Only shown when there is more than one page, like Shopify's own
            lists. Plain links to ?page=N rather than the table's built-in
            pagination events, which React 18 doesn't wire up for custom
            elements. A disabled arrow has no link at all. */}
        {totalPages > 1 && (
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-paragraph>
              Showing {firstShown} to {lastShown} of {total}
            </s-paragraph>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button
                icon="chevron-left"
                accessibilityLabel="Previous page"
                href={hasPrevious ? `/app?page=${page - 1}` : undefined}
                disabled={!hasPrevious || undefined}
              ></s-button>
              <s-button
                icon="chevron-right"
                accessibilityLabel="Next page"
                href={hasNext ? `/app?page=${page + 1}` : undefined}
                disabled={!hasNext || undefined}
              ></s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
