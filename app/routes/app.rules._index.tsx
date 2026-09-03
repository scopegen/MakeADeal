import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  const rules = await prisma.negotiationRule.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });

  const hasAllProductsRule = rules.some((r) => r.scopeType === "ALL_PRODUCTS");

  return {
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      scopeType: r.scopeType,
      collectionTitle: r.collectionTitle,
      productCount: r.productIds.length,
      maxDiscountPercent: r.maxDiscountPercent?.toString() ?? null,
      createdAt: r.createdAt,
    })),
    hasAllProductsRule,
  };
};

// Deleting a rule also deletes its dedicated ladder (defaultLadderId isn't
// shared - each rule owns exactly one Ladder created for it by this UI).
// The rule must be deleted first: NegotiationRule.defaultLadderId is an FK
// into Ladder with the default Restrict behavior, so deleting the ladder
// first would fail while the rule still points at it. NegotiationSession
// keeps ladderIdSnapshot as a plain string (no FK relation) specifically so
// this delete never touches negotiation history - see the schema comment.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);

  const formData = await request.formData();
  const ruleId = String(formData.get("ruleId") ?? "");

  const rule = await prisma.negotiationRule.findUnique({
    where: { id: ruleId },
  });
  if (!rule || rule.shopId !== shop.id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.negotiationRule.delete({ where: { id: ruleId } });
    if (rule.defaultLadderId) {
      await tx.ladder.delete({ where: { id: rule.defaultLadderId } });
    }
  });

  return { ok: true };
};

const SCOPE_LABEL: Record<string, string> = {
  ALL_PRODUCTS: "All products",
  COLLECTION: "Collection",
  PRODUCT_GROUP: "Specific products",
};

export default function RulesList() {
  const { rules, hasAllProductsRule } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  function scopeSummary(rule: (typeof rules)[number]) {
    if (rule.scopeType === "COLLECTION") {
      return rule.collectionTitle
        ? `Collection: ${rule.collectionTitle}`
        : "Collection (not set)";
    }
    if (rule.scopeType === "PRODUCT_GROUP") {
      return `${rule.productCount} product${rule.productCount === 1 ? "" : "s"}`;
    }
    return "All products";
  }

  function handleDelete(ruleId: string, label: string) {
    if (!confirm(`Delete "${label}"? This can't be undone.`)) return;
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    submit(formData, { method: "post" });
  }

  return (
    <s-page heading="Rules">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={hasAllProductsRule || undefined}
        href="/app/rules/new"
      >
        Create rule
      </s-button>

      <s-section>
        {hasAllProductsRule && (
          <s-banner tone="info" heading="An all-products rule is active">
            <s-paragraph>
              This shop has a rule that covers every product. Delete it before
              creating a collection or specific-products rule - the two
              can&apos;t coexist, since the all-products rule already covers
              everything.
            </s-paragraph>
          </s-banner>
        )}

        {rules.length === 0 ? (
          <s-stack direction="block" gap="base" alignItems="center">
            <s-paragraph>
              No rules yet. Create one to start negotiating on your products.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table variant="auto" paginate={false}>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Scope</s-table-header>
              <s-table-header format="numeric">Max discount</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rules.map((rule) => {
                const label = rule.name?.trim() || scopeSummary(rule);
                return (
                  <s-table-row key={rule.id}>
                    <s-table-cell>
                      <s-link href={`/app/rules/${rule.id}`}>{label}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      {SCOPE_LABEL[rule.scopeType]}
                      {rule.scopeType !== "ALL_PRODUCTS" &&
                        ` — ${scopeSummary(rule)}`}
                    </s-table-cell>
                    <s-table-cell>
                      {rule.maxDiscountPercent
                        ? `${rule.maxDiscountPercent}%`
                        : "Not set"}
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(rule.createdAt).toLocaleDateString()}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => handleDelete(rule.id, label)}
                      >
                        Delete
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
