import type { Config } from "@react-router/dev/config";

export default {
  // React Router 7's built-in action CSRF check rejects any action POST
  // whose Origin header doesn't match the request URL's own origin, unless
  // that origin is explicitly allowlisted here. In production this app runs
  // on one stable, known domain, so same-origin requests always pass and
  // the check should stay fully on (hence: nothing set for prod).
  //
  // In local dev, the Shopify CLI's Cloudflare tunnel gets a brand-new
  // random subdomain every session, and the Shopify-embedded admin iframe's
  // action submissions don't reliably carry a same-origin header - so the
  // default (deny-all-mismatches) check rejects legitimate requests from
  // the merchant's own admin with a generic "Bad Request". A dev-only tunnel
  // only the developer can reach isn't a meaningful CSRF surface, so it's
  // safe to relax here specifically.
  allowedActionOrigins:
    process.env.NODE_ENV === "development" ? ["null", "*", "**"] : undefined,
} satisfies Config;
