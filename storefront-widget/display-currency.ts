// The currency the page is showing prices in, when it isn't the store's own,
// and the rate the page converts with (shopper's currency per 1 unit of the
// store's). Sent with every message so the bot reads offers and writes its
// prices in that currency - see price-display.server.ts. null means the
// store's own currency, i.e. no conversion, same as before this existed.
// Checkout is in the store's currency either way.
//
// Its own file (bundled into the widget by esbuild) so it can also be loaded
// on its own and run against a real store page.
export type DisplayCurrency = { code: string; rate: number };

const RATES_TIMEOUT_MS = 2000;

// Beast Currency Converter's settings object, from its app embed on the page.
type BeastConverterSettings = {
  cookieName?: string;
  ratesUrl?: string;
  shopCurrency?: string;
};

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Looked up once per page load. Its rates object isn't reachable from other
// scripts (it's created inside the app's own code), so this fetches the same
// rates file the app itself loads - usually straight from the browser cache.
// The file is JavaScript ("var Currency = { rates: {...}, convert: ... }"),
// so the rates object is pulled out as JSON, never run. Rates are in US
// dollars per unit of each currency.
let beastRates: Promise<Record<string, number> | null> | null = null;

function loadBeastRates(ratesUrl: string) {
  if (beastRates) return beastRates;
  beastRates = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RATES_TIMEOUT_MS);
    try {
      const res = await fetch(ratesUrl, { signal: controller.signal });
      const text = await res.text();
      const match = text.match(/rates\s*:\s*(\{[^}]*\})/);
      if (!match) return null;
      const parsed: Record<string, unknown> = JSON.parse(match[1]);
      const rates: Record<string, number> = {};
      for (const [code, value] of Object.entries(parsed)) {
        const rate = Number(value);
        if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
      }
      return rates;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  return beastRates;
}

// Checked at each message, not once, so a shopper who switches currency
// mid-chat gets the new one from their next message on.
export async function detectDisplayCurrency(): Promise<DisplayCurrency | null> {
  const w = window as unknown as {
    DoublyGlobal?: BeastConverterSettings;
    Shopify?: { currency?: { active?: string; rate?: string } };
  };

  // Beast Currency Converter: the shopper's currency is in its cookie,
  // base64-encoded ("VVNE" is USD). Prices are converted on the page only;
  // Shopify itself still reports the store's currency.
  const beast = w.DoublyGlobal;
  if (beast?.cookieName && beast.ratesUrl && beast.shopCurrency) {
    let code: string | null = null;
    try {
      const raw = readCookie(beast.cookieName);
      code = raw ? atob(raw) : null;
    } catch {
      code = null;
    }
    if (code && /^[A-Z]{3}$/.test(code)) {
      if (code === beast.shopCurrency) return null;
      const rates = await loadBeastRates(beast.ratesUrl);
      const shopRate = rates?.[beast.shopCurrency];
      const shownRate = rates?.[code];
      return shopRate && shownRate
        ? { code, rate: shopRate / shownRate }
        : null;
    }
  }

  // Shopify's own currency settings: the currency the shopper is browsing in
  // and its rate from the store's currency (1.0 for the store's own).
  const active = w.Shopify?.currency?.active;
  const rate = Number(w.Shopify?.currency?.rate);
  if (
    active &&
    /^[A-Z]{3}$/.test(active) &&
    Number.isFinite(rate) &&
    rate > 0 &&
    rate !== 1
  ) {
    return { code: active, rate };
  }
  return null;
}

// Adds displayCurrency/displayRate to a request (a /start or /offer body, or
// /eligibility's query string), when the page is showing another currency.
export async function addDisplayCurrency(fd: {
  set(name: string, value: string): void;
}) {
  const display = await detectDisplayCurrency();
  if (display) {
    fd.set("displayCurrency", display.code);
    fd.set("displayRate", String(display.rate));
  }
}
