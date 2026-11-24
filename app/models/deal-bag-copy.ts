// Multi-product deals: the extra discount tiers and the two messages about
// them. Plain functions with no server imports, so the admin page can show a
// live preview with exactly what the chat will say (see app.multi-deals.tsx)
// - deal-bag.server.ts uses the same functions for the real thing.

// The most deals one bag (one checkout) can hold. Far above what a shopper
// realistically negotiates in 48 hours - it just keeps a draft order from
// growing without limit.
export const MAX_DEAL_ITEMS = 10;

// What each entry of Shop.multiDealDiscounts is for: the first entry is 2
// products, ..., the last is 5 OR MORE.
export const DISCOUNT_TIER_COUNTS = [2, 3, 4, 5] as const;

// The most a tier may give, as a sanity limit on what the admin page saves.
export const MAX_EXTRA_DISCOUNT_PERCENT = 50;

export type DealSettings = {
  multiDealDiscounts: number[];
  multiDealSavedMessage: string | null;
  multiDealNextMessage: string | null;
};

// The extra % off the whole order for a bag with `count` deals: the best
// tier the count has reached. A merchant can leave a tier empty (0) - with
// only "3 products: 8%" set, two products get nothing and four still get 8%.
export function extraDiscountFor(discounts: number[], count: number): number {
  let best = 0;
  DISCOUNT_TIER_COUNTS.forEach((tierCount, i) => {
    const percent = discounts[i] ?? 0;
    if (count >= tierCount && percent > best) best = percent;
  });
  return best;
}

// The next bigger discount the shopper can still unlock, and how many more
// deals it takes. null when there's nothing bigger (no discounts at all, or
// the top tier is already reached).
export function nextDiscountFor(
  discounts: number[],
  count: number,
): { more: number; percent: number } | null {
  const current = extraDiscountFor(discounts, count);
  const lastTier = DISCOUNT_TIER_COUNTS[DISCOUNT_TIER_COUNTS.length - 1];
  for (let n = count + 1; n <= Math.min(lastTier, MAX_DEAL_ITEMS); n++) {
    const percent = extraDiscountFor(discounts, n);
    if (percent > current) return { more: n - count, percent };
  }
  return null;
}

export function formatPercent(percent: number): string {
  // 5 -> "5%", 7.5 -> "7.5%", never "7.50%".
  return `${Math.round(percent * 100) / 100}%`;
}

// "2 products: 5% off, 3 products: 8% off, 5 or more products: 10% off" -
// only the tiers the merchant actually set. Empty when there are none.
export function describeTiers(discounts: number[]): string {
  return DISCOUNT_TIER_COUNTS.flatMap((tierCount, i) => {
    const percent = discounts[i] ?? 0;
    if (percent <= 0) return [];
    const isLast = i === DISCOUNT_TIER_COUNTS.length - 1;
    return [
      `${tierCount}${isLast ? " or more" : ""} products: ${formatPercent(percent)} off`,
    ];
  }).join(", ");
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

// The two moments a multi-product message is shown:
// - "saved": right after a deal is added to the bag (count = deals now in it).
// - "next": on another product's page, when the shopper already has deals
//   saved (count = deals saved so far).
export type DealMessageKind = "saved" | "next";

// The placeholders a merchant can use in their own wording. Shown on the
// admin page, so keep the descriptions in plain words.
export const DEAL_PLACEHOLDERS = [
  { token: "{{deal_count}}", meaning: 'how many deals are saved, e.g. "2 deals"' },
  {
    token: "{{current_discount}}",
    meaning: 'the extra discount they have now, e.g. "5%"',
  },
  {
    token: "{{next_discount}}",
    meaning: 'the next extra discount they can unlock, e.g. "8%"',
  },
  {
    token: "{{more_products}}",
    meaning: 'how many more products unlock it, e.g. "1 more product"',
  },
  { token: "{{discount_tiers}}", meaning: "all your extra discounts, listed" },
] as const;

// Noodle's own wording for each situation - also what's used when the
// merchant's wording needs a value that doesn't exist right now (see
// dealMessage).
function defaultTemplate(
  kind: DealMessageKind,
  count: number,
  current: number,
  next: { more: number; percent: number } | null,
): string {
  if (kind === "saved") {
    if (next && current === 0) {
      return count === 1
        ? "Deal saved! Negotiate {{more_products}} and get an extra {{next_discount}} off your whole order ({{discount_tiers}})."
        : "Deal saved! Negotiate {{more_products}} and get an extra {{next_discount}} off your whole order.";
    }
    if (next) {
      return "Deal saved! You now get an extra {{current_discount}} off your whole order. Negotiate {{more_products}} to get {{next_discount}} off.";
    }
    if (current > 0) {
      return "Deal saved! You get an extra {{current_discount}} off your whole order. Check out whenever you're ready, or keep adding deals.";
    }
    return "Deal saved! Check out now, or keep browsing and negotiate on more products. They'll all go into one checkout.";
  }

  if (next && current === 0) {
    return next.more === 1
      ? "You have {{deal_count}} saved. Negotiate this one too and get an extra {{next_discount}} off your whole order."
      : "You have {{deal_count}} saved. Negotiate {{more_products}} and get an extra {{next_discount}} off your whole order.";
  }
  if (next) {
    return next.more === 1
      ? "You have {{deal_count}} saved with an extra {{current_discount}} off. Negotiate this one too and get {{next_discount}} off everything."
      : "You have {{deal_count}} saved with an extra {{current_discount}} off. Negotiate {{more_products}} to get {{next_discount}} off everything.";
  }
  if (current > 0) {
    return "You have {{deal_count}} saved with an extra {{current_discount}} off your whole order. Negotiate this one too and it joins the same checkout.";
  }
  return "You have {{deal_count}} saved. Want to negotiate this one too? It'll join the same checkout.";
}

// The message for `kind` with `count` deals in the bag: the merchant's own
// wording if they set one, otherwise Noodle's default for the situation.
// A merchant's wording that uses a placeholder with no value right now
// ({{next_discount}} once the top tier is reached, {{current_discount}}
// before any discount applies, {{discount_tiers}} with no tiers) falls back
// to the default for this situation, so a shopper never reads a sentence
// with a hole in it.
export function dealMessage(
  kind: DealMessageKind,
  settings: DealSettings,
  count: number,
): string {
  const discounts = settings.multiDealDiscounts;
  const current = extraDiscountFor(discounts, count);
  const next = nextDiscountFor(discounts, count);
  const tiers = describeTiers(discounts);

  const values: Record<string, string | null> = {
    deal_count: plural(count, "deal", "deals"),
    current_discount: current > 0 ? formatPercent(current) : null,
    next_discount: next ? formatPercent(next.percent) : null,
    more_products: next ? plural(next.more, "more product", "more products") : null,
    discount_tiers: tiers || null,
  };

  const own = (
    kind === "saved" ? settings.multiDealSavedMessage : settings.multiDealNextMessage
  )?.trim();
  const usable =
    own &&
    [...own.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].every(
      ([, name]) => !(name in values) || values[name] !== null,
    );
  const template = usable ? own : defaultTemplate(kind, count, current, next);

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in values ? (values[name] ?? "") : match,
  );
}
