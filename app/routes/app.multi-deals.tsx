import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  DEAL_PLACEHOLDERS,
  DISCOUNT_TIER_COUNTS,
  MAX_EXTRA_DISCOUNT_PERCENT,
  dealMessage,
  type DealSettings,
} from "../models/deal-bag-copy";

// Same structural stand-ins used by app.rules.$ruleId.tsx for field and
// switch events - see that file's comment for why.
type FieldChangeEvent = { currentTarget: { value: string } };
type SwitchChangeEvent = { currentTarget: { checked: boolean } };

const MAX_MESSAGE_LENGTH = 300;

const TIER_LABELS = DISCOUNT_TIER_COUNTS.map((count, i) =>
  i === DISCOUNT_TIER_COUNTS.length - 1
    ? `${count} or more products`
    : `${count} products`,
);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  return {
    enabled: shop.multiDealsEnabled,
    discounts: shop.multiDealDiscounts,
    savedMessage: shop.multiDealSavedMessage ?? "",
    nextMessage: shop.multiDealNextMessage ?? "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const formData = await request.formData();

  const discounts: number[] = [];
  for (let i = 0; i < DISCOUNT_TIER_COUNTS.length; i++) {
    const raw = String(formData.get(`discount${i}`) ?? "").trim();
    const value = raw === "" ? 0 : Number(raw);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_EXTRA_DISCOUNT_PERCENT
    ) {
      return {
        error: `Extra discounts must be numbers from 0 to ${MAX_EXTRA_DISCOUNT_PERCENT}%. Leave a box empty for no extra discount at that number of products.`,
      };
    }
    discounts.push(Math.round(value * 100) / 100);
  }

  const message = (name: string) => {
    const text = String(formData.get(name) ?? "").trim();
    return text ? text.slice(0, MAX_MESSAGE_LENGTH) : null;
  };

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      multiDealsEnabled: String(formData.get("enabled") ?? "") === "true",
      // Stored empty when nothing is set, so "no extra discount" is one
      // clear state rather than a list of zeros.
      multiDealDiscounts: discounts.some((d) => d > 0) ? discounts : [],
      multiDealSavedMessage: message("savedMessage"),
      multiDealNextMessage: message("nextMessage"),
    },
  });
  return { ok: true as const };
};

// What the boxes currently say, as settings - for the live preview. A box
// that isn't a valid number yet counts as empty.
function previewSettings(
  discountInputs: string[],
  savedMessage: string,
  nextMessage: string,
): DealSettings {
  return {
    multiDealDiscounts: discountInputs.map((raw) => {
      const value = Number(raw);
      return raw.trim() !== "" &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= MAX_EXTRA_DISCOUNT_PERCENT
        ? value
        : 0;
    }),
    multiDealSavedMessage: savedMessage.trim() || null,
    multiDealNextMessage: nextMessage.trim() || null,
  };
}

export default function MultiDeals() {
  const loaded = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const busy = navigation.state !== "idle";

  const [enabled, setEnabled] = useState(loaded.enabled);
  const [discountInputs, setDiscountInputs] = useState<string[]>(
    DISCOUNT_TIER_COUNTS.map((_, i) => {
      const value = loaded.discounts[i] ?? 0;
      return value > 0 ? String(value) : "";
    }),
  );
  const [savedMessage, setSavedMessage] = useState(loaded.savedMessage);
  const [nextMessage, setNextMessage] = useState(loaded.nextMessage);

  useEffect(() => {
    if (actionData && "ok" in actionData) shopify.toast.show("Saved");
  }, [actionData, shopify]);

  function handleSave() {
    const formData = new FormData();
    formData.set("enabled", String(enabled));
    discountInputs.forEach((value, i) => formData.set(`discount${i}`, value));
    formData.set("savedMessage", savedMessage);
    formData.set("nextMessage", nextMessage);
    submit(formData, { method: "post" });
  }

  const preview = previewSettings(discountInputs, savedMessage, nextMessage);
  // Noodle's own wording for the current discounts - shown as each message
  // box's placeholder, so a merchant sees what they'd be replacing.
  const defaults = previewSettings(discountInputs, "", "");

  return (
    <s-page heading="Multi-product deals">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleSave}
        loading={busy || undefined}
      >
        Save
      </s-button>

      {actionData && "error" in actionData && (
        <s-section>
          <s-banner tone="critical" heading="Couldn't save">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section heading="Negotiate several products, check out once">
        <s-stack direction="block" gap="base">
          <s-switch
            label="Let shoppers collect deals on several products"
            details="After a deal, the shopper can keep browsing and negotiate other products too. Every deal goes into the same checkout, so they pay for everything at once. Deals are kept for 48 hours. When this is off, every deal has its own checkout."
            checked={enabled || undefined}
            onChange={(e: SwitchChangeEvent) =>
              setEnabled(e.currentTarget.checked)
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Extra discount (optional)">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Reward shoppers for negotiating more products with an extra
            discount on their whole order, on top of each price they
            negotiated. It shows at checkout as one discount line. Leave
            these empty for no extra discount: the chat then simply says all
            their deals go into one checkout.
          </s-paragraph>
          {TIER_LABELS.map((label, i) => (
            <s-text-field
              key={label}
              label={`${label}: extra % off`}
              value={discountInputs[i]}
              placeholder="e.g. 5"
              onChange={(e: FieldChangeEvent) => {
                const value = e.currentTarget.value;
                setDiscountInputs((prev) =>
                  prev.map((old, j) => (j === i ? value : old)),
                );
              }}
            />
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Messages">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Leave these empty to use Noodle&apos;s own wording, which changes
            to match your extra discounts. Or write your own, using:
          </s-paragraph>
          <s-unordered-list>
            {DEAL_PLACEHOLDERS.map((p) => (
              <s-list-item key={p.token}>
                {p.token}: {p.meaning}
              </s-list-item>
            ))}
          </s-unordered-list>
          <s-paragraph tone="neutral">
            If your message uses a value that doesn&apos;t exist at that
            moment, like the next discount once the biggest one is reached,
            Noodle uses its own wording for that moment instead.
          </s-paragraph>
          <s-text-area
            label="After a deal is saved"
            value={savedMessage}
            rows={3}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={dealMessage("saved", defaults, 1)}
            onChange={(e: FieldChangeEvent) =>
              setSavedMessage(e.currentTarget.value)
            }
          />
          <s-text-area
            label="On another product page"
            value={nextMessage}
            rows={3}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={dealMessage("next", defaults, 1)}
            onChange={(e: FieldChangeEvent) =>
              setNextMessage(e.currentTarget.value)
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Preview">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="neutral">
            What shoppers see with the settings above, before saving.
          </s-paragraph>
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">After their first deal</s-text>
            <s-paragraph>{dealMessage("saved", preview, 1)}</s-paragraph>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">On the next product page</s-text>
            <s-paragraph>{dealMessage("next", preview, 1)}</s-paragraph>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">After their second deal</s-text>
            <s-paragraph>{dealMessage("saved", preview, 2)}</s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
