import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  isInternalShop,
  requireInternalShop,
} from "../models/internal-access.server";
import { getStoreOverview } from "../models/internal-stats.server";

// Internal (Scopegen-only) overview: one row per store with how many
// negotiations it has had. Every merchant's data is on this page, so the
// loader itself enforces access, the nav link being hidden is not enough.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  requireInternalShop(session.shop);

  const stores = await getStoreOverview();
  return {
    stores: stores.map((s) => ({
      ...s,
      isInternal: isInternalShop(s.shopDomain),
      acceptRate: s.total > 0 ? (s.accepted / s.total) * 100 : null,
    })),
  };
};

export default function InternalStores() {
  const { stores } = useLoaderData<typeof loader>();
  const totalNegotiations = stores.reduce((sum, s) => sum + s.total, 0);

  return (
    <s-page heading="Internal: stores">
      <s-section>
        <s-paragraph>
          {stores.length} store{stores.length === 1 ? "" : "s"},{" "}
          {totalNegotiations} negotiation{totalNegotiations === 1 ? "" : "s"}{" "}
          in total. Counts come from live records, so they will only cover the
          last 30 days once the retention purge exists.
        </s-paragraph>

        {stores.length === 0 ? (
          <s-paragraph>No stores have installed the app yet.</s-paragraph>
        ) : (
          <s-table variant="auto" paginate={false}>
            <s-table-header-row>
              <s-table-header>Store</s-table-header>
              <s-table-header>Installed</s-table-header>
              <s-table-header format="numeric">Negotiations</s-table-header>
              <s-table-header format="numeric">Accepted</s-table-header>
              <s-table-header format="numeric">Declined</s-table-header>
              <s-table-header format="numeric">Active</s-table-header>
              <s-table-header format="numeric">Expired</s-table-header>
              <s-table-header format="numeric">Accept rate</s-table-header>
              <s-table-header>Last negotiation</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {stores.map((s) => (
                <s-table-row key={s.shopId}>
                  <s-table-cell>
                    {s.shopName ?? s.shopDomain}{" "}
                    {s.isInternal && <s-badge tone="info">yours</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    {s.uninstalledAt ? (
                      <s-badge tone="neutral">uninstalled</s-badge>
                    ) : (
                      new Date(s.installedAt).toLocaleDateString()
                    )}
                  </s-table-cell>
                  <s-table-cell>{s.total}</s-table-cell>
                  <s-table-cell>{s.accepted}</s-table-cell>
                  <s-table-cell>{s.declined}</s-table-cell>
                  <s-table-cell>{s.active}</s-table-cell>
                  <s-table-cell>{s.expired}</s-table-cell>
                  <s-table-cell>
                    {s.acceptRate === null ? "-" : `${s.acceptRate.toFixed(1)}%`}
                  </s-table-cell>
                  <s-table-cell>
                    {s.lastNegotiationAt
                      ? new Date(s.lastNegotiationAt).toLocaleString()
                      : "-"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/internal/${s.shopId}`}>View</s-link>
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
