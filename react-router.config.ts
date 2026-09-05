import type { Config } from "@react-router/dev/config";

export default {
  // React Router 7's built-in action CSRF check rejects any action POST
  // whose Origin header doesn't match the request URL's own origin, unless
  // that origin is explicitly allowlisted here.
  //
  // In local dev, the Shopify CLI's Cloudflare tunnel gets a brand-new
  // random subdomain every session, and the Shopify-embedded admin iframe's
  // action submissions don't reliably carry a same-origin header - so the
  // default (deny-all-mismatches) check rejects legitimate requests from
  // the merchant's own admin with a generic "Bad Request". A dev-only tunnel
  // only the developer can reach isn't a meaningful CSRF surface, so it's
  // safe to relax here specifically.
  //
  // In production this app DOES run on one stable, known domain
  // (noodle.scopegen.in) - but same-origin still doesn't pass "for free":
  // this server sits behind an nginx reverse proxy that terminates HTTPS
  // and forwards to Node over plain HTTP internally. Express's default
  // (trust proxy disabled, and @react-router/serve's CLI never enables it)
  // means the app computes its own request URL as http://, not https://,
  // while the browser's real Origin header is correctly https:// - so the
  // check's own origin-vs-origin comparison fails on protocol alone, not
  // because of an actual cross-origin request. Confirmed directly: this is
  // what was causing every "Create rule"/"Save" submission to fail with a
  // generic 400 "Bad Request" once the app was actually reachable in
  // production. Explicitly trusting this app's own real domain (not a
  // wildcard - only the domain this app actually deploys to) is the
  // correct fix, not loosening it further than that.
  allowedActionOrigins:
    process.env.NODE_ENV === "development"
      ? ["null", "*", "**"]
      : ["noodle.scopegen.in"],
} satisfies Config;
