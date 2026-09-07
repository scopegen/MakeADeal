import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { hasActiveSubscription } from "../models/partner-billing.server";

// Gates every page under /app behind an active Shopify App Pricing
// subscription - there's no free plan, so a merchant with no subscription
// (including one whose trial or payment has lapsed) sees a plain
// "subscription required" page instead of Rules/negotiation data. Shopify
// does NOT enforce this on its own - a merchant completes OAuth and lands
// here regardless of subscription state, so without this check the app
// would be fully usable for free forever.
//
// Deliberately NOT an automatic redirect to the pricing page (that was the
// original approach - see git history) - a merchant who declines/cancels
// there gets sent back into the app, and an unconditional redirect would
// just bounce them straight back to pricing again with no explanation at
// all, a loop. App Store review requirement 1.2.2 asks for graceful
// decline handling; showing a real page with an explicit button the
// merchant clicks when they're ready is that graceful handling - landing
// on this same page again after declining isn't a bug, it's correct.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const shopResponse = await admin.graphql(`#graphql
    query CurrentShopId {
      shop {
        id
      }
    }`);
  const shopJson = (await shopResponse.json()) as {
    data: { shop: { id: string } };
  };

  const subscribed = await hasActiveSubscription(shopJson.data.shop.id);
  const cleanShop = session.shop.replace(".myshopify.com", "");

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    subscribed,
    pricingUrl: `https://admin.shopify.com/store/${cleanShop}/charges/noodle-negotiator/pricing_plans`,
  };
};

export default function App() {
  const { apiKey, subscribed, pricingUrl } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {subscribed ? (
        <>
          <s-app-nav>
            <s-link href="/app">Negotiations</s-link>
            <s-link href="/app/rules">Rules</s-link>
          </s-app-nav>
          <Outlet />
        </>
      ) : (
        <s-page heading="Subscription required">
          <s-section>
            <s-stack direction="block" gap="base" alignItems="center">
              <s-paragraph>
                An active plan is required to use this app.
              </s-paragraph>
              {/* target="_parent" navigates the Admin page itself out of
                  this app's iframe, matching how authenticate.admin's own
                  redirect helper handles admin.shopify.com links for
                  AppStore-distributed apps - not a new tab. */}
              <s-button href={pricingUrl} target="_parent" variant="primary">
                View plans
              </s-button>
            </s-stack>
          </s-section>
        </s-page>
      )}
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
