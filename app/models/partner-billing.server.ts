// Checks whether a shop has an active Shopify App Pricing subscription.
//
// Deliberately NOT the Admin API's currentAppInstallation.activeSubscriptions
// (that's the SDK's billing.check(), built for the older/manual Billing API
// flow where the app itself defines BillingConfig plans and calls
// appSubscriptionCreate). Shopify App Pricing plans are created when a
// merchant approves one on Shopify's own hosted plan-selection page, not by
// this app - so the correct way to check status is the Partner API, per
// Shopify's own implementation guide:
// https://shopify.dev/docs/apps/launch/billing/redirect-plan-selection-page
//
// PARTNER_ORG_ID and APP_GID aren't secrets (same category as the client_id
// already hardcoded in shopify.app.toml) - only the access token is
// sensitive, and that's read from the environment.
const PARTNER_ORG_ID = "3574456";
const APP_GID = "gid://shopify/App/417690746881";

type ActiveSubscriptionResponse = {
  data?: {
    activeSubscription: { billingPeriod: string } | null;
  };
  errors?: unknown;
};

// shopId must be the shop's GID (gid://shopify/Shop/...), not the domain -
// callers get this from a `{ shop { id } }` Admin API query, which they
// already have a client for (no reason to duplicate that here).
export async function hasActiveSubscription(shopId: string): Promise<boolean> {
  const token = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_PARTNER_API_ACCESS_TOKEN is not set");
  }

  const response = await fetch(
    `https://partners.shopify.com/${PARTNER_ORG_ID}/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `#graphql
          query ($appId: ID!, $shopId: ID!) {
            activeSubscription(appId: $appId, shopId: $shopId) {
              billingPeriod
            }
          }`,
        variables: { appId: APP_GID, shopId },
      }),
    },
  );

  const json = (await response.json()) as ActiveSubscriptionResponse;
  if (!response.ok || json.errors) {
    throw new Error(
      `Partner API request failed: ${JSON.stringify(json.errors ?? response.status)}`,
    );
  }

  return json.data?.activeSubscription != null;
}
