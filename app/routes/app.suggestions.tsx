import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";

// Same structural stand-in used by app.rules.$ruleId.tsx for s-switch's
// change event - see that file's comment for why.
type SwitchChangeEvent = { currentTarget: { checked: boolean } };

type CollectionRef = { id: string; title: string };

// Generous cap on how many collections can be ignored - well beyond any
// real use, just keeps a hand-crafted request from storing an endless list.
const MAX_IGNORED_COLLECTIONS = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  // Only ids are stored - titles are looked up live, same as the Rules
  // page's product lists, so a renamed collection shows its current name.
  // One deleted since it was picked comes back null and is dropped from the
  // list here (it's harmless in the stored list: nothing can match it).
  let ignoredCollections: CollectionRef[] = [];
  const ids = shop.suggestionsIgnoredCollectionIds;
  if (ids.length > 0) {
    const response = await admin.graphql(
      `#graphql
      query IgnoredCollectionTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on Collection {
            title
          }
        }
      }`,
      { variables: { ids } },
    );
    const json = (await response.json()) as {
      data?: { nodes: ({ id: string; title?: string } | null)[] };
    };
    ignoredCollections = (json.data?.nodes ?? [])
      .filter(
        (n): n is CollectionRef => n !== null && typeof n.title === "string",
      )
      .map((n) => ({ id: n.id, title: n.title }));
  }

  return { suggestionsEnabled: shop.suggestionsEnabled, ignoredCollections };
};

// Two independent settings, each saved the moment it changes: the master
// toggle (turns on Automatic mode, the only mode built - manual
// per-product/collection/universal rules are a later phase, see the schema
// comment on Shop.suggestionsEnabled), and the collections the collection
// fallback should ignore.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "ignoredCollections") {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(String(formData.get("collectionIds") ?? "[]"));
    } catch {
      parsed = [];
    }
    const collectionIds = Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (id): id is string =>
                typeof id === "string" &&
                id.startsWith("gid://shopify/Collection/"),
            ),
          ),
        ].slice(0, MAX_IGNORED_COLLECTIONS)
      : [];
    await prisma.shop.update({
      where: { id: shop.id },
      data: { suggestionsIgnoredCollectionIds: collectionIds },
    });
  } else {
    const suggestionsEnabled =
      String(formData.get("suggestionsEnabled") ?? "") === "true";
    await prisma.shop.update({
      where: { id: shop.id },
      data: { suggestionsEnabled },
    });
  }

  return redirect("/app/suggestions");
};

export default function Suggestions() {
  const { suggestionsEnabled, ignoredCollections } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const busy = navigation.state === "submitting";

  function handleToggle(e: SwitchChangeEvent) {
    const formData = new FormData();
    formData.set("intent", "toggle");
    formData.set("suggestionsEnabled", String(e.currentTarget.checked));
    submit(formData, { method: "post" });
  }

  function saveIgnoredCollections(ids: string[]) {
    const formData = new FormData();
    formData.set("intent", "ignoredCollections");
    formData.set("collectionIds", JSON.stringify(ids));
    submit(formData, { method: "post" });
  }

  async function pickIgnoredCollections() {
    const result = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      // Pre-selects what's already ignored, so adding one more doesn't mean
      // re-picking everything from scratch.
      selectionIds: ignoredCollections.map((c) => ({ id: c.id })),
    });
    if (!result) return;
    saveIgnoredCollections(result.map((c) => c.id));
  }

  function removeIgnoredCollection(id: string) {
    saveIgnoredCollections(
      ignoredCollections.filter((c) => c.id !== id).map((c) => c.id),
    );
  }

  return (
    <s-page heading="Product suggestions">
      <s-section heading="Automatic suggestions">
        <s-stack direction="block" gap="base">
          <s-switch
            label="Suggest other products when a shopper won't budge"
            details="When a shopper won't go above your lowest price, or says no to your final offer, the chat shows a few other products priced near what they offered: products of the same type first, otherwise products from the same collections. Shown at most once per conversation."
            checked={suggestionsEnabled || undefined}
            disabled={busy || undefined}
            onChange={handleToggle}
          />
          <s-paragraph tone="neutral">
            Manual, rule-based suggestions (picking exactly which products to
            recommend, per product or collection) are coming in a later
            update. For now this turns on live, automatic matching only.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Collections to ignore">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            When nothing of the same product type fits, suggestions come from
            the products that share the most collections with the one being
            negotiated. Ignore collections that describe how you sell a
            product rather than what it is, such as Bestsellers, Sale or Ready
            to ship. Collections that contain nearly every product in your
            store are already skipped automatically.
          </s-paragraph>
          <s-button
            onClick={pickIgnoredCollections}
            disabled={busy || undefined}
          >
            {ignoredCollections.length > 0
              ? "Change collections"
              : "Choose collections"}
          </s-button>
          {ignoredCollections.length > 0 && (
            <s-stack direction="block" gap="small">
              {ignoredCollections.map((c) => (
                <s-stack
                  key={c.id}
                  direction="inline"
                  gap="small"
                  alignItems="center"
                >
                  <s-paragraph>{c.title}</s-paragraph>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    disabled={busy || undefined}
                    onClick={() => removeIgnoredCollection(c.id)}
                  >
                    Remove
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
