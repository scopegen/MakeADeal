import styles from "../styles/legal.module.css";

// Public, unauthenticated page - see the comment on privacy.tsx, same
// reasoning applies here. Billing section deliberately stays generic/
// flexible: no Shopify App Pricing plan exists yet (see the Rules/billing
// discussion) - this wording should still hold true once one does, since it
// defers pricing specifics to whatever's shown in-app before a charge, not
// to a fixed number hardcoded here that would go stale.
export default function Terms() {
  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1>Terms of Service</h1>
        <p className={styles.updated}>Last updated: September 7, 2026</p>

        <p>
          These Terms of Service (&quot;Terms&quot;) govern your use of
          Negotiator by Scopegen (&quot;the App&quot;), provided by Scopegen
          (&quot;we&quot;, &quot;us&quot;). By installing or using the App,
          you (&quot;you&quot;, the merchant) agree to these Terms.
        </p>

        <h2>1. What the App does</h2>
        <p>
          The App adds a price-negotiation chat widget to your Shopify
          storefront. Shoppers can make offers on eligible products, and the
          App responds with counter-offers within the discount limits you
          configure. A shopper never receives a discount beyond the maximum
          you set for that product, collection, or shop.
        </p>

        <h2>2. Your responsibilities</h2>
        <ul>
          <li>
            You&apos;re responsible for the discount rules you configure,
            including making sure they reflect prices you&apos;re actually
            willing to honor.
          </li>
          <li>
            You&apos;re responsible for complying with consumer protection,
            pricing, and advertising laws that apply to your store and its
            customers.
          </li>
          <li>
            You must not use the App to mislead shoppers about pricing or to
            facilitate fraudulent transactions.
          </li>
        </ul>

        <h2>3. Orders created through the App</h2>
        <p>
          When a shopper and the App agree on a price, the App creates a
          draft order on your store at that price. Fulfilling, cancelling, or
          modifying that order afterward is entirely up to you, the same as
          any other order in your store.
        </p>

        <h2>4. Billing</h2>
        <p>
          Any charges for the App are billed exclusively through
          Shopify&apos;s own billing system. If a paid plan applies to your
          store, the price and any trial period will be shown to you and
          require your approval before you&apos;re charged - never billed
          silently. Uninstalling the App cancels any subscription going
          forward.
        </p>

        <h2>5. No guaranteed results</h2>
        <p>
          The App is a tool to help facilitate price negotiation; we don&apos;t
          guarantee any particular sales volume, conversion rate, or
          business outcome from using it.
        </p>

        <h2>6. Availability and changes</h2>
        <p>
          We aim to keep the App available and reliable but don&apos;t
          guarantee uninterrupted service. We may update, change, or
          discontinue features of the App, including the customer-segment
          negotiation logic and copy, at any time.
        </p>

        <h2>7. Termination</h2>
        <p>
          You may uninstall the App at any time. We may suspend or terminate
          your access if you violate these Terms or use the App in a way
          that risks harm to us, Shopify, or other users.
        </p>

        <h2>8. Disclaimer and limitation of liability</h2>
        <p>
          The App is provided &quot;as is&quot;, without warranties of any
          kind, express or implied. To the maximum extent permitted by law,
          Scopegen is not liable for indirect, incidental, or consequential
          damages arising from your use of the App, including lost profits
          or lost sales.
        </p>

        <h2>9. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. Continued use of the
          App after a change means you accept the updated Terms.
        </p>

        <h2>10. Governing law</h2>
        <p>
          These Terms are governed by the laws of India, and any disputes
          arising from them are subject to the exclusive jurisdiction of the
          competent courts in India.
        </p>

        <h2>11. Contact us</h2>
        <p>
          Questions about these Terms can be sent to{" "}
          <a href="mailto:rohit@scopegen.in">rohit@scopegen.in</a>.
        </p>
      </div>
    </div>
  );
}
