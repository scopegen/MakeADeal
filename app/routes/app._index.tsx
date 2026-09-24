import type { Prisma } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  NEGOTIATIONS_PAGE_SIZE,
  getPageWindow,
} from "../models/pagination";
import {
  getAllowedWindow,
  parseDateFilter,
  dateFilterToBounds,
  resolveTimezone,
} from "../models/date-range";
import { summarizeConversions } from "../models/draft-conversion";
import { lookupDraftOrderStates } from "../models/draft-order-lookup.server";

// How many of the most recent accepted negotiations (within whatever date
// filter is active) to check against Shopify for conversion. Bounds the
// number of API calls (100 ids per call) so a busy store filtered to a busy
// range doesn't make this page noticeably slow to load. Older accepted deals
// beyond this cap are simply left out of the Converted / Conversion rate
// tiles - same cap and same reasoning as the internal stats page.
const CONVERSION_LOOKUP_LIMIT = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  const searchParams = new URL(request.url).searchParams;

  // "Today" needs to mean today in THIS store's own time, not the server's.
  // Read live from Shopify rather than mirrored into our own database, same
  // "don't mirror, look it up" reasoning as the product-title lookup below -
  // a merchant's own timezone setting can change, and this way it's never
  // stale. resolveTimezone falls back to UTC only if Shopify ever somehow
  // returns something that isn't a real IANA name.
  const shopInfoResponse = await admin.graphql(`#graphql
    query NegotiationsShopTimezone {
      shop {
        ianaTimezone
      }
    }`);
  const shopInfoJson = (await shopInfoResponse.json()) as {
    data?: { shop?: { ianaTimezone?: string } };
  };
  const timeZone = resolveTimezone(shopInfoJson.data?.shop?.ianaTimezone);

  // Optional ?from=&to= (YYYY-MM-DD), clamped to the last 30 days. Every
  // query below is scoped by shopId first, so this filter and everything it
  // touches only ever sees this one shop's own negotiations - never another
  // merchant's, regardless of what's in the URL.
  const dateFilter = parseDateFilter(
    searchParams.get("from"),
    searchParams.get("to"),
    timeZone,
  );
  const allowedWindow = getAllowedWindow(timeZone);
  const where: Prisma.NegotiationSessionWhereInput = {
    shopId: shop.id,
    ...(dateFilter
      ? { createdAt: dateFilterToBounds(dateFilter, timeZone) }
      : {}),
  };

  // One grouped query gives every status count at once; summing them is the
  // total, so this never has to match a separate count() query for it.
  const byStatus = await prisma.negotiationSession.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const counts = { total: 0, active: 0, accepted: 0, declined: 0, expired: 0 };
  for (const row of byStatus) {
    counts.total += row._count._all;
    if (row.status === "ACTIVE") counts.active = row._count._all;
    else if (row.status === "ACCEPTED") counts.accepted = row._count._all;
    else if (row.status === "DECLINED") counts.declined = row._count._all;
    else if (row.status === "EXPIRED") counts.expired = row._count._all;
  }

  // Converted: of the accepted negotiations in view, how many actually
  // completed into a real order in Shopify, checked live (never stored,
  // draft order status can change after the fact). Respects the same date
  // filter as everything else on this page. A failed lookup must not be
  // read as "0 converted" - convertedLookupError lets the page say so
  // honestly instead of silently showing a wrong number.
  const acceptedForConversion = await prisma.negotiationSession.findMany({
    where: { ...where, status: "ACCEPTED", draftOrderId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: CONVERSION_LOOKUP_LIMIT,
    select: { draftOrderId: true },
  });
  const draftOrderIds = acceptedForConversion.map(
    (s) => s.draftOrderId as string,
  );
  const { states: draftStates, error: convertedLookupError } =
    await lookupDraftOrderStates(admin, draftOrderIds);
  const { checked: convertedChecked, converted, rate: conversionRate } =
    summarizeConversions(draftOrderIds, draftStates, counts.accepted);

  // 50 negotiations per page, newest first, paged with ?page=2 and so on.
  // Uses counts.total (already scoped by the same where, date filter
  // included), so paging always matches whatever the tiles above say.
  const pageWindow = getPageWindow(
    counts.total,
    searchParams.get("page"),
    NEGOTIATIONS_PAGE_SIZE,
  );

  // id is only a tie-breaker, so two negotiations created in the same instant
  // can never swap places or repeat between pages.
  const sessions = await prisma.negotiationSession.findMany({
    where,
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
    total: counts.total,
    page: pageWindow.page,
    totalPages: pageWindow.totalPages,
    hasPrevious: pageWindow.hasPrevious,
    hasNext: pageWindow.hasNext,
    firstShown: sessions.length === 0 ? 0 : pageWindow.skip + 1,
    lastShown: pageWindow.skip + sessions.length,
    counts,
    converted,
    conversionRate,
    // Set only when the live Shopify check genuinely failed partway - not
    // when there was simply nothing to check (0 accepted negotiations),
    // which isn't an error at all.
    convertedLookupError:
      convertedLookupError && convertedChecked < acceptedForConversion.length
        ? convertedLookupError
        : null,
    // Echoed back so the picker and the "showing X to Y" line reflect
    // exactly what was applied (already clamped to the last 30 days),
    // not raw, unclamped query params.
    dateFilter,
    allowedWindow,
    timeZone,
  };
};

// Same event shape already used on the Rules editor's own controlled fields
// (Shopify's s-* web components don't reliably do native form submission in
// React - see the Settings page's history - so every field here is read via
// onChange into a plain value, not left to submit itself).
type FieldChangeEvent = { currentTarget: { value: string } };

const STATUS_TONE: Record<
  string,
  "info" | "success" | "critical" | "neutral"
> = {
  ACTIVE: "info",
  ACCEPTED: "success",
  DECLINED: "critical",
  EXPIRED: "neutral",
};

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <s-box padding="base" border="base" borderRadius="base" minInlineSize="112px">
      <s-stack direction="block" gap="small-200">
        <s-paragraph color="subdued">{label}</s-paragraph>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

const DATE_RANGE_POPOVER_ID = "negotiations-date-range-popover";

// Closes the popover the same native way its own trigger button opens it
// (s-popover's show/hide events line up with the browser's own Popover API,
// per its docs) - used from Apply/Cancel/preset handlers, none of which can
// use the declarative command/commandFor attributes for this themselves,
// since those buttons already navigate via onClick, and Shopify's own docs
// say a commandFor on a button REPLACES its href/navigation rather than
// running alongside it.
function closeDateRangePopover() {
  const el = document.getElementById(DATE_RANGE_POPOVER_ID) as
    | (HTMLElement & { hidePopover?: () => void })
    | null;
  el?.hidePopover?.();
}

// "2026-09-21" -> "Sep 21, 2026". Formatted in UTC deliberately: the string
// is a plain calendar-day label already resolved in the store's own
// timezone server-side, not a real instant - letting the browser reinterpret
// it in the viewer's own local timezone could silently shift it by a day.
function formatDateLabel(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function percentLabel(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}%`;
}

export default function NegotiationsLog() {
  const {
    sessions,
    page,
    totalPages,
    hasPrevious,
    hasNext,
    firstShown,
    lastShown,
    counts,
    converted,
    conversionRate,
    convertedLookupError,
    dateFilter,
    allowedWindow,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  // The calendar's own in-progress selection, staged until Apply is clicked.
  // Presets apply immediately instead (see applyPreset) and don't touch this.
  // Reset from the real applied filter each time the popover actually opens
  // (the popover's own show event, not an effect reacting to loader data -
  // setting state directly inside an effect body is exactly the render-
  // cascade pattern this project's own lint rules already reject elsewhere),
  // so opening it always starts from the current filter, never a leftover
  // half-made selection from a previous open.
  const [pendingRange, setPendingRange] = useState(
    dateFilter ? `${dateFilter.from}--${dateFilter.to}` : "",
  );
  function resetPendingRangeToCurrentFilter() {
    setPendingRange(dateFilter ? `${dateFilter.from}--${dateFilter.to}` : "");
  }

  // Carries the current date filter along on a page-turn, so paging never
  // silently drops it.
  function pageHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (dateFilter) {
      params.set("from", dateFilter.from);
      params.set("to", dateFilter.to);
    }
    params.set("page", String(targetPage));
    return `/app?${params.toString()}`;
  }

  // Only stages the selection - Shopify's docs: onChange for a range picker
  // fires "when a range is completed by selecting the end date", not on the
  // first click, so this never stages a half-made range either.
  function handleRangeChange(event: FieldChangeEvent) {
    setPendingRange(event.currentTarget.value);
  }

  function applyCustomRange() {
    const [from, to] = pendingRange.split("--");
    if (!from || !to) return;
    closeDateRangePopover();
    navigate(`/app?from=${from}&to=${to}`);
  }

  function cancelCustomRange() {
    setPendingRange(dateFilter ? `${dateFilter.from}--${dateFilter.to}` : "");
    closeDateRangePopover();
  }

  const currentRangeLabel = dateFilter
    ? dateFilter.from === dateFilter.to
      ? formatDateLabel(dateFilter.from)
      : `${formatDateLabel(dateFilter.from)} - ${formatDateLabel(dateFilter.to)}`
    : "All time";

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

        <s-section>
          <s-button commandFor={DATE_RANGE_POPOVER_ID} icon="calendar">
            {currentRangeLabel}
          </s-button>
          <s-popover
            id={DATE_RANGE_POPOVER_ID}
            onShow={resetPendingRangeToCurrentFilter}
            inlineSize="420px"
          >
            <s-box padding="base">
              <s-stack direction="block" gap="small">
                <s-paragraph color="subdued">
                  Custom range, up to the last 30 days (
                  {formatDateLabel(allowedWindow.minDate)} to{" "}
                  {formatDateLabel(allowedWindow.maxDate)}).
                </s-paragraph>
                <s-date-picker
                  type="range"
                  allow={`${allowedWindow.minDate}--${allowedWindow.maxDate}`}
                  value={pendingRange}
                  onChange={handleRangeChange}
                ></s-date-picker>
                <s-stack direction="inline" gap="small">
                  <s-button
                    variant="primary"
                    disabled={!pendingRange.includes("--") || undefined}
                    onClick={applyCustomRange}
                  >
                    Apply
                  </s-button>
                  <s-button onClick={cancelCustomRange}>Cancel</s-button>
                </s-stack>
              </s-stack>
            </s-box>
          </s-popover>
        </s-section>

        {convertedLookupError && (
          <s-banner tone="warning" heading="Converted count may be incomplete">
            <s-paragraph>
              Could not fully check order status with Shopify just now:{" "}
              {convertedLookupError}
            </s-paragraph>
          </s-banner>
        )}

        <s-stack direction="inline" gap="base">
          <Tile label="Total" value={counts.total} />
          <Tile label="Active" value={counts.active} />
          <Tile label="Accepted" value={counts.accepted} />
          <Tile label="Declined" value={counts.declined} />
          <Tile label="Expired" value={counts.expired} />
          <Tile label="Converted" value={converted} />
          <Tile label="Conversion rate" value={percentLabel(conversionRate)} />
        </s-stack>

        <s-box paddingBlock="base">
          <s-divider></s-divider>
        </s-box>

        {sessions.length === 0 ? (
          <s-stack direction="block" gap="base" alignItems="center">
            <s-paragraph>
              {dateFilter
                ? "No negotiations in this date range."
                : "No negotiations yet. Once the storefront widget is live and a visitor starts negotiating on a product with negotiation turned on, sessions will show up here."}
            </s-paragraph>
            {dateFilter ? (
              <s-link href="/app">View all time</s-link>
            ) : (
              <s-link href="/app/rules">Go to rules</s-link>
            )}
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
              Showing {firstShown} to {lastShown} of {counts.total}
            </s-paragraph>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button
                icon="chevron-left"
                accessibilityLabel="Previous page"
                href={hasPrevious ? pageHref(page - 1) : undefined}
                disabled={!hasPrevious || undefined}
              ></s-button>
              <s-button
                icon="chevron-right"
                accessibilityLabel="Next page"
                href={hasNext ? pageHref(page + 1) : undefined}
                disabled={!hasNext || undefined}
              ></s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
