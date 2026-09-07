import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { hasActiveSubscription } from "../models/partner-billing.server";

// Gates every page under /app behind an active Shopify App Pricing
// subscription - there's no free plan, so a merchant with no subscription
// (including one whose trial or payment has lapsed) gets bounced to
// Shopify's own hosted plan-selection page before seeing any Rules/
// negotiation data. Shopify does NOT enforce this on its own - a merchant
// completes OAuth and lands here regardless of subscription state, so
// without this check the app would be fully usable for free forever.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect } = await authenticate.admin(request);

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
  if (!subscribed) {
    // Shorthand for https://admin.shopify.com/store/{shop}/... - resolves
    // the shop and picks the correct cross-iframe redirect target
    // automatically (see authenticate.admin's redirect helper).
    return redirect("shopify:admin/charges/noodle-negotiator/pricing_plans");
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Negotiations</s-link>
        <s-link href="/app/rules">Rules</s-link>
      </s-app-nav>
      <Outlet />
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
