import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import { resolveEffectiveLimits } from "../models/negotiation-engine.server";
import { getGreetingLines } from "../models/negotiation-tiers.server";
import { isShownInCountry } from "../models/countries.server";
import { loadBagForPage, shopperFrom } from "../models/deal-bag.server";

// Storefront-facing: GET https://{shop}/apps/negotiate/eligibility?productId=...&variantId=...&country=...
// (plus anonymousId and displayCurrency/displayRate, for multi-product deals'
// saved-deals list - see deal-bag.server.ts)
// Cheap read-only check so the widget only renders its button on products
// that are actually negotiable, without creating a NegotiationSession just
// from a page view. variantId is optional - whichever variant was selected
// when the page loaded (see data-variant-id in negotiation-widget.liquid) -
// and falls back to the product's first variant when absent or when it
// doesn't belong to this product.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return Response.json({ eligible: false });
  }

  const shop = await getShopByDomain(session.shop);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") ?? "";
  const variantId = url.searchParams.get("variantId");
  if (!productId) {
    return Response.json({ eligible: false });
  }

  // Checked before anything that costs an Admin API call. country is where
  // the shopper is, per Shopify's detection (see detectShopperCountry in
  // widget.tsx).
  if (!isShownInCountry(shop, url.searchParams.get("country"))) {
    return Response.json({ eligible: false });
  }

  const limits = await resolveEffectiveLimits(admin, shop.id, productId);
  if (!limits) {
    return Response.json({ eligible: false });
  }

  // Multi-product deals: the shopper's saved deals, if they have any (see
  // deal-bag.server.ts). Started now so its Shopify lookup runs alongside
  // the stock check below instead of after it. A failure only means no deal
  // list on this page - never a hidden widget - so it's caught here, which
  // also covers the early returns below that never await it.
  const shopper = shopperFrom(request, url.searchParams.get("anonymousId"));
  const bagLookup =
    shop.multiDealsEnabled && (shopper.customerId || shopper.anonymousId)
      ? loadBagForPage(admin, {
          shopId: shop.id,
          settings: shop,
          shopper,
          productId,
          displayParams: url.searchParams,
        }).catch((err) => {
          console.error("[proxy.eligibility] deal bag lookup failed", err);
          return null;
        })
      : Promise.resolve(null);

  // Out-of-stock products/variants aren't negotiable - there's nothing to
  // fulfill. availableForSale already accounts for a merchant's own
  // "continue selling when out of stock" setting, so this never hides the
  // button on a product a merchant has deliberately chosen to keep selling.
  // This is only the page-load check - proxy.start.tsx re-checks the
  // actual current variant when negotiation actually starts, so a shopper
  // switching variants after this runs is never left with a stale result.
  let available: boolean | null = null;
  if (variantId) {
    const response = await admin.graphql(
      `#graphql
      query NoodleVariantAvailability($id: ID!) {
        productVariant(id: $id) {
          availableForSale
          product {
            id
          }
        }
      }`,
      { variables: { id: variantId } },
    );
    const json = (await response.json()) as {
      data?: {
        productVariant: {
          availableForSale: boolean;
          product: { id: string };
        } | null;
      };
    };
    const variant = json.data?.productVariant;
    if (variant && variant.product.id === productId) {
      available = variant.availableForSale;
    }
  }

  if (available === null) {
    const response = await admin.graphql(
      `#graphql
      query NoodleProductAvailability($id: ID!) {
        product(id: $id) {
          variants(first: 1) {
            nodes {
              availableForSale
            }
          }
        }
      }`,
      { variables: { id: productId } },
    );
    const json = (await response.json()) as {
      data?: {
        product: { variants: { nodes: { availableForSale: boolean }[] } } | null;
      };
    };
    available = json.data?.product?.variants.nodes[0]?.availableForSale ?? false;
  }

  if (!available) {
    return Response.json({ eligible: false });
  }

  const bag = await bagLookup;

  // Merchant-configurable pieces the widget actually reads - see its file
  // header comment for what's still fixed (Send/Accept/Decline text).
  // Comes from whichever rule won (see resolveEffectiveLimits's overlap
  // resolution), not a shop-wide singleton.
  return Response.json({
    // Multi-product deals: the shopper's saved deals (null when they have
    // none, or the feature is off), and the "you have N deals saved"
    // message for this page (null when this product is already one of them).
    bag: bag?.view ?? null,
    bagMessage: bag?.message ?? null,
    eligible: true,
    config: {
      headerTitle: limits.rule.headerTitle ?? null,
      launcherButtonText: limits.rule.launcherButtonText ?? null,
      primaryColor: limits.rule.primaryColor ?? null,
      // null when auto-open is off (the default). delaySeconds is 0-60,
      // validated when the rule is saved.
      autoOpen: limits.rule.autoOpenEnabled
        ? { delaySeconds: limits.rule.autoOpenDelaySeconds }
        : null,
    },
    // Opening the panel no longer creates a negotiation (that only happens
    // when the shopper sends their first message - see proxy.start.tsx), so
    // the greeting has to be available before any session exists. Picked
    // once per page load; the widget shows each entry as a chat bubble.
    // The rule's own initial/sub message if the merchant set one, otherwise
    // one of the built-in greetings.
    greeting: getGreetingLines(limits.rule),
  });
};
