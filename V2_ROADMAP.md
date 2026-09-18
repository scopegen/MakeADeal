# V2 Roadmap

Post-launch features/fixes, deliberately deferred out of the initial App Store
submission to keep v1 scoped and shippable. Not in priority order yet — add
items as they come up.

## 1. Currency conversion (Shopify Markets awareness)

**Problem:** The negotiation engine (price fetch, discount math, draft-order
creation) is currently hard-wired to the shop's base currency via
`priceRangeV2`. A shopper browsing a Markets-enabled store in their own
region sees a converted price on the product page, but the negotiation
widget negotiates against the base-currency number instead — the two can
disagree.

**Fix path (researched, not yet implemented):**
- Admin API's `ProductVariant.contextualPricing` field returns the
  Markets-converted price for a given `ContextualPricingContext` (country
  code and/or company location).
- The widget needs to learn the shopper's detected country and pass it
  through — likely a new `data-*` attribute on the mount div, populated in
  Liquid from `localization.country`, mirroring how `data-shop` /
  `data-product-id` already work.
- `proxy.start.tsx` would use that country to request contextual pricing
  instead of the flat base price; the rest of the negotiation flow (tier
  math, counter-offers) is currency-agnostic already and should follow
  through unchanged once the starting price/currency are correct.

**Open question, not yet verified:** whether `draftOrderCreate` can complete
checkout in the shopper's local/contextual currency, or whether that needs
a Markets-specific order context. Needs confirming before this is called
"done" — negotiating in the right currency but checking out in the wrong
one would be worse than the current behavior.

## 2. Similar-product suggestions within the shopper's price range

**Idea:** When a shopper's offer is rejected (or falls outside what the
active rule/ladder allows), suggest other products of the same product
type that already fall within the price range the shopper was asking for
— instead of just declining the offer.

**Not yet scoped:** matching logic (same `productType`? same collection?),
where the recommendation surfaces in the widget UI, and whether it needs a
new Admin API query (e.g. filtering products by type + price range) or can
reuse data already being fetched.

## 3. Tag orders created from negotiation checkout links

**Problem:** `createNegotiatedDraftOrder` (in
`app/models/negotiation-engine.server.ts`) currently only sets a `note` on
the `DraftOrderInput` (`"Negotiated via Scopegen Negotiator - session
{sessionId}"`) - no `tags`. That note carries onto the resulting order once
the draft order is completed, but it's free text, not a taggable/filterable
attribute - a merchant can't segment negotiated orders in Admin order
search/filters or in reports without one.

**Fix path:** add a `tags` array (e.g. `["Negotiated"]`, or something more
specific like `["negotiated-checkout"]`) to the same `DraftOrderInput` at
[negotiation-engine.server.ts:194](app/models/negotiation-engine.server.ts#L194)
- `DraftOrderInput.tags` is a plain `[String!]` field, so this should be a
small, low-risk addition alongside the existing `note`. Worth deciding
whether the tag should also encode which rule/ladder applied, for reporting.

## 4. Block noodle.scopegen.in from Google

`noodle.scopegen.in` is the app's own backend domain, not a page a shopper
or merchant should ever land on via search - it should not be indexed.

**Not yet done:** check what `robots.txt` currently serves for this domain,
then add/adjust the rule so it's disallowed (and consider a `noindex`
response header as a second layer, since `robots.txt` alone doesn't remove
pages already indexed - may need a Search Console removal request too if
anything's already been picked up).

## 5. Admin dashboard: total negotiations per brand

A dashboard, pulling live from the backend/DB, showing total negotiation
counts broken out per brand/shop.

**Not yet scoped:** which metrics beyond a raw count (accepted vs.
declined? total discount given? conversion rate?), and whether this is a
per-merchant view (their own shop's numbers, inside the embedded app) or
an internal cross-shop view for us.

## 6. Button animation

Add animation/motion to a button in the app UI for a better feel.

**Not yet specified:** which button - confirm before implementing.

## (more to be added)
