import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireInternalShop } from "../models/internal-access.server";
import { getStoreDetail } from "../models/internal-stats.server";

// Internal (Scopegen-only) detail for one store: totals, converted sales,
// a per-product breakdown, and its most recent negotiations. Access is
// enforced here in the loader, not by the nav link being hidden.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  requireInternalShop(session.shop);

  const detail = await getStoreDetail(params.shopId ?? "");
  if (!detail) {
    throw new Response("Not found", { status: 404 });
  }
  return detail;
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

// What became of the draft order behind an accepted negotiation.
const CONVERSION_LABEL: Record<
  string,
  { text: string; tone: "info" | "success" | "critical" | "neutral" }
> = {
  converted: { text: "converted", tone: "success" },
  completed_untagged: { text: "completed, no tag", tone: "neutral" },
  open: { text: "open", tone: "info" },
  invoice_sent: { text: "invoice sent", tone: "info" },
  not_found: { text: "not found", tone: "neutral" },
  other: { text: "other", tone: "neutral" },
};

const money = (n: number | null) => (n === null ? "-" : n.toFixed(2));
const percent = (n: number | null) => (n === null ? "-" : `${n.toFixed(1)}%`);

export default function InternalStoreDetail() {
  const {
    shop,
    currency,
    totals,
    products,
    sessions,
    productNamesError,
    conversion,
    sales,
    conversionError,
  } = useLoaderData<typeof loader>();

  const acceptRate =
    totals.total > 0 ? (totals.accepted / totals.total) * 100 : null;
  const conversionRate =
    conversion.checked > 0
      ? (conversion.converted / conversion.checked) * 100
      : null;
  const cur = currency ? ` ${currency}` : "";

  const salesRows = [
    { label: "Last 24 hours", window: sales.last24h },
    { label: "Last 2 days (48 hours)", window: sales.last2d },
    { label: "Last 7 days", window: sales.last7d },
    { label: "Last 30 days", window: sales.last30d },
    { label: "This month (since the 1st, UTC)", window: sales.thisMonth },
  ];

  return (
    <s-page heading={shop.shopDomain}>
      <s-section>
        <s-link href="/app/internal">Back to all stores</s-link>
      </s-section>

      {productNamesError && (
        <s-banner tone="warning" heading="Product names unavailable">
          <s-paragraph>
            Showing Shopify product ids instead of names: {productNamesError}
          </s-paragraph>
        </s-banner>
      )}

      {conversionError && (
        <s-banner tone="warning" heading="Conversion check incomplete">
          <s-paragraph>
            Could not read every draft order from Shopify, so the converted and
            sales figures below may be too low: {conversionError}
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Summary">
        <s-paragraph>
          Installed {new Date(shop.installedAt).toLocaleDateString()}
          {shop.uninstalledAt
            ? `, uninstalled ${new Date(shop.uninstalledAt).toLocaleDateString()}`
            : ""}
          .
        </s-paragraph>
        <s-paragraph>
          {totals.total} negotiation{totals.total === 1 ? "" : "s"}:{" "}
          {totals.accepted} accepted, {totals.declined} declined,{" "}
          {totals.active} active, {totals.expired} expired. Accept rate{" "}
          {percent(acceptRate)}.
        </s-paragraph>
        <s-paragraph>
          Average discount on accepted deals:{" "}
          {percent(totals.avgDiscountPercent)}.
          {currency ? ` Prices are in ${currency}.` : ""}
        </s-paragraph>
        <s-paragraph>
          Converted to orders: {conversion.converted} of {conversion.checked}{" "}
          accepted ({percent(conversionRate)}), worth{" "}
          {money(conversion.convertedValue)}
          {cur}.
          {conversion.checked < conversion.acceptedTotal
            ? ` Checked the latest ${conversion.checked} of ${conversion.acceptedTotal} accepted negotiations.`
            : ""}
        </s-paragraph>
        <s-paragraph>
          What became of the accepted deals: {conversion.converted} completed
          with the Noodle tag (counted as converted), {conversion.completedUntagged}{" "}
          completed without the tag (older drafts, not counted),{" "}
          {conversion.open} open, {conversion.invoiceSent} invoice sent,{" "}
          {conversion.notFound} not found (deleted or unreadable)
          {conversion.other > 0 ? `, ${conversion.other} other` : ""}.
        </s-paragraph>
      </s-section>

      <s-section heading="Sales from converted orders">
        <s-table variant="auto" paginate={false}>
          <s-table-header-row>
            <s-table-header>Period</s-table-header>
            <s-table-header format="numeric">Orders</s-table-header>
            <s-table-header format="numeric">Sales{cur ? ` (${currency})` : ""}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {salesRows.map((row) => (
              <s-table-row key={row.label}>
                <s-table-cell>{row.label}</s-table-cell>
                <s-table-cell>{row.window.orders}</s-table-cell>
                <s-table-cell>{money(row.window.value)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-paragraph>
          Sales are the accepted price of each converted order, one unit each,
          excluding tax and shipping. Each order is dated by when it was
          completed, not when the negotiation started.
        </s-paragraph>
      </s-section>

      <s-section heading="By product">
        {products.length === 0 ? (
          <s-paragraph>No negotiations on this store yet.</s-paragraph>
        ) : (
          <s-table variant="auto" paginate={false}>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header format="numeric">Negotiations</s-table-header>
              <s-table-header format="numeric">Accepted</s-table-header>
              <s-table-header format="numeric">Converted</s-table-header>
              <s-table-header format="numeric">Declined</s-table-header>
              <s-table-header format="numeric">Active</s-table-header>
              <s-table-header format="numeric">Expired</s-table-header>
              <s-table-header format="numeric">Avg starting price</s-table-header>
              <s-table-header format="numeric">Avg accepted price</s-table-header>
              <s-table-header format="numeric">Avg discount</s-table-header>
              <s-table-header format="numeric">Converted sales</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((p) => (
                <s-table-row key={p.productId}>
                  <s-table-cell>{p.title}</s-table-cell>
                  <s-table-cell>{p.total}</s-table-cell>
                  <s-table-cell>{p.accepted}</s-table-cell>
                  <s-table-cell>{p.converted}</s-table-cell>
                  <s-table-cell>{p.declined}</s-table-cell>
                  <s-table-cell>{p.active}</s-table-cell>
                  <s-table-cell>{p.expired}</s-table-cell>
                  <s-table-cell>{money(p.avgStartingPrice)}</s-table-cell>
                  <s-table-cell>{money(p.avgAcceptedPrice)}</s-table-cell>
                  <s-table-cell>{percent(p.avgDiscountPercent)}</s-table-cell>
                  <s-table-cell>{money(p.convertedValue)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section
        heading={`Latest negotiations (${sessions.length} of ${totals.total})`}
      >
        {sessions.length === 0 ? (
          <s-paragraph>No negotiations yet.</s-paragraph>
        ) : (
          <s-table variant="auto" paginate={false}>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Segment</s-table-header>
              <s-table-header format="numeric">Rounds</s-table-header>
              <s-table-header format="numeric">Starting price</s-table-header>
              <s-table-header format="numeric">Final price</s-table-header>
              <s-table-header format="numeric">Discount</s-table-header>
              <s-table-header>Started</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sessions.map((s) => {
                const conv = s.conversion
                  ? CONVERSION_LABEL[s.conversion]
                  : null;
                return (
                  <s-table-row key={s.id}>
                    <s-table-cell>{s.productTitle}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[s.status] ?? "neutral"}>
                        {s.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {conv ? (
                        <s-badge tone={conv.tone}>{conv.text}</s-badge>
                      ) : (
                        "-"
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {s.segment
                        ? s.segment.replace(/_/g, " ").toLowerCase()
                        : "-"}
                    </s-table-cell>
                    <s-table-cell>{s.rounds}</s-table-cell>
                    <s-table-cell>{money(s.startingPrice)}</s-table-cell>
                    <s-table-cell>{money(s.finalPrice)}</s-table-cell>
                    <s-table-cell>{percent(s.discountPercent)}</s-table-cell>
                    <s-table-cell>
                      {new Date(s.createdAt).toLocaleString()}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
