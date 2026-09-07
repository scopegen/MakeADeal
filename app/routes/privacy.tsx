import styles from "../styles/legal.module.css";

// Public, unauthenticated page - no loader needed. Content reflects this
// app's actual data model (NegotiationSession/NegotiationOffer/Shop in
// prisma/schema.prisma) and the compliance webhooks already implemented in
// app/routes/webhooks.customers.*.tsx / webhooks.shop.redact.tsx - not
// generic boilerplate. Last-updated date below must be bumped by hand
// whenever this content changes; nothing computes it automatically.
export default function Privacy() {
  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1>Privacy Policy</h1>
        <p className={styles.updated}>Last updated: September 7, 2026</p>

        <p>
          This Privacy Policy describes how Scopegen (&quot;we&quot;,
          &quot;us&quot;) collects, uses, and protects information through
          the Negotiator by Scopegen Shopify app (&quot;the App&quot;). It
          applies to merchants who install the App and to shoppers who
          interact with the negotiation widget on a merchant&apos;s
          storefront.
        </p>

        <h2>1. Information we collect</h2>

        <h3>From merchants</h3>
        <ul>
          <li>Your shop&apos;s domain (e.g. your-store.myshopify.com).</li>
          <li>
            An access token issued by Shopify when you install the App, used
            only to make the Admin API calls the App needs on your behalf
            (reading product/collection data, creating draft orders).
          </li>
          <li>
            The negotiation rules you configure: which products or
            collections they apply to, your maximum discount percentage, and
            the bot&apos;s display name.
          </li>
        </ul>

        <h3>From shoppers, through the negotiation widget</h3>
        <ul>
          <li>
            If you&apos;re logged into the store as a customer, your Shopify
            customer ID.
          </li>
          <li>
            If you&apos;re not logged in, a randomly generated identifier
            stored in your browser - not tied to your name, email, or any
            other personal detail.
          </li>
          <li>
            The product you&apos;re negotiating on, the prices you offer, the
            counter-offers the bot makes, and the outcome (accepted,
            declined, or expired).
          </li>
          <li>
            Your IP address, used only to apply rate limits that prevent
            abuse of the negotiation feature.
          </li>
        </ul>

        <p>
          If a negotiation is accepted, the App creates a draft order on the
          merchant&apos;s store at the agreed price. From that point on, any
          order and customer information involved is handled under the
          merchant&apos;s own store policies and Shopify&apos;s own privacy
          practices, the same as any other order placed on that store.
        </p>

        <h2>2. How we use this information</h2>
        <p>We use the information above only to:</p>
        <ul>
          <li>Run the negotiation itself and calculate fair counter-offers.</li>
          <li>Create the draft order when a negotiation is accepted.</li>
          <li>Prevent abuse of the widget through rate limiting.</li>
          <li>
            Let merchants see a log of past negotiations on their own store
            within the App.
          </li>
        </ul>
        <p>
          We do not sell this information, use it for advertising, or share
          it with anyone outside Shopify and the infrastructure providers
          that host the App.
        </p>

        <h2>3. How long we keep it</h2>
        <ul>
          <li>
            Negotiation session data (offers, counter-offers, and the
            resulting outcome) is automatically deleted 30 days after the
            negotiation starts.
          </li>
          <li>
            Merchant configuration and shop data is kept for as long as the
            App is installed. If you uninstall the App, it is permanently
            deleted within 48 hours unless you reinstall in that window.
          </li>
        </ul>

        <h2>4. Your rights</h2>
        <p>
          Shoppers can ask the merchant whose store they negotiated on to
          request a copy of, or the deletion of, their negotiation data on
          their behalf - the App automatically processes these requests
          through Shopify&apos;s standard data request and redaction
          mechanism. Merchants can reach us directly using the contact
          details below for any request concerning their own shop&apos;s
          data.
        </p>

        <h2>5. Security</h2>
        <p>
          Access tokens and other credentials are stored securely and never
          exposed to shoppers or to any party other than Shopify&apos;s own
          API. All traffic to and from the App is encrypted (HTTPS), and
          every request the App receives from Shopify - including webhooks -
          is cryptographically verified before it&apos;s acted on.
        </p>

        <h2>6. Children&apos;s privacy</h2>
        <p>
          The App is intended for use by Shopify merchants and their
          shoppers in the ordinary course of e-commerce, and is not directed
          at children. We do not knowingly collect information from
          children.
        </p>

        <h2>7. Changes to this policy</h2>
        <p>
          We may update this policy from time to time. Material changes will
          be reflected by updating the date at the top of this page.
        </p>

        <h2>8. Contact us</h2>
        <p>
          Questions about this policy or a request concerning your data can
          be sent to{" "}
          <a href="mailto:rohit@scopegen.in">rohit@scopegen.in</a>.
        </p>
      </div>
    </div>
  );
}
