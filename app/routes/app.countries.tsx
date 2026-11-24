import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  COUNTRY_CODES,
  countryName,
  isCountryCode,
} from "../models/countries.server";

// Same structural stand-in used by app.rules.$ruleId.tsx for field events -
// see that file's comment for why.
type FieldChangeEvent = { currentTarget: { value: string } };

type Country = { code: string; name: string };

type CountryMode = "ONLY" | "EXCEPT";

// How many search matches to list at once - enough to find any country by
// its first few letters without turning the page into a 248-row list.
const MAX_MATCHES = 8;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  const countries: Country[] = COUNTRY_CODES.map((code) => ({
    code,
    name: countryName(code),
  })).sort((a, b) => a.name.localeCompare(b.name, "en"));

  return {
    countries,
    mode: shop.countryMode as CountryMode,
    // In name order, like the search results.
    selectedCodes: countries
      .filter((c) => shop.countryCodes.includes(c.code))
      .map((c) => c.code),
  };
};

// Saved the moment it changes, like the Suggestions page: the mode and the
// full new list come in each time (the mode switched, one country added or
// removed, or all cleared).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const formData = await request.formData();

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(String(formData.get("countryCodes") ?? "[]"));
  } catch {
    parsed = [];
  }
  // Only codes from the known list, so nothing a hand-crafted request sends
  // can end up stored. Can't grow past the list's own length.
  const countryCodes = Array.isArray(parsed)
    ? [...new Set(parsed.filter(isCountryCode))]
    : [];
  const countryMode: CountryMode =
    formData.get("countryMode") === "EXCEPT" ? "EXCEPT" : "ONLY";

  await prisma.shop.update({
    where: { id: shop.id },
    data: { countryMode, countryCodes },
  });

  return redirect("/app/countries");
};

// Lowercase, accents stripped, so "cote" finds Côte d'Ivoire.
function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export default function Countries() {
  const { countries, mode, selectedCodes } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";
  const [query, setQuery] = useState("");
  const shopify = useAppBridge();

  // There's no Save button - every Add/Remove saves straight away - so this
  // confirms each one once it's done (submitting, then reloading the page's
  // data, then idle again).
  const savingRef = useRef(false);
  useEffect(() => {
    if (navigation.state === "submitting") {
      savingRef.current = true;
    } else if (navigation.state === "idle" && savingRef.current) {
      savingRef.current = false;
      shopify.toast.show("Countries saved");
    }
  }, [navigation.state, shopify]);

  const byCode = new Map(countries.map((c) => [c.code, c]));
  const selected = selectedCodes
    .map((code) => byCode.get(code))
    .filter((c): c is Country => c !== undefined);

  const search = normalize(query.trim());
  const matches = search
    ? countries
        .filter(
          (c) =>
            !selectedCodes.includes(c.code) &&
            (normalize(c.name).includes(search) ||
              c.code.toLowerCase() === search),
        )
        // Names that start with what was typed come first: "in" lists
        // India and Indonesia before Argentina.
        .sort(
          (a, b) =>
            Number(!normalize(a.name).startsWith(search)) -
            Number(!normalize(b.name).startsWith(search)),
        )
        .slice(0, MAX_MATCHES)
    : [];

  function save(codes: string[], newMode: CountryMode = mode) {
    const formData = new FormData();
    formData.set("countryMode", newMode);
    formData.set("countryCodes", JSON.stringify(codes));
    submit(formData, { method: "post" });
  }

  return (
    <s-page heading="Countries">
      <s-section heading="Where Noodle shows">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Choose the countries where shoppers can negotiate. Noodle uses the
            country Shopify detects the shopper is in, from their internet
            connection. Shoppers using a VPN may be detected in a different
            country. Changes save straight away.
          </s-paragraph>

          <s-select
            label="Show Noodle"
            value={mode}
            disabled={busy || undefined}
            onChange={(e: FieldChangeEvent) =>
              save(selectedCodes, e.currentTarget.value as CountryMode)
            }
          >
            <s-option value="ONLY">Only in the countries below</s-option>
            <s-option value="EXCEPT">
              In every country except the ones below
            </s-option>
          </s-select>

          {selected.length === 0 ? (
            <s-banner tone="info">
              <s-paragraph>
                No countries chosen, so Noodle shows to shoppers in every
                country.
              </s-paragraph>
            </s-banner>
          ) : (
            <s-stack direction="block" gap="small">
              <s-paragraph>
                {mode === "EXCEPT"
                  ? "Noodle is hidden from shoppers in "
                  : "Noodle only shows to shoppers in "}
                {selected.length === 1
                  ? "this country"
                  : `these ${selected.length} countries`}
                :
              </s-paragraph>
              {selected.map((c) => (
                <s-stack
                  key={c.code}
                  direction="inline"
                  gap="small"
                  alignItems="center"
                >
                  <s-paragraph>{c.name}</s-paragraph>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    disabled={busy || undefined}
                    onClick={() =>
                      save(selectedCodes.filter((code) => code !== c.code))
                    }
                  >
                    Remove
                  </s-button>
                </s-stack>
              ))}
              <s-paragraph tone="neutral">
                Removing every country shows Noodle everywhere again.
              </s-paragraph>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Add a country">
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search countries"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by country name"
            onInput={(e: FieldChangeEvent) => setQuery(e.currentTarget.value)}
          />
          {search && matches.length === 0 && (
            <s-paragraph tone="neutral">
              No other countries match &quot;{query.trim()}&quot;.
            </s-paragraph>
          )}
          {matches.length > 0 && (
            <s-stack direction="block" gap="small">
              {matches.map((c) => (
                <s-stack
                  key={c.code}
                  direction="inline"
                  gap="small"
                  alignItems="center"
                >
                  <s-paragraph>{c.name}</s-paragraph>
                  <s-button
                    variant="tertiary"
                    disabled={busy || undefined}
                    onClick={() => save([...selectedCodes, c.code])}
                  >
                    Add
                  </s-button>
                </s-stack>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
