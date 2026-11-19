import type { AdminGraphqlClient } from "./draft-order-lookup.server";

const SUGGESTIONS_LIMIT = 5;

// Never suggest anything priced below this share of the shopper's own
// offer: someone ready to pay 20,000 is looking for a 10,000-20,000
// alternative, not a 6,500 one. Applies to every step below.
const MIN_SHARE_OF_OFFER = 0.5;

// Page sizes. A product-type or category search is narrow, so 50 is plenty.
// The category-tree step (and the store's main line, see getStoreMainLine)
// reads a wider sample of the whole store instead - 250 is Shopify's page
// maximum, and still far under its per-query cost ceiling of 1000.
const SEARCH_PAGE = 50;
const STORE_SAMPLE = 250;

// Collection step tuning (see collectionsStep):
// - At most this many of the product's collections are read, smallest
//   first: a smaller collection says more about what a product is.
// - Each collection contributes up to this many of its cheapest products
//   (Shopify's page maximum). A collection bigger than that, whose
//   cheapest 250 all sit below the shopper's price window, can still come
//   up empty here - the category steps cover that case.
// - A collection holding at least this share of every product in the store
//   ("All products", a catch-all smart collection) is skipped outright:
//   sharing it says nothing about two products being alike.
const MAX_COLLECTIONS = 5;
const PRODUCTS_PER_COLLECTION = 250;
const STORE_WIDE_SHARE = 0.8;

// Shopify's own "Uncategorized" taxonomy entry - treated exactly like having
// no category at all.
const UNCATEGORIZED_ID = "gid://shopify/TaxonomyCategory/na";

// Which price pass the products came from - the caller picks the wording
// from this (see getSuggestionsMessage in negotiation-tiers.server.ts), since
// the same products read differently after a held floor than after "No deal".
export type SuggestionsMatch =
  | { kind: "near_offer"; products: SuggestedProduct[] }
  | { kind: "near_original"; products: SuggestedProduct[] }
  | { kind: "none" };

export type SuggestedProduct = {
  id: string;
  title: string;
  price: number;
  // The price's own currency as Shopify reports it (the store's base
  // currency), so the widget can format it the way the store does.
  currencyCode: string;
  imageUrl: string | null;
  // The widget builds the link from this (/products/{handle}, under the
  // storefront's own locale root) rather than using onlineStoreUrl, which
  // Shopify returns as null on password-protected stores (every dev store),
  // leaving the card unclickable. A relative link also keeps the shopper on
  // whatever domain they're already browsing.
  handle: string;
};

// A Shopify Standard Product Taxonomy category. ancestorIds is root-first:
// Salwar Kameez & Suit Sets -> [Apparel & Accessories, Clothing,
// Traditional & Ceremonial Clothing].
type Category = { id: string; ancestorIds: string[] };

type PricePass = { kind: "near_offer" | "near_original"; ceiling: number };

// The price window every step searches within: at least `floor`, and under
// each pass's ceiling - the shopper's own offer first, then the original
// product's price if nothing fits under the offer. `offer` is what results
// are sorted by: closest to what the shopper said they'd pay comes first.
type Band = {
  floor: number;
  offer: number;
  passes: PricePass[];
  excludeId: string;
};

// One matching step: given the price passes still in play, the products it
// finds for each (same order as `passes`), best first.
type Step = (passes: PricePass[]) => Promise<SuggestedProduct[][]>;

const NONE: SuggestionsMatch = { kind: "none" };

// What to suggest once suggestions have been asked for. negotiation-offer
// .server.ts decides whether they should run at all (Shop.suggestionsEnabled,
// once per session via NegotiationSession.suggestionsShown).
//
// Steps, closest match first:
// 1. Same product type (the merchant's own free-text classification).
// 2. Same Shopify category (the standard taxonomy - Shopify fills this in
//    on most products even when product type is left blank).
// 3. Products sharing the most collections with this one.
// 4. Closest relatives in Shopify's category tree - sibling categories
//    first, then wider, never jumping to an unrelated department. If this
//    product has no category, one is borrowed from its relatives, or the
//    store's main line is used (see findRelatives).
//
// The first step to find anything decides the price pass (under the
// shopper's offer if anything fits there, otherwise under the original
// price), then later steps top the carousel up to SUGGESTIONS_LIMIT within
// that same pass - so one lonely card from a narrow step gets company from
// its nearest relatives, closest kind of product always first.
//
// This runs inside a storefront app-proxy request, so round trips matter:
// the lookups for steps 1-3 depend only on the product itself and are all
// made at once; only step 3's card details and step 4 wait on anything.
export async function findSuggestions(
  admin: AdminGraphqlClient,
  {
    productId,
    offerPrice,
    originalPrice,
    ignoredCollectionIds,
  }: {
    productId: string;
    // The shopper's offer. 0 (no offer on record) leaves only the
    // under-original-price pass, with no lower bound.
    offerPrice: number;
    // The price of the variant actually being negotiated (the session's
    // starting price) - not the product's cheapest variant, which can be
    // far lower and would squeeze the fallback window shut.
    originalPrice: number;
    // Merchant-picked on the Suggestions page (Bestsellers, Sale, ...):
    // collections that say nothing about what a product is.
    ignoredCollectionIds: string[];
  },
): Promise<SuggestionsMatch> {
  const source = await getSourceProduct(admin, productId);
  if (!source) return NONE;

  const floor = Math.max(0, offerPrice * MIN_SHARE_OF_OFFER);
  const passes: PricePass[] = [
    { kind: "near_offer" as const, ceiling: offerPrice },
    { kind: "near_original" as const, ceiling: originalPrice },
  ].filter((pass) => pass.ceiling > floor);
  if (passes.length === 0) return NONE;
  const band: Band = { floor, offer: offerPrice, passes, excludeId: productId };

  // Steps 1-3's lookups, all at once. Each covers every pass in `band`, so
  // whichever pass ends up locked below already has its results. Promise.all
  // also keeps a second failure from going unhandled once the first has
  // already failed the whole lookup.
  const noResults = () => band.passes.map((): SuggestedProduct[] => []);
  const collectionIds = usableCollectionIds(source, ignoredCollectionIds);
  const [byType, byCategory, members] = await Promise.all([
    source.productType
      ? searchStep(
          admin,
          `product_type:"${escapeSearchValue(source.productType)}"`,
          band,
          band.passes,
        )
      : noResults(),
    source.category
      ? searchStep(
          admin,
          `category_id:${taxonomyKey(source.category.id)}`,
          band,
          band.passes,
        )
      : noResults(),
    collectionIds.length > 0
      ? getCollectionMembers(admin, collectionIds)
      : new Map<string, CollectionMember>(),
  ]);
  members.delete(productId);

  // Results already fetched for every pass in `band`, narrowed to the
  // passes still in play.
  const forPasses = (all: SuggestedProduct[][], p: PricePass[]) =>
    p.map((pass) => all[band.passes.indexOf(pass)] ?? []);

  const steps: Step[] = [
    async (p) => forPasses(byType, p),
    async (p) => forPasses(byCategory, p),
    (p) => collectionsStep(admin, members, band, p),
    async (p) => {
      const anchor =
        source.category ??
        borrowCategory(members) ??
        (source.productType
          ? await borrowCategoryFromType(admin, source.productType)
          : null) ??
        (await getStoreMainLine(admin));
      return anchor ? findRelatives(admin, anchor, band, p) : p.map(() => []);
    },
  ];

  let lockedPass: PricePass | null = null;
  const picked: SuggestedProduct[] = [];
  const seen = new Set<string>([productId]);
  for (const step of steps) {
    const inPlay: PricePass[] = lockedPass ? [lockedPass] : band.passes;
    const results = await step(inPlay);
    let found: SuggestedProduct[] = [];
    if (lockedPass) {
      found = results[0] ?? [];
    } else {
      const i = results.findIndex((r) => r.length > 0);
      if (i === -1) continue;
      lockedPass = inPlay[i];
      found = results[i];
    }
    for (const card of found) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      picked.push(card);
    }
    if (picked.length >= SUGGESTIONS_LIMIT) break;
  }

  if (!lockedPass || picked.length === 0) return NONE;
  return {
    kind: lockedPass.kind,
    products: picked.slice(0, SUGGESTIONS_LIMIT),
  };
}

type SourceProduct = {
  productType: string;
  category: Category | null;
  collections: { id: string; productsCount: number }[];
  storeProductsCount: number;
};

// The product being negotiated, looked up live when suggestions are asked
// for - not cached on the session, since a merchant could change its type,
// category or collections after the negotiation started (same "don't
// mirror, look it up live" reasoning used everywhere else in this
// codebase). Also reads the store's total product count, to spot
// store-wide collections.
async function getSourceProduct(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<SourceProduct | null> {
  const response = await admin.graphql(
    `#graphql
    query NoodleSuggestionsSourceProduct($id: ID!) {
      product(id: $id) {
        productType
        category {
          id
          ancestorIds
        }
        collections(first: 20) {
          nodes {
            id
            productsCount {
              count
            }
          }
        }
      }
      productsCount {
        count
      }
    }`,
    { variables: { id: productId } },
  );
  const json = (await response.json()) as {
    data?: {
      product: {
        productType: string;
        category: Category | null;
        collections: {
          nodes: { id: string; productsCount: { count: number } | null }[];
        };
      } | null;
      productsCount: { count: number } | null;
    };
  };
  const product = json.data?.product;
  if (!product) return null;
  return {
    productType: product.productType ?? "",
    category: isRealCategory(product.category) ? product.category : null,
    collections: product.collections.nodes.map((c) => ({
      id: c.id,
      productsCount: c.productsCount?.count ?? 0,
    })),
    storeProductsCount: json.data?.productsCount?.count ?? 0,
  };
}

// Steps 1 and 2: one search filter (a product type or a category), run
// under each price pass in play - all in one request.
async function searchStep(
  admin: AdminGraphqlClient,
  filter: string,
  band: Band,
  passes: PricePass[],
): Promise<SuggestedProduct[][]> {
  const results = await searchProducts(
    admin,
    passes.map((pass) => `${filter} AND ${priceFilter(band.floor, pass.ceiling)}`),
    SEARCH_PAGE,
  );
  return passes.map((pass, i) =>
    cardsInBand(results[i], band, pass.ceiling).sort(byCloseness(band.offer)),
  );
}

// Step 3's candidate collections: not ignored by the merchant, not empty,
// not store-wide - smallest (most specific) first.
function usableCollectionIds(
  source: SourceProduct,
  ignoredCollectionIds: string[],
): string[] {
  const ignored = new Set(ignoredCollectionIds);
  const storeWideAt = source.storeProductsCount * STORE_WIDE_SHARE;
  return source.collections
    .filter(
      (c) =>
        !ignored.has(c.id) &&
        c.productsCount > 0 &&
        (source.storeProductsCount === 0 || c.productsCount < storeWideAt),
    )
    .sort((a, b) => a.productsCount - b.productsCount)
    .slice(0, MAX_COLLECTIONS)
    .map((c) => c.id);
}

type CollectionMember = {
  price: number;
  shared: number;
  category: Category | null;
};

// Every active product in the given collections (up to
// PRODUCTS_PER_COLLECTION of the cheapest from each), with how many of those
// collections it appears in. One query, one aliased field per collection.
// Shopify's product search can't combine collection_id with a price filter
// (tested: always zero results), so collections are read directly, sorted
// by price, and the price window is applied in collectionsStep instead.
async function getCollectionMembers(
  admin: AdminGraphqlClient,
  collectionIds: string[],
): Promise<Map<string, CollectionMember>> {
  const variableDefs = collectionIds.map((_, i) => `$c${i}: ID!`).join(", ");
  const fields = collectionIds
    .map(
      (_, i) => `
      c${i}: collection(id: $c${i}) {
        products(first: ${PRODUCTS_PER_COLLECTION}, sortKey: PRICE) {
          nodes {
            id
            status
            category {
              id
              ancestorIds
            }
            priceRangeV2 {
              minVariantPrice {
                amount
              }
            }
          }
        }
      }`,
    )
    .join("");
  // No #graphql tag on queries assembled from pieces, like this one: the
  // codegen tooling (.graphqlrc.ts) can't parse them.
  const response = await admin.graphql(
    `query NoodleSuggestionsCollectionMembers(${variableDefs}) {${fields}
    }`,
    {
      variables: Object.fromEntries(
        collectionIds.map((id, i) => [`c${i}`, id]),
      ),
    },
  );
  const json = (await response.json()) as {
    data?: Record<
      string,
      {
        products: {
          nodes: {
            id: string;
            status: string;
            category: Category | null;
            priceRangeV2: { minVariantPrice: { amount: string } };
          }[];
        };
      } | null
    >;
  };

  const members = new Map<string, CollectionMember>();
  for (const collection of Object.values(json.data ?? {})) {
    for (const node of collection?.products.nodes ?? []) {
      if (node.status !== "ACTIVE") continue;
      const existing = members.get(node.id);
      if (existing) existing.shared += 1;
      else {
        members.set(node.id, {
          price: Number(node.priceRangeV2.minVariantPrice.amount),
          shared: 1,
          category: isRealCategory(node.category) ? node.category : null,
        });
      }
    }
  }
  return members;
}

// Step 3. A product usually sits in several collections, some describing
// what it is (Kurta Sets), some only how it's merchandised (Bestsellers,
// Ready to Ship) - and there's no field telling those apart. So rather than
// guessing which one is "the category", every usable collection counts, and
// candidates are ranked by how many of them they share with this product.
// Two kurta sets that are both ready to ship (2 shared) beat a kaftan
// that's merely also a bestseller (1 shared). Ties go to the price closest
// to the shopper's offer.
async function collectionsStep(
  admin: AdminGraphqlClient,
  members: Map<string, CollectionMember>,
  band: Band,
  passes: PricePass[],
): Promise<SuggestedProduct[][]> {
  const closeness = (price: number) => Math.abs(price - band.offer);
  const rankedPerPass = passes.map((pass) =>
    [...members.entries()]
      .filter(([, m]) => m.price >= band.floor && m.price < pass.ceiling)
      .sort(
        ([, a], [, b]) =>
          b.shared - a.shared || closeness(a.price) - closeness(b.price),
      )
      .map(([id]) => id)
      // Twice the limit, since some may turn out to be out of stock once
      // their full details are read.
      .slice(0, SUGGESTIONS_LIMIT * 2),
  );
  const allIds = [...new Set(rankedPerPass.flat())];
  if (allIds.length === 0) return passes.map(() => []);
  const cards = new Map(
    (await getProductCards(admin, allIds)).map((card) => [card.id, card]),
  );
  return rankedPerPass.map((ids) =>
    ids.flatMap((id) => {
      const card = cards.get(id);
      return card ? [card] : [];
    }),
  );
}

// Step 4, for a product with no category of its own: borrow the category
// most of its collection-mates (already read in step 3) share.
function borrowCategory(
  members: Map<string, CollectionMember>,
): Category | null {
  const tally = new Map<string, { category: Category; count: number }>();
  for (const member of members.values()) addToTally(tally, member.category);
  return mostCommon(tally);
}

// ...or failing that, the category most other products of the same type
// share. An uncategorised product typed "Kurta Sets", whose fellow Kurta
// Sets mostly sit in "Kurtas & Kurta Sets", gets treated as Kurtas & Kurta
// Sets.
async function borrowCategoryFromType(
  admin: AdminGraphqlClient,
  productType: string,
): Promise<Category | null> {
  const [sameType] = await searchProducts(
    admin,
    [`product_type:"${escapeSearchValue(productType)}" AND status:active`],
    SEARCH_PAGE,
  );
  const tally = new Map<string, { category: Category; count: number }>();
  for (const node of sameType) addToTally(tally, node.category);
  return mostCommon(tally);
}

// Step 4, last resort, for a product with nothing to go on at all - no
// category, and no relatives with one: the store's main line, i.e. the
// second-level branch of the tree (e.g. "Clothing") most of its products
// sit under. A fashion store's uncategorised product then still gets
// in-budget clothing, never a snowboard or a gift card.
async function getStoreMainLine(
  admin: AdminGraphqlClient,
): Promise<Category | null> {
  const [sample] = await searchProducts(admin, ["status:active"], STORE_SAMPLE);
  const tally = new Map<string, { category: Category; count: number }>();
  for (const node of sample) {
    if (!isRealCategory(node.category)) continue;
    const rootFirst = [...node.category.ancestorIds, node.category.id];
    const branchIndex = Math.min(1, rootFirst.length - 1);
    addToTally(tally, {
      id: rootFirst[branchIndex],
      ancestorIds: rootFirst.slice(0, branchIndex),
    });
  }
  return mostCommon(tally);
}

// Step 4. In-budget products from across the store, ranked by how close
// their category sits to `anchor` in Shopify's category tree: the same
// category first, then siblings (same parent - for a salwar suit: kurta
// sets, lehengas, saris, kaftans), then cousins (same grandparent: dresses,
// kids' clothing), and so on - but never products whose only common
// ancestor is the top-level department (Apparel & Accessories covers
// jewellery and handbags too), and never anything uncategorised or from
// another department entirely. Ties go to the price closest to the
// shopper's offer.
//
// Reads a sample of up to STORE_SAMPLE in-budget products per pass rather
// than the whole catalog - on a very large store that can miss a closer
// relative, but by this step the narrower steps above have usually found
// something.
async function findRelatives(
  admin: AdminGraphqlClient,
  anchor: Category,
  band: Band,
  passes: PricePass[],
): Promise<SuggestedProduct[][]> {
  // Nearest first: the anchor itself, its parent, ..., the root last.
  const lineage = [anchor.id, ...[...anchor.ancestorIds].reverse()];
  const rootIndex = lineage.length - 1;
  const distanceTo = (category: Category | null): number | null => {
    if (!isRealCategory(category)) return null;
    const theirs = new Set([category.id, ...category.ancestorIds]);
    const i = lineage.findIndex((id) => theirs.has(id));
    if (i === -1) return null;
    // Only the top-level department in common is too loose - unless the
    // anchor IS a top-level category, where the same category is the only
    // match there could be.
    if (i > 0 && i === rootIndex) return null;
    return i;
  };

  const results = await searchProducts(
    admin,
    passes.map((pass) => priceFilter(band.floor, pass.ceiling)),
    STORE_SAMPLE,
  );
  const closer = byCloseness(band.offer);
  return passes.map((pass, i) => {
    const distances = new Map(
      results[i].map((n) => [n.id, distanceTo(n.category)]),
    );
    return cardsInBand(results[i], band, pass.ceiling)
      .filter((card) => distances.get(card.id) != null)
      .sort(
        (a, b) =>
          (distances.get(a.id) ?? 0) - (distances.get(b.id) ?? 0) ||
          closer(a, b),
      );
  });
}

// Runs several product searches in one request (one aliased field each),
// returning each search's products in the same order as `queries`.
async function searchProducts(
  admin: AdminGraphqlClient,
  queries: string[],
  first: number,
): Promise<CandidateNode[][]> {
  if (queries.length === 0) return [];
  const variableDefs = queries.map((_, i) => `$q${i}: String!`).join(", ");
  const fields = queries
    .map(
      (_, i) => `
      q${i}: products(query: $q${i}, first: ${first}) {
        nodes {
          ${CANDIDATE_FIELDS}
        }
      }`,
    )
    .join("");
  const response = await admin.graphql(
    `query NoodleSuggestionSearch(${variableDefs}) {${fields}
    }`,
    { variables: Object.fromEntries(queries.map((q, i) => [`q${i}`, q])) },
  );
  const json = (await response.json()) as {
    data?: Record<string, { nodes: CandidateNode[] } | null>;
  };
  return queries.map((_, i) => json.data?.[`q${i}`]?.nodes ?? []);
}

// Card details for an already-ranked list of product ids (step 3), keeping
// that order and dropping anything out of stock or no longer active since
// the ranking was read.
async function getProductCards(
  admin: AdminGraphqlClient,
  productIds: string[],
): Promise<SuggestedProduct[]> {
  const response = await admin.graphql(
    `query NoodleSuggestionCards($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          ${CANDIDATE_FIELDS}
        }
      }
    }`,
    { variables: { ids: productIds } },
  );
  // A deleted product comes back null; anything that somehow isn't a
  // Product comes back as an empty object (the fragment didn't apply).
  const json = (await response.json()) as {
    data?: { nodes: (Partial<CandidateNode> | null)[] };
  };
  const cards: SuggestedProduct[] = [];
  for (const node of json.data?.nodes ?? []) {
    const card = node?.id ? toCard(node as CandidateNode) : null;
    if (card) cards.push(card);
  }
  return cards;
}

// Search syntax for a price window. Shopify's price filter matches if ANY
// variant is in range, so a product whose cheapest variant is below the
// floor can still come back - cardsInBand re-checks the price that's
// actually shown on the card.
function priceFilter(floor: number, ceiling: number) {
  const floorText = (Math.floor(floor * 100) / 100).toString();
  return `price:>=${floorText} AND price:<${ceiling} AND status:active`;
}

// Search results turned into cards: in stock, active, priced inside the
// window, never the product being negotiated, no duplicates.
function cardsInBand(
  nodes: CandidateNode[],
  band: Band,
  ceiling: number,
): SuggestedProduct[] {
  const seen = new Set<string>();
  const cards: SuggestedProduct[] = [];
  for (const node of nodes) {
    if (node.id === band.excludeId || seen.has(node.id)) continue;
    const card = toCard(node);
    if (!card || card.price < band.floor || card.price >= ceiling) continue;
    seen.add(node.id);
    cards.push(card);
  }
  return cards;
}

// Closest to the shopper's offer first, in either direction - under the
// offer that's the highest price, over it (the under-original-price pass)
// the lowest.
function byCloseness(offer: number) {
  return (a: SuggestedProduct, b: SuggestedProduct) =>
    Math.abs(a.price - offer) - Math.abs(b.price - offer);
}

// Everything a suggestion card needs, plus the category used for ranking.
const CANDIDATE_FIELDS = `
          id
          title
          handle
          status
          category {
            id
            ancestorIds
          }
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          variants(first: 1) {
            nodes {
              availableForSale
            }
          }`;

type CandidateNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  category: Category | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
  // First variant only, same stock-check pattern already used in
  // proxy.eligibility.tsx and proxy.start.tsx - availableForSale already
  // accounts for a merchant's own "continue selling when out of stock"
  // setting, unlike a raw inventory count.
  variants: { nodes: { availableForSale: boolean }[] };
};

function toCard(node: CandidateNode): SuggestedProduct | null {
  if (node.status !== "ACTIVE") return null;
  if (!node.variants.nodes[0]?.availableForSale) return null;
  return {
    id: node.id,
    title: node.title,
    price: Number(node.priceRangeV2.minVariantPrice.amount),
    currencyCode: node.priceRangeV2.minVariantPrice.currencyCode,
    imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    handle: node.handle,
  };
}

function isRealCategory(category: Category | null): category is Category {
  return category != null && category.id !== UNCATEGORIZED_ID;
}

function addToTally(
  tally: Map<string, { category: Category; count: number }>,
  category: Category | null,
) {
  if (!isRealCategory(category)) return;
  const entry = tally.get(category.id);
  if (entry) entry.count += 1;
  else tally.set(category.id, { category, count: 1 });
}

function mostCommon(
  tally: Map<string, { category: Category; count: number }>,
): Category | null {
  let best: { category: Category; count: number } | null = null;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.category ?? null;
}

// "gid://shopify/TaxonomyCategory/aa-1-23-10" -> "aa-1-23-10", the form the
// category_id search filter takes.
function taxonomyKey(categoryId: string) {
  return categoryId.split("/").pop() ?? categoryId;
}

// A merchant-supplied value inside a quoted search term.
function escapeSearchValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
