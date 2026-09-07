import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

// Unauthenticated landing page - only ever reached if someone visits the
// bare app domain directly with no ?shop= param, since a real install
// always arrives via Shopify's own install/App Store link instead. No
// manual shop-domain entry form here on purpose: asking a merchant to type
// their myshopify.com domain into a form on this page - rather than
// installing only through a Shopify-owned surface - is exactly what
// requirement 2.3.1 (App Store review) prohibits. The original template
// this app was scaffolded from had exactly that form; this replaces it.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Negotiator by Scopegen</h1>
        <p className={styles.text}>
          Let customers negotiate prices in a live chat widget on your
          storefront, within limits you set.
        </p>
        <p className={styles.text}>
          Install this app from the Shopify App Store on the store you want
          to add it to.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Live negotiation.</strong> Customers make offers, and the
            bot responds with fair counter-offers automatically.
          </li>
          <li>
            <strong>Your own limits.</strong> Set a maximum discount per
            product, collection, or your whole store.
          </li>
          <li>
            <strong>Instant checkout.</strong> An accepted price creates a
            ready-to-pay order right away.
          </li>
        </ul>
      </div>
    </div>
  );
}
