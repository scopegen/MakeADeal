import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";

type ProductRef = { id: string; title: string };

// Polaris web components dispatch real DOM events, but the custom-element
// JSX typings in this project don't expose a value-narrowed event type for
// React usage - this minimal structural type stands in for that (confirmed
// shape via Shopify's own docs examples: `.value` for text/select fields).
type FieldChangeEvent = { currentTarget: { value: string } };

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const isNew = params.ruleId === "new";

  const otherRules = await prisma.negotiationRule.findMany({
    where: {
      shopId: shop.id,
      ...(isNew ? {} : { id: { not: params.ruleId } }),
    },
    select: { scopeType: true },
  });
  const hasAllProductsElsewhere = otherRules.some(
    (r) => r.scopeType === "ALL_PRODUCTS",
  );
  const hasAnyOtherRule = otherRules.length > 0;

  if (isNew) {
    return {
      rule: null,
      hasAllProductsElsewhere,
      hasAnyOtherRule,
      initialProducts: [] as ProductRef[],
      initialExcludedProducts: [] as ProductRef[],
    };
  }

  const rule = await prisma.negotiationRule.findUnique({
    where: { id: params.ruleId },
  });
  if (!rule || rule.shopId !== shop.id) {
    throw new Response("Not found", { status: 404 });
  }

  // Only IDs are stored - titles are looked up live for display, same
  // reasoning as the engine's live collection-membership check: no mirrored
  // product data to go stale in our own DB. Shared by both productIds
  // (PRODUCT_GROUP's inclusion list) and excludedProductIds (ALL_PRODUCTS/
  // COLLECTION's carve-outs).
  async function resolveProductTitles(ids: string[]): Promise<ProductRef[]> {
    if (ids.length === 0) return [];
    const response = await admin.graphql(
      `#graphql
      query ProductTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on Product {
            title
          }
        }
      }`,
      { variables: { ids } },
    );
    const json = (await response.json()) as {
      data: { nodes: ({ id: string; title?: string } | null)[] };
    };
    // A product deleted since the rule was saved comes back as null (or
    // without a title field, since the inline fragment won't match) -
    // dropped silently rather than shown as a broken row.
    return (json.data.nodes ?? [])
      .filter(
        (n): n is { id: string; title: string } =>
          n !== null && typeof n.title === "string",
      )
      .map((n) => ({ id: n.id, title: n.title }));
  }

  const initialProducts =
    rule.scopeType === "PRODUCT_GROUP"
      ? await resolveProductTitles(rule.productIds)
      : [];
  const initialExcludedProducts = await resolveProductTitles(
    rule.excludedProductIds,
  );

  return {
    rule,
    hasAllProductsElsewhere,
    hasAnyOtherRule,
    initialProducts,
    initialExcludedProducts,
  };
};

// ---------------------------------------------------------------------------
// action
// ---------------------------------------------------------------------------
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const isNew = params.ruleId === "new";

  const formData = await request.formData();
  const name = String(formData.get("name") ?? "").trim() || null;
  const scopeType = String(formData.get("scopeType") ?? "ALL_PRODUCTS");
  if (!["ALL_PRODUCTS", "COLLECTION", "PRODUCT_GROUP"].includes(scopeType)) {
    return { error: "Invalid scope type." };
  }
  const collectionId = String(formData.get("collectionId") ?? "") || null;
  const collectionTitle = String(formData.get("collectionTitle") ?? "") || null;
  const productIds = JSON.parse(
    String(formData.get("productIds") ?? "[]"),
  ) as string[];
  const excludedProductIds = JSON.parse(
    String(formData.get("excludedProductIds") ?? "[]"),
  ) as string[];

  if (scopeType === "COLLECTION" && !collectionId) {
    return { error: "Choose a collection." };
  }
  if (scopeType === "PRODUCT_GROUP" && productIds.length === 0) {
    return { error: "Choose at least one product." };
  }

  // Defensive server-side re-check of exclusivity - the UI already prevents
  // this combination, but a direct form submit shouldn't be able to bypass
  // it. See the schema comment on NegotiationRule for the rule itself.
  const otherRules = await prisma.negotiationRule.findMany({
    where: {
      shopId: shop.id,
      ...(isNew ? {} : { id: { not: params.ruleId } }),
    },
    select: { scopeType: true },
  });
  const hasAllProductsElsewhere = otherRules.some(
    (r) => r.scopeType === "ALL_PRODUCTS",
  );
  if (hasAllProductsElsewhere) {
    return {
      error:
        "An all-products rule already exists. Delete it before adding or editing another rule.",
    };
  }
  if (scopeType === "ALL_PRODUCTS" && otherRules.length > 0) {
    return {
      error:
        "Other rules already exist. An all-products rule can't coexist with them.",
    };
  }

  // Required now, not optional - the segmented negotiation engine can't
  // compute anything without it (see resolveEffectiveLimits, which treats a
  // rule with no max discount set as unusable).
  const maxDiscountRaw = String(formData.get("maxDiscountPercent") ?? "").trim();
  if (
    !maxDiscountRaw ||
    Number.isNaN(Number(maxDiscountRaw)) ||
    Number(maxDiscountRaw) <= 0 ||
    Number(maxDiscountRaw) > 100
  ) {
    return { error: "Max discount % is required and must be between 0 and 100." };
  }

  const headerTitle = String(formData.get("headerTitle") ?? "").trim() || null;

  const data = {
    name,
    scopeType: scopeType as "ALL_PRODUCTS" | "COLLECTION" | "PRODUCT_GROUP",
    collectionId: scopeType === "COLLECTION" ? collectionId : null,
    collectionTitle: scopeType === "COLLECTION" ? collectionTitle : null,
    productIds: scopeType === "PRODUCT_GROUP" ? productIds : [],
    // Only meaningful for ALL_PRODUCTS/COLLECTION - PRODUCT_GROUP is already
    // an explicit inclusion list, so exclusions are forced empty there
    // rather than left to whatever stale value the form happened to submit.
    excludedProductIds:
      scopeType === "ALL_PRODUCTS" || scopeType === "COLLECTION"
        ? excludedProductIds
        : [],
    maxDiscountPercent: maxDiscountRaw,
    headerTitle,
    // Explicitly cleared, not just omitted - these fields no longer have
    // any UI to set them, but Prisma's update() leaves anything left out of
    // `data` untouched. Without this, editing an old rule that still has
    // values from before the form was simplified (leftover custom button
    // text, colors, templates, ladder) through this form would silently
    // keep serving that stale content forever, since saving would never
    // actually touch those columns.
    floorPriceOverride: null,
    enabledTriggers: [] as (
      | "ALWAYS_ON"
      | "DWELL_TIME"
      | "EXIT_INTENT"
      | "PAGE_REVISIT"
      | "COHORT_EMAIL"
    )[],
    dwellTimeSeconds: null,
    greetingTemplate: null,
    acceptedTemplate: null,
    floorReachedTemplate: null,
    rateLimitedTemplate: null,
    expiredTemplate: null,
    primaryColor: null,
    secondaryColor: null,
    widgetPosition: null,
    headerSubtitle: null,
    launcherButtonText: null,
    sendButtonText: null,
    acceptButtonText: null,
    declineButtonText: null,
    defaultLadderId: null,
  };

  if (isNew) {
    await prisma.negotiationRule.create({ data: { ...data, shopId: shop.id } });
  } else {
    const existing = await prisma.negotiationRule.findUnique({
      where: { id: params.ruleId },
    });
    if (!existing || existing.shopId !== shop.id) {
      return { error: "Rule not found." };
    }
    await prisma.negotiationRule.update({
      where: { id: params.ruleId },
      data,
    });
  }

  return redirect("/app/rules");
};

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------
export default function RuleEditor() {
  const {
    rule,
    hasAllProductsElsewhere,
    hasAnyOtherRule,
    initialProducts,
    initialExcludedProducts,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const isNew = !rule;
  const busy = navigation.state === "submitting";
  // See the schema comment on NegotiationRule: an all-products rule can't
  // coexist with anything else in either direction. If one exists elsewhere,
  // this page (new or edit) is blocked outright rather than letting the
  // merchant edit into a conflicting state.
  const blocked = hasAllProductsElsewhere;

  const [name, setName] = useState(rule?.name ?? "");
  const [scopeType, setScopeType] = useState<
    "ALL_PRODUCTS" | "COLLECTION" | "PRODUCT_GROUP"
  >(rule?.scopeType ?? "ALL_PRODUCTS");
  const [collectionId, setCollectionId] = useState(rule?.collectionId ?? "");
  const [collectionTitle, setCollectionTitle] = useState(
    rule?.collectionTitle ?? "",
  );
  const [selectedProducts, setSelectedProducts] =
    useState<ProductRef[]>(initialProducts);
  const [excludedProducts, setExcludedProducts] = useState<ProductRef[]>(
    initialExcludedProducts,
  );
  const [maxDiscountPercent, setMaxDiscountPercent] = useState(
    rule?.maxDiscountPercent?.toString() ?? "",
  );
  const [headerTitle, setHeaderTitle] = useState(rule?.headerTitle ?? "");

  async function pickCollection() {
    const result = await shopify.resourcePicker({ type: "collection" });
    const picked = Array.isArray(result) ? result[0] : result;
    if (!picked) return;
    setCollectionId(picked.id);
    setCollectionTitle(picked.title);
  }

  async function pickProducts() {
    const result = await shopify.resourcePicker({
      type: "product",
      multiple: true,
    });
    if (!result) return;
    setSelectedProducts(result.map((p) => ({ id: p.id, title: p.title })));
  }
  function removeProduct(id: string) {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== id));
  }

  async function pickExcludedProducts() {
    const result = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      // Pre-selects whatever's already excluded, so reopening the picker to
      // add one more doesn't force re-picking everything from scratch.
      selectionIds: excludedProducts.map((p) => ({ id: p.id })),
    });
    if (!result) return;
    setExcludedProducts(result.map((p) => ({ id: p.id, title: p.title })));
  }
  function removeExcludedProduct(id: string) {
    setExcludedProducts((prev) => prev.filter((p) => p.id !== id));
  }

  function handleSubmit() {
    const formData = new FormData();
    formData.set("name", name);
    formData.set("scopeType", scopeType);
    formData.set("collectionId", collectionId);
    formData.set("collectionTitle", collectionTitle);
    formData.set(
      "productIds",
      JSON.stringify(selectedProducts.map((p) => p.id)),
    );
    formData.set(
      "excludedProductIds",
      JSON.stringify(excludedProducts.map((p) => p.id)),
    );
    formData.set("maxDiscountPercent", maxDiscountPercent);
    formData.set("headerTitle", headerTitle);
    submit(formData, { method: "post" });
  }

  if (blocked) {
    return (
      <s-page heading={isNew ? "Create rule" : "Edit rule"}>
        <s-link slot="breadcrumb-actions" href="/app/rules">
          Rules
        </s-link>
        <s-section>
          <s-banner tone="warning" heading="An all-products rule is active">
            <s-paragraph>
              This shop already has a rule that covers every product, so it
              can&apos;t coexist with any other rule. Delete it from the Rules
              list before {isNew ? "creating" : "editing"} this one.
            </s-paragraph>
          </s-banner>
          <s-button href="/app/rules">Back to rules</s-button>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading={isNew ? "Create rule" : "Edit rule"}>
      <s-link slot="breadcrumb-actions" href="/app/rules">
        Rules
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleSubmit}
        loading={busy || undefined}
      >
        Save
      </s-button>

      {actionData?.error && (
        <s-section>
          <s-banner tone="critical" heading="Couldn't save">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section heading="Scope">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name (optional)"
            value={name}
            placeholder="e.g. Summer sale collection"
            onChange={(e: FieldChangeEvent) => setName(e.currentTarget.value)}
          />
          <s-select
            label="Applies to"
            value={scopeType}
            onChange={(e: FieldChangeEvent) =>
              setScopeType(
                e.currentTarget.value as
                  | "ALL_PRODUCTS"
                  | "COLLECTION"
                  | "PRODUCT_GROUP",
              )
            }
          >
            <s-option value="ALL_PRODUCTS" disabled={hasAnyOtherRule || undefined}>
              All products
            </s-option>
            <s-option value="COLLECTION">A collection</s-option>
            <s-option value="PRODUCT_GROUP">Specific products</s-option>
          </s-select>
          {hasAnyOtherRule && scopeType !== "ALL_PRODUCTS" && (
            <s-paragraph color="subdued">
              &quot;All products&quot; is unavailable while other rules exist,
              since it can&apos;t coexist with them.
            </s-paragraph>
          )}

          {scopeType === "COLLECTION" && (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button onClick={pickCollection}>
                {collectionTitle ? "Change collection" : "Choose collection"}
              </s-button>
              {collectionTitle && <s-paragraph>{collectionTitle}</s-paragraph>}
            </s-stack>
          )}

          {scopeType === "PRODUCT_GROUP" && (
            <s-stack direction="block" gap="small">
              <s-button onClick={pickProducts}>
                {selectedProducts.length > 0
                  ? "Change products"
                  : "Choose products"}
              </s-button>
              {selectedProducts.length > 0 && (
                <s-stack direction="block" gap="small">
                  {selectedProducts.map((p) => (
                    <s-stack
                      key={p.id}
                      direction="inline"
                      gap="small"
                      alignItems="center"
                    >
                      <s-paragraph>{p.title}</s-paragraph>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => removeProduct(p.id)}
                      >
                        Remove
                      </s-button>
                    </s-stack>
                  ))}
                </s-stack>
              )}
            </s-stack>
          )}

          {/* Carve-outs from an otherwise shop-wide or collection-wide rule -
              meaningless for PRODUCT_GROUP, which is already an explicit
              inclusion list. */}
          {(scopeType === "ALL_PRODUCTS" || scopeType === "COLLECTION") && (
            <s-stack direction="block" gap="small">
              <s-paragraph color="subdued">
                Exclude products (optional): these won&apos;t be negotiable
                under this rule, even though it otherwise covers them.
              </s-paragraph>
              <s-button onClick={pickExcludedProducts}>
                {excludedProducts.length > 0
                  ? "Change excluded products"
                  : "Exclude products"}
              </s-button>
              {excludedProducts.length > 0 && (
                <s-stack direction="block" gap="small">
                  {excludedProducts.map((p) => (
                    <s-stack
                      key={p.id}
                      direction="inline"
                      gap="small"
                      alignItems="center"
                    >
                      <s-paragraph>{p.title}</s-paragraph>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => removeExcludedProduct(p.id)}
                      >
                        Remove
                      </s-button>
                    </s-stack>
                  ))}
                </s-stack>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Discount">
        <s-text-field
          label="Max discount %"
          value={maxDiscountPercent}
          placeholder="e.g. 10"
          details="The most a customer can ever negotiate off. The negotiation engine handles everything else automatically."
          onChange={(e: FieldChangeEvent) =>
            setMaxDiscountPercent(e.currentTarget.value)
          }
        />
      </s-section>

      <s-section heading="Bot">
        <s-text-field
          label="Bot name"
          value={headerTitle}
          placeholder="e.g. Nibble"
          details="Shown to customers in the negotiation chat widget."
          onChange={(e: FieldChangeEvent) => setHeaderTitle(e.currentTarget.value)}
        />
      </s-section>
    </s-page>
  );
}
