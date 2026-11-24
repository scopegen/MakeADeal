import type { SuggestedProduct } from "./product-suggestions.server";

// Prices in the currency the shopper is looking at.
//
// Some stores show prices converted into the shopper's own currency - with
// Shopify's own currency settings, or a currency converter app such as Beast
// Currency Converter - while every order is still charged in the store's
// currency. The widget reads which currency the page is showing and the rate
// the page itself converts with (see storefront-widget/display-currency.ts),
// and sends both with every message as displayCurrency/displayRate.
//
// The negotiation itself stays entirely in the store's currency: the
// shopper's typed offer is converted in, the bot's prices are converted out
// only for the text they read, and the draft order (so checkout) is in the
// store's currency, unchanged.
//
// The rate comes from the shopper's browser, so it can be tampered with. That
// only changes what that one shopper reads and how their own typed number is
// read: every decision (floor, counters, accepting) is made in the store's
// currency against the merchant's own limits, so a fake rate can't get anyone
// a lower price than the rules allow.
export type PriceDisplay = {
  // The currency prices are shown in, or null when it's the store's own.
  currencyCode: string | null;
  // A store-currency price as written in a chat message.
  formatPrice: (shopAmount: number) => string;
  // A store-currency price as a number in the shopper's currency.
  toDisplay: (shopAmount: number) => number;
  // An amount the shopper typed, in the currency they're looking at, in the
  // store's currency.
  toShop: (displayAmount: number) => number;
};

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// The store's own currency: prices written as the plain number ("1700.00"),
// exactly as before this existed.
const STORE_CURRENCY: PriceDisplay = {
  currencyCode: null,
  formatPrice: (shopAmount) => shopAmount.toFixed(2),
  toDisplay: (shopAmount) => shopAmount,
  toShop: (displayAmount) => displayAmount,
};

// ISO currencies only - leaves out things a converter app may offer that
// aren't real currencies (Beast offers BTC).
const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export function getPriceDisplay(
  formData: FormData,
  shopCurrencyCode: string,
): PriceDisplay {
  const code = String(formData.get("displayCurrency") ?? "")
    .trim()
    .toUpperCase();
  const rate = Number(formData.get("displayRate"));
  if (
    !code ||
    code === shopCurrencyCode ||
    !KNOWN_CURRENCIES.has(code) ||
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    return STORE_CURRENCY;
  }

  // With the currency's symbol ("$332.30", "£254.97", "CA$463.10"), since
  // the amount alone wouldn't say which currency it is. English, like the
  // rest of the bot's copy.
  const formatter = new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
  });
  const displayDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return {
    currencyCode: code,
    formatPrice: (shopAmount) => formatter.format(shopAmount * rate),
    toDisplay: (shopAmount) => round(shopAmount * rate, displayDigits),
    // Two decimals, like every other store-currency price here (the draft
    // order's price is sent with two).
    toShop: (displayAmount) => round(displayAmount / rate, 2),
  };
}

// The price Shopify gives a variant in the shopper's market (contextual
// pricing - a market can be priced differently, e.g. +50% for the US), as an
// amount in the store's currency, which is what the whole negotiation runs
// in. null when there's no market price to use, and the caller keeps the
// variant's own price.
//
// - Market priced in the store's currency (a store without Shopify Payments,
//   like one charging rupees everywhere): used as is.
// - Market priced in its own currency (Shopify's multi-currency): converted
//   back at the rate the page itself shows prices with, so the starting
//   price the shopper sees in the chat is the one on the product page. Only
//   when the page is showing that same currency - otherwise there's no rate
//   to convert with.
export function marketPriceInStoreCurrency(
  marketPrice: { amount: string; currencyCode: string } | null | undefined,
  storeCurrencyCode: string,
  display: PriceDisplay,
): number | null {
  if (!marketPrice) return null;
  const amount = Number(marketPrice.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (marketPrice.currencyCode === storeCurrencyCode) return amount;
  if (marketPrice.currencyCode === display.currencyCode) {
    return display.toShop(amount);
  }
  return null;
}

// Suggestion cards, priced in the currency the shopper is looking at.
export function showSuggestedProducts(
  products: SuggestedProduct[],
  display: PriceDisplay,
): SuggestedProduct[] {
  if (!display.currencyCode) return products;
  const currencyCode = display.currencyCode;
  return products.map((product) => ({
    ...product,
    price: display.toDisplay(product.price),
    currencyCode,
  }));
}
