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
    "Hi! I'm sure you have a price in mind.",
    "Share it with me, and let's see if we can find something that works for both of us.",
  ],
  [
    "Hello! If you have a price you'd feel comfortable paying, I'd be happy to hear it.",
    "Let's see if we can meet somewhere that works for you.",
  ],
  [
    "Hi there! I'd love to hear what price you had in mind.",
    "Send me your offer, and I'll see what I can do from my side.",
  ],
  [
    "Hello! Everyone has a number they feel comfortable with.",
    "Share yours, and let's see how close we can get.",
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

const NO_PRICE_COPIES = [
  "I'd be happy to negotiate. What price did you have in mind?",
  "Let's see if we can find a price that works for you. What would you like to offer?",
  "I'm ready to negotiate. Send me the price you'd feel comfortable paying, and I'll see what I can do.",
  "Make me an offer when you're ready, and I'll see how close we can get.",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function fill(template: string, placeholder: string, price: number) {
  return template.replace(
    new RegExp(`\\{\\{\\s*${placeholder}\\s*\\}\\}`, "g"),
    price.toFixed(2),
  );
}

// The very first bot messages, sent before any offer exists - not tied to
// any segment (that's not known yet), so it's just its own rotation. Always
// TWO messages (see GREETING_COPIES) - the caller sends them as two separate
// bot chat bubbles, not one message with a line break.
export function getGreetingMessage(): [string, string] {
  return pick(GREETING_COPIES);
}

export function getNoPriceMessage() {
  return pick(NO_PRICE_COPIES);
}

export function getAcceptedMessage(price: number) {
  return fill(pick(ACCEPTED_COPIES), "accepted_price", price);
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

export type SegmentedEvaluation =
  | { outcome: "ACCEPTED"; price: number }
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
): SegmentedEvaluation {
  const percentFloor = startingPrice * (1 - maxDiscountPercent / 100);
  const floorPrice =
    floorPriceOverride !== null
      ? Math.max(percentFloor, floorPriceOverride)
      : percentFloor;

  // Anything at or above the floor is accepted immediately, at any round,
  // in any segment - never negotiated further. See the module comment.
  if (visitorOfferPrice >= floorPrice) {
    return { outcome: "ACCEPTED", price: round2(visitorOfferPrice) };
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
    return { outcome: "ACCEPTED", price: round2(visitorOfferPrice) };
  }

  const isFinalTier = nextRound >= tierTable.length;
  if (currentRound >= tierTable.length) {
    // Already sat at the final tier and the visitor countered again -
    // idempotent hold, same as the old ladder's FLOOR_REACHED behavior.
    return {
      outcome: "FLOOR_HELD",
      price: counterPrice,
      message: fill(pick(tier.copies), "counter_price", counterPrice),
    };
  }

  return {
    outcome: "COUNTERED",
    price: counterPrice,
    round: nextRound,
    isFinalTier,
    message: fill(pick(tier.copies), "counter_price", counterPrice),
  };
}
