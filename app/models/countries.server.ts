import type { Shop } from "@prisma/client";

// Countries a merchant can show or hide Noodle in (see Shop.countryMode).
//
// Shopify's own CountryCode list (Admin GraphQL) - the same codes the
// widget gets from Shopify's country detection (see detectShopperCountry in
// widget.tsx). Left out: ZZ ("Unknown Region") and AN (Netherlands Antilles,
// dissolved in 2010, kept by Shopify only for old data). Territories such as
// Puerto Rico aren't missing - Shopify counts them as part of US.
export const COUNTRY_CODES = [
  "AC", "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AR", "AT", "AU",
  "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ",
  "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO",
  "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO",
  "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FO",
  "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN",
  "GP", "GQ", "GR", "GS", "GT", "GW", "GY", "HK", "HM", "HN", "HR", "HT",
  "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE",
  "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW",
  "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV",
  "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MK", "ML", "MM", "MN", "MO",
  "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC",
  "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA",
  "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PS", "PT", "PY", "QA",
  "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH",
  "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX",
  "SY", "SZ", "TA", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM",
  "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY",
  "UZ", "VA", "VC", "VE", "VG", "VN", "VU", "WF", "WS", "XK", "YE", "YT",
  "ZA", "ZM", "ZW",
];

const KNOWN_CODES = new Set(COUNTRY_CODES);

export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

// English name for the admin page. Computed on the server only and sent
// down with the page, so the browser never renders a name of its own that
// could differ from the server's and break hydration.
export function countryName(code: string): string {
  try {
    return displayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// Whether the widget shows to a shopper shopping in `country`. An empty list
// means every country, in either mode. A missing country also passes: that's
// a widget script cached from before countries existed (or a page that
// somehow rendered without one), and the value comes from the shopper's own
// browser anyway - this is a merchant's preference about where to offer
// haggling, not a security boundary, so hiding the widget when unsure would
// only cost real shoppers. A country that IS sent is matched as is, even one
// this file doesn't know: in ONLY mode it's hidden (the merchant can only
// have picked known ones), in EXCEPT mode it's shown.
export function isShownInCountry(
  shop: Pick<Shop, "countryMode" | "countryCodes">,
  country: string | null | undefined,
): boolean {
  if (shop.countryCodes.length === 0) return true;
  const code = country?.trim().toUpperCase();
  if (!code) return true;
  const listed = shop.countryCodes.includes(code);
  return shop.countryMode === "EXCEPT" ? !listed : listed;
}
