// Customer-segment negotiation engine. Replaces the old merchant-configurable
// Ladder/LadderStep system for the core counter-offer decision: segments and
// their tier tables are fixed, defined here, not merchant-configurable (per
// explicit decision - "tiers defined by us not the user"). NegotiationRule
// still supplies maxDiscountPercent/floorPriceOverride per product scope;
// everything else here is derived from that.
//
// Design, in one paragraph: a customer's first valid offer classifies them
// into one of four segments based on how far below the floor price it is,
// expressed in multiples of the max discount amount (D = listPrice ×
// maxDiscountPercent/100). That segment is locked for the whole session -
// never reassigned, even if a later offer would classify differently. Each
// segment then has its own fixed sequence of tiers; every tier's counter
// price is a percentage OF THE MAX DISCOUNT AMOUNT (not of price directly),
// climbing toward exactly the floor price at the segment's final tier. Any
// offer at or above the floor is accepted immediately, at any point, in any
// segment - that check always runs first.

export type CustomerSegment =
  | "EASY_TO_CONVERT"
  | "CAN_BE_CONVERTED"
  | "MAYBE_CONVERTIBLE"
  | "TOO_LOW";

type Tier = {
  // Percentage OF THE MAX DISCOUNT AMOUNT, not of list price. 100 = the
  // floor price exactly - every segment's last tier is 100. Meaningless
  // when noPrice is true.
  percentOfMaxDiscount: number;
  copies: string[];
  // true only for Too-Low's tier 1: a conversational nudge asking the
  // visitor to move up, with no price attached at all - no
  // {{counter_price}} placeholder in its copies. Every other segment's
  // tier 1 always attaches a real price (TIER_1_COPIES below).
  noPrice?: boolean;
};

// Each greeting is sent as TWO separate bot messages, not one message with
// a line break - see getGreetingMessage below.
const GREETING_COPIES: [string, string][] = [
  [
    "Hello! I'm your sales buddy. I'll do my best to get you a great deal.",
    "What price did you have in mind?",
  ],
  [
    "Hello! I'm your sales buddy. Let's see if we can make this work at a price you're comfortable with.",
    "What's your offer?",
  ],
  [
    "Hello! I'm your sales buddy. I'm here to help you find a deal that feels right.",
    "What price would you like to offer?",
  ],
  [
    "Hello! I'm your sales buddy. Let's find a deal that works for both of us.",
    "What would you like to offer?",
  ],
];

// Tier 1's wording is shared across Easy-to-Convert, Can-Be-Converted, and
// Maybe-Convertible - only the price percentage differs per segment (each
// segment gets its own Tier object below, all pointing at this same copy
// array). Too-Low's tier 1 is a no-price nudge instead (no price offered at
// greeting-adjacent stage for that segment) - see NO_PRICE_TIER_1_TOO_LOW.
const TIER_1_COPIES = [
  "Thanks for your offer. I can make a little room on the price and bring it to {{counter_price}}. Would that feel fair to you?",
  "I appreciate you making an offer. I can make a small adjustment and offer it to you at {{counter_price}}. What do you think?",
  "I'd be happy to meet you partway. I can make some room on the price and bring it down to {{counter_price}}. Would that work for you?",
  "We're already reasonably close, so I can make a little move for you and offer {{counter_price}}. Could we make that work?",
];

const TIER_1_EASY_TO_CONVERT: Tier = {
  percentOfMaxDiscount: 15,
  copies: TIER_1_COPIES,
};

const TIER_1_CAN_BE_CONVERTED: Tier = {
  percentOfMaxDiscount: 20,
  copies: TIER_1_COPIES,
};

const TIER_1_MAYBE_CONVERTIBLE: Tier = {
  percentOfMaxDiscount: 22,
  copies: TIER_1_COPIES,
};

const NO_PRICE_TIER_1_TOO_LOW: Tier = {
  percentOfMaxDiscount: 0, // unused - noPrice is true
  noPrice: true,
  copies: [
    "Thanks for the offer. We're a fair way apart on this one. Could you move up a bit so I can see what I can do?",
    "I appreciate you sharing a number. It's a good bit below where I can go, so if you could come up a little, I'll take another look.",
    "We're starting a little far apart here. If you can bring your offer up a bit, I'd be happy to work with you on this.",
    "I'd like to find something that works for us both. Could you move your offer up a little so we have more room to work with?",
  ],
};

const SEGMENT_TIERS: Record<CustomerSegment, Tier[]> = {
  EASY_TO_CONVERT: [
    TIER_1_EASY_TO_CONVERT,
    {
      percentOfMaxDiscount: 30,
      copies: [
        "I can come a little further for you. My new offer is {{counter_price}}. Could we agree there?",
        "We're getting closer. I can make another move and bring the price to {{counter_price}}. Would that work for you?",
        "I appreciate you coming back with another offer. I can meet you at {{counter_price}}. Shall we make it work there?",
        "I've made another move on the price and can offer {{counter_price}}. Could we meet somewhere around there?",
      ],
    },
    {
      percentOfMaxDiscount: 50,
      copies: [
        "I've moved the price further to {{counter_price}}. We're getting very close now. Would you be comfortable with that?",
        "I've made a stronger move and can offer {{counter_price}}. Could we close things out at that price?",
        "I've pushed the price down to {{counter_price}}. I hope that brings us close enough to make this work.",
        "We're very close now. I can offer {{counter_price}}. Would you be happy to move forward at that price?",
      ],
    },
    {
      percentOfMaxDiscount: 80,
      copies: [
        "I've reached a very strong price at {{counter_price}}. Would you like to accept it?",
        "{{counter_price}} is the lowest price I can offer at this stage. If that works for you, we can move ahead.",
        "I've made my strongest offer so far at {{counter_price}}. Would you like to go ahead?",
        "This is the best price I can make available at {{counter_price}}. Shall we close the deal there?",
      ],
    },
    // Re-proposes the same 80% position rather than jumping straight to
    // 100 - one more chance before the final round (same pattern as B and
    // C's repeated tiers).
    {
      percentOfMaxDiscount: 80,
      copies: [
        "I've taken another look and {{counter_price}} is still the strongest price I can offer. Would that work for you?",
        "I'd really like to make this work, and {{counter_price}} is the best I can offer from here. Can we agree there?",
        "I've done what I can on the price, and I can hold it at {{counter_price}}. Would you be comfortable moving forward?",
        "We're at the strongest price I can make available, which is {{counter_price}}. Shall we make it a deal?",
      ],
    },
    {
      percentOfMaxDiscount: 100,
      copies: [
        "I've taken the price as far as I can and {{counter_price}} is my final offer. Would you like to accept it?",
        "{{counter_price}} is genuinely the lowest I can go. If that works for you, we have a deal.",
        "This is my final and strongest offer at {{counter_price}}. I hope we can make it work for you.",
        "I've reached the best possible price at {{counter_price}}. If you're happy with that, let's go ahead.",
      ],
    },
  ],
  CAN_BE_CONVERTED: [
    TIER_1_CAN_BE_CONVERTED,
    {
      percentOfMaxDiscount: 30,
      copies: [
        "That's a little below where I can go, but I can make an offer at {{counter_price}}. Would that work for you?",
        "I'm still a little above your offer, but I can move to {{counter_price}}. Could you meet me there?",
        "I'd like to make this work. Your offer is a little low for me, but I can come down to {{counter_price}}.",
        "We're still a little apart on price, but I can make a move to {{counter_price}}. What do you think?",
      ],
    },
    {
      percentOfMaxDiscount: 55,
      copies: [
        "I can move further for you, and my offer is now {{counter_price}}. Does that bring us closer?",
        "We're making good progress. I can bring the price down to {{counter_price}}. Would that work for you?",
        "I'd like to keep this moving, so I can offer {{counter_price}}. Could we agree somewhere around there?",
        "I've come down further to {{counter_price}}. Are we getting close enough to make this work?",
      ],
    },
    {
      percentOfMaxDiscount: 75,
      copies: [
        "I've made a strong move on this and can offer {{counter_price}}. Would that work for you?",
        "We're getting quite close now. I can bring the price to {{counter_price}}. Shall we close this?",
        "I can push further to {{counter_price}}. If that works for you, I think we're nearly there.",
        "That's a significant move from my side: {{counter_price}}. Could we make a deal at that price?",
      ],
    },
    {
      percentOfMaxDiscount: 100,
      copies: [
        "I've made my strongest offer at {{counter_price}}. This is the best I can do. Would you like to accept?",
        "I've taken this as far as I can and can offer {{counter_price}}. Shall we make a deal?",
        "This is the strongest price I can offer at {{counter_price}}. Would you like to go ahead?",
        "I've made my final move to {{counter_price}}. If that works for you, we have a deal.",
      ],
    },
  ],
  MAYBE_CONVERTIBLE: [
    TIER_1_MAYBE_CONVERTIBLE,
    {
      percentOfMaxDiscount: 35,
      copies: [
        "Thanks for moving your offer. I can now come down to {{counter_price}}. Would that work for you?",
        "That brings us closer. I can offer {{counter_price}}. Could we agree there?",
        "I appreciate you coming up. I can make another move to {{counter_price}}. What do you think?",
        "We're getting closer now. I can offer {{counter_price}}. Would you like to make a deal?",
      ],
    },
    {
      percentOfMaxDiscount: 65,
      copies: [
        "I've moved the price further to {{counter_price}}. If you can come up a little more, we should be able to get close.",
        "I can make another move to {{counter_price}}. Would you be able to stretch your offer a little further?",
        "We're getting closer. I can offer {{counter_price}} if you can move your offer up a little.",
        "I'm willing to come further, but I'll need you to come up as well. My offer is {{counter_price}}.",
      ],
    },
    {
      percentOfMaxDiscount: 85,
      copies: [
        "I've made a significant move on the price and can offer {{counter_price}}. Would you take it?",
        "We're very close now. I can bring the price to {{counter_price}}. Can we make a deal?",
        "I've pushed the offer further to {{counter_price}}. Would that work for you?",
        "I can stretch further and offer {{counter_price}}. If you can meet me there, we can close this.",
      ],
    },
    // Re-proposes the same 85% position rather than jumping straight to
    // 100 - one more chance before the final round.
    {
      percentOfMaxDiscount: 85,
      copies: [
        "I've made another strong move and can hold the price at {{counter_price}}. Would you be comfortable with that?",
        "We're really close now, and {{counter_price}} is the strongest price I can offer at this stage. Could we agree there?",
        "I've pushed the price as far as I reasonably can to {{counter_price}}. Would you like to move forward?",
        "I'd really like to make this work, and {{counter_price}} is my best offer at this point. Can we close the deal?",
      ],
    },
    {
      percentOfMaxDiscount: 100,
      copies: [
        "I've reached the best price I can offer: {{counter_price}}. Would you like to accept?",
        "{{counter_price}} is the lowest price I can make available. Shall we close the deal?",
        "I've taken the price as far as I can. My best offer is {{counter_price}}. Would you like to go ahead?",
        "This is the strongest offer I can make at {{counter_price}}. If that works for you, we have a deal.",
      ],
    },
  ],
  TOO_LOW: [
    NO_PRICE_TIER_1_TOO_LOW,
    {
      percentOfMaxDiscount: 30,
      copies: [
        "Thanks for the offer. We're quite a bit apart, but I'm happy to make a first move and bring it to {{counter_price}}. Would that feel a little closer?",
        "I appreciate you making an offer. We're starting quite far apart, but I can make an initial adjustment to {{counter_price}}. What do you think?",
        "We're a little far apart to start with, but I'd like to see if we can find some middle ground. I can make a first offer of {{counter_price}}.",
        "I'd be happy to work with you on this. We're starting some distance apart, but I can make a first move to {{counter_price}}. Could we work from there?",
      ],
    },
    {
      percentOfMaxDiscount: 50,
      copies: [
        "We're still quite far apart. If you could come a little higher, I can offer {{counter_price}}.",
        "That's still a little too low for me. Could you move your offer up so we can get closer?",
        "I'd like to continue the negotiation, but I'll need you to come up a little. I can offer {{counter_price}}.",
        "We're getting closer, but I'll need a stronger offer from you. Could you come up a little more?",
      ],
    },
    {
      percentOfMaxDiscount: 70,
      copies: [
        "I've made a much stronger move on the price and can offer {{counter_price}}. Would that work for you?",
        "I've pushed the price further to {{counter_price}}. Could we meet there?",
        "We're getting very close now. I can offer {{counter_price}}. Would you like to accept?",
        "I've made another significant move to {{counter_price}}. If you can meet me there, we can close this.",
      ],
    },
    {
      // "Best deal, just for you" framing per explicit request.
      percentOfMaxDiscount: 80,
      copies: [
        "I've made a strong effort to bring this down just for you, and I can offer {{counter_price}}. Would you like to take it?",
        "I'd really like to make this work for you, so I can bring the price to {{counter_price}}. Can we close this out?",
        "I've made another move specifically to help us get closer, bringing the offer to {{counter_price}}. What do you think?",
        "I've done my best to make the numbers work for you, and {{counter_price}} is the offer I can make right now. Shall we make it a deal?",
      ],
    },
    {
      percentOfMaxDiscount: 100,
      copies: [
        "I've reached the best price I can offer at {{counter_price}}. Would you like to accept?",
        "{{counter_price}} is the lowest price I can offer. If that works for you, we can close the deal.",
        "I've taken this as far as I can. My strongest offer is {{counter_price}}. Would you like to go ahead?",
        "This is the best price I can make available at {{counter_price}}. Shall we make it a deal?",
      ],
    },
  ],
};

const ACCEPTED_COPIES = [
  "That works for me. We have a deal at {{accepted_price}}. Ready to complete your purchase?",
  "Deal! {{accepted_price}} works for me. You can go ahead and complete your order.",
  "We've got a deal at {{accepted_price}}. Your negotiated price is ready. Shall we get your order started?",
  "I'm happy to accept {{accepted_price}}. Let's make it yours.",
];

// Shown instead of ACCEPTED_COPIES when the customer's own offer was at or
// above the real listed price - see evaluateSegmentedOffer's acceptedResult:
// the price used is always capped at the real listed price, never the
// (possibly much higher) number the customer actually typed, so this copy
// says so plainly rather than pretending a "negotiation" happened.
const AT_LIST_PRICE_COPIES = [
  "That's already our listed price of {{accepted_price}} - no negotiating needed there. I can get that ready for you right away.",
  "Looks like {{accepted_price}} is already the full price - happy to lock that in for you now.",
  "You're already at our listed price of {{accepted_price}}, so there's nothing to negotiate. Let's get you checked out.",
  "That's the full price, {{accepted_price}} - I can set that up for you right now.",
];

const NO_PRICE_COPIES = [
  "I'd be happy to negotiate. What price did you have in mind?",
  "Let's see if we can find a price that works for you. What would you like to offer?",
  "I'm ready to negotiate. Send me the price you'd feel comfortable paying, and I'll see what I can do.",
  "Make me an offer when you're ready, and I'll see how close we can get.",
];

// Product suggestions, shown at most once per session, at whichever of
// these comes first (see negotiation-offer.server.ts):
// - FLOOR_HELD: the shopper keeps offering below the floor. A separate
//   bubble after the floor-held message; the conversation stays open.
// - DECLINED: the shopper clicks "No deal". Replaces the plain goodbye, so
//   the conversation ends on something they can act on, not a dead end.
// See product-suggestions.server.ts for how the products are chosen.
//
// NEAR_OFFER: real matches found under what the shopper actually offered.
const SUGGESTIONS_INTRO_COPIES = [
  "That one won't quite work at your price, but here's something that might:",
  "I can't get there on this one, but you might like these instead:",
  "This particular item can't go that low, but here's a closer fit:",
];
const DECLINE_SUGGESTIONS_INTRO_COPIES = [
  "No problem. I can't offer this one at your price, but you can explore these instead:",
  "Understood. This one can't go that low, but these might suit your budget better:",
  "That's okay. I can't do this one at that price, but take a look at these:",
];
// NEAR_ORIGINAL: nothing under their offer, so these are under the original
// price instead - said plainly rather than pretending it's a close match.
const SUGGESTIONS_FALLBACK_COPIES = [
  "I don't have anything in that exact range, but here's what's available:",
  "Nothing quite that low in this category, but take a look at these:",
  "I don't have a match for that price, but here's what's currently available:",
];
const DECLINE_SUGGESTIONS_FALLBACK_COPIES = [
  "No problem. I can't offer this one at that price, but you can explore these options:",
  "Understood. I don't have anything quite that low, but here are some other options you might like:",
  "That's okay. Nothing here goes that low, but you can explore these instead:",
];
// NONE (floor held only): truly nothing else in this product type under the
// original price - no carousel follows this one. A decline with no matches
// just uses the normal goodbye (getDeclinedMessage) instead.
const SUGGESTIONS_NONE_COPIES = [
  "I don't have anything else to offer in that range right now.",
  "Unfortunately I don't have another option in that price range at the moment.",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

// How a store-currency price is written into a message. The default is the
// plain number ("1700.00"); a shopper looking at prices in another currency
// gets them in that currency instead - see price-display.server.ts.
export type FormatPrice = (price: number) => string;

const plainPrice: FormatPrice = (price) => price.toFixed(2);

function fill(
  template: string,
  placeholder: string,
  price: number,
  formatPrice: FormatPrice,
) {
  const text = formatPrice(price);
  // A function, not the string itself, so a "$" in a formatted price
  // ("$332.30") is never read as a replacement pattern like "$3".
  return template.replace(
    new RegExp(`\\{\\{\\s*${placeholder}\\s*\\}\\}`, "g"),
    () => text,
  );
}

// The very first bot messages, sent before any offer exists - not tied to
// any segment (that's not known yet), so it's just its own rotation. Always
// TWO messages (see GREETING_COPIES) - the caller sends them as two separate
// bot chat bubbles, not one message with a line break.
export function getGreetingMessage(): [string, string] {
  return pick(GREETING_COPIES);
}

// The merchant's own first message if they've set an initial message on the
// rule, otherwise one of the built-in greetings above. Each entry is one chat
// bubble. The sub message is optional, and only ever shown after an initial
// message (the Rules page rejects a sub message without one).
export function getGreetingLines(
  rule: { initialMessage: string | null; subMessage: string | null } | null,
): string[] {
  const initial = rule?.initialMessage?.trim();
  if (!initial) return getGreetingMessage();
  const sub = rule?.subMessage?.trim();
  return sub ? [initial, sub] : [initial];
}

export function getNoPriceMessage() {
  return pick(NO_PRICE_COPIES);
}

// The bubble that introduces a set of suggestions, by when they're shown and
// which search pass found them. Returns null only for a decline that found
// nothing - the caller then sends the normal goodbye with no carousel.
export function getSuggestionsMessage(
  moment: "floor_held" | "declined",
  match: "near_offer" | "near_original" | "none",
): string | null {
  if (moment === "declined") {
    if (match === "near_offer") return pick(DECLINE_SUGGESTIONS_INTRO_COPIES);
    if (match === "near_original") return pick(DECLINE_SUGGESTIONS_FALLBACK_COPIES);
    return null;
  }
  if (match === "near_offer") return pick(SUGGESTIONS_INTRO_COPIES);
  if (match === "near_original") return pick(SUGGESTIONS_FALLBACK_COPIES);
  return pick(SUGGESTIONS_NONE_COPIES);
}

export function getAcceptedMessage(
  price: number,
  formatPrice: FormatPrice = plainPrice,
) {
  return fill(pick(ACCEPTED_COPIES), "accepted_price", price, formatPrice);
}

export function getAcceptedAtListPriceMessage(
  price: number,
  formatPrice: FormatPrice = plainPrice,
) {
  return fill(pick(AT_LIST_PRICE_COPIES), "accepted_price", price, formatPrice);
}

// Classifies on the customer's first valid offer only - never called again
// for the same session. D = max discount amount (list price's worth of the
// max discount %, in currency units, not a percentage). Bands are multiples
// of D below the floor: within 1D = easy, 1D-3D = can be converted, 3D-4D =
// maybe convertible, beyond 4D = too low. Offers at/above the floor never
// reach this - that's an instant accept, checked before classification.
export function classifySegment(
  offerPrice: number,
  floorPrice: number,
  maxDiscountAmount: number,
): CustomerSegment {
  const belowFloor = floorPrice - offerPrice;
  if (belowFloor <= 1 * maxDiscountAmount) return "EASY_TO_CONVERT";
  if (belowFloor <= 3 * maxDiscountAmount) return "CAN_BE_CONVERTED";
  if (belowFloor <= 4 * maxDiscountAmount) return "MAYBE_CONVERTIBLE";
  return "TOO_LOW";
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// The actual bug fix: an offer high enough to accept was previously accepted
// AT WHATEVER NUMBER THE CUSTOMER TYPED, with no ceiling check against the
// real listed price - a customer typing far more than the item costs (a
// typo, a stray number, anything) got a draft order created at that inflated
// number. Capped here at startingPrice instead, with a flag so the caller
// can use different, honest copy for that case rather than pretending a
// negotiation happened.
function acceptedResult(
  visitorOfferPrice: number,
  startingPrice: number,
): { outcome: "ACCEPTED"; price: number; atOrAboveListPrice: boolean } {
  if (visitorOfferPrice >= startingPrice) {
    return {
      outcome: "ACCEPTED",
      price: round2(startingPrice),
      atOrAboveListPrice: true,
    };
  }
  return {
    outcome: "ACCEPTED",
    price: round2(visitorOfferPrice),
    atOrAboveListPrice: false,
  };
}

export type SegmentedEvaluation =
  // atOrAboveListPrice: true when the customer's own typed number was at or
  // above the real listed price - price is then capped at the listed price
  // itself, never the (possibly much higher) number they actually typed. See
  // acceptedResult below.
  | { outcome: "ACCEPTED"; price: number; atOrAboveListPrice: boolean }
  // Only reachable at tier 1 of Too-Low (see the noPrice flag on Tier) -
  // a conversational nudge with no price attached at all, nothing to log
  // as an offer or show as a current price yet.
  | { outcome: "ASK_FOR_MORE"; round: number; message: string }
  | {
      outcome: "COUNTERED";
      price: number;
      round: number;
      isFinalTier: boolean;
      message: string;
    }
  | { outcome: "FLOOR_HELD"; price: number; message: string };

// The core per-message decision once a segment is already assigned. Pure
// function - no I/O - same reasoning as the old evaluateOffer had: easy to
// reason about and test in isolation.
export function evaluateSegmentedOffer(
  segment: CustomerSegment,
  startingPrice: number,
  maxDiscountPercent: number,
  floorPriceOverride: number | null,
  currentRound: number,
  visitorOfferPrice: number,
  formatPrice: FormatPrice = plainPrice,
): SegmentedEvaluation {
  const percentFloor = startingPrice * (1 - maxDiscountPercent / 100);
  const floorPrice =
    floorPriceOverride !== null
      ? Math.max(percentFloor, floorPriceOverride)
      : percentFloor;

  // Anything at or above the floor is accepted immediately, at any round,
  // in any segment - never negotiated further. See the module comment.
  if (visitorOfferPrice >= floorPrice) {
    return acceptedResult(visitorOfferPrice, startingPrice);
  }

  const tierTable = SEGMENT_TIERS[segment];
  const nextRound = currentRound + 1;
  const tier = tierTable[Math.min(nextRound, tierTable.length) - 1];

  if (tier.noPrice) {
    // Only ever true for tier 1 of Too-Low - always advances the round,
    // never repeats (no-price tiers only ever sit at position 1 in a
    // table, so currentRound can't already be past one here).
    return { outcome: "ASK_FOR_MORE", round: nextRound, message: pick(tier.copies) };
  }

  const maxDiscountAmount = startingPrice * (maxDiscountPercent / 100);
  const rawCounter =
    startingPrice - (tier.percentOfMaxDiscount / 100) * maxDiscountAmount;
  const counterPrice = round2(Math.max(rawCounter, floorPrice));

  if (visitorOfferPrice >= counterPrice) {
    return acceptedResult(visitorOfferPrice, startingPrice);
  }

  const isFinalTier = nextRound >= tierTable.length;
  if (currentRound >= tierTable.length) {
    // Already sat at the final tier and the visitor countered again -
    // idempotent hold, same as the old ladder's FLOOR_REACHED behavior.
    return {
      outcome: "FLOOR_HELD",
      price: counterPrice,
      message: fill(pick(tier.copies), "counter_price", counterPrice, formatPrice),
    };
  }

  return {
    outcome: "COUNTERED",
    price: counterPrice,
    round: nextRound,
    isFinalTier,
    message: fill(pick(tier.copies), "counter_price", counterPrice, formatPrice),
  };
}
