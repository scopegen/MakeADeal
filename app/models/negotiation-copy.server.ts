// Fallback reply copy for the negotiation lifecycle events NOT covered by
// the customer-segment tier system (negotiation-tiers.server.ts) - rate
// limiting, session expiry, and decline. The greeting, and every
// counter/accepted/floor message, come from that module instead, which has
// its own fixed copy pools (including a rotating set of greetings).

type TemplateSource = {
  rateLimitedTemplate?: string | null;
  expiredTemplate?: string | null;
} | null | undefined;

export function getRateLimitedMessage(settings: TemplateSource) {
  return (
    settings?.rateLimitedTemplate?.trim() ||
    "Let's pick this up again in a little while."
  );
}

export function getDeclinedMessage() {
  return "No problem — maybe another time.";
}

export function getExpiredMessage(settings: TemplateSource) {
  return (
    settings?.expiredTemplate?.trim() ||
    "This offer has expired. Feel free to start a new one."
  );
}
