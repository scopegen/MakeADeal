import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";

// Scopegen Negotiator - storefront widget, React build.
//
// Scope of this slice, stated plainly (same as before):
//   - Always-on button trigger only. Dwell-time, exit-intent, page-revisit,
//     and cohort/email aren't wired yet, even though the engine's schema
//     and settings UI already support them.
//   - Product pages only - the non-product-page qualifying-chat flow was
//     deliberately deferred.
//   - No persistence: reloading the page loses the in-progress
//     conversation. The anonymous visitor ID does persist (localStorage).
//
// Visual approach: structural/animation CSS lives in one injected
// <style> tag (STYLESHEET below, scoped by an "sgn-" class prefix) so real
// hover/focus/keyframe support exists - inline styles alone can't do that.
// The accent color is a CSS custom property (--sgn-accent/--sgn-accent-
// hover) with a midnight-blue default baked into the stylesheet itself,
// overridden at runtime once the rule's config loads (see the useEffect
// in ChatWidget) - this lets one static injected stylesheet still reflect
// a per-rule merchant color without re-injecting CSS per negotiation.
// Per-rule merchant settings: bot name (headerTitle), launcher button
// text, and this accent color - see the Rules admin page. Send/Accept/
// Decline button text stay fixed, out of scope for merchant customization.
//
// Price extraction: the offer input is free text, not a number field - a
// visitor can type "I'll pay 500 for it" and the price is pulled out via
// pattern matching (see extractPrice), not an AI call. Deliberate
// cost/latency tradeoff, not an accuracy ceiling we're pretending doesn't
// exist - ambiguous phrasing ("around 400-450") won't parse.

type Message = {
  id: string;
  role: "bot" | "customer" | "system";
  text: string;
  time: string;
  // Only ever set on a bot message: this is the bot's final offer (either
  // the segment's final tier, or a repeat hold at the floor) - Deal/No deal
  // render inline below this specific message, not any earlier counter.
  isFinalOffer?: boolean;
};

type SessionStatus =
  | "idle"
  | "active"
  | "accepted"
  | "declined"
  | "expired"
  | "rate_limited"
  | "error";

// The merchant-configurable pieces - see the file header comment for what's
// still fixed.
type WidgetConfig = {
  headerTitle: string | null;
  launcherButtonText: string | null;
  primaryColor: string | null;
  // null/absent = the merchant hasn't turned auto-open on.
  autoOpen?: { delaySeconds: number } | null;
};

// What /offer (and the `offer` embedded in /start's response for a shopper's
// first message) sends back.
type OfferResponse = {
  status?: string;
  error?: string;
  message?: string;
  price?: number;
  checkoutUrl?: string;
  finalTier?: boolean;
  floorReached?: boolean;
};

// Normally the greeting comes from /eligibility (see proxy.eligibility.tsx),
// so opening the panel doesn't need a server round trip or create anything.
// This is only used if that response has none, e.g. a widget already
// deployed against a backend that doesn't send one yet.
const FALLBACK_GREETING: string[] = [
  "Hello! I'm your sales buddy. I'll do my best to get you a great deal.",
  "What price did you have in mind?",
];

const LAUNCHER_TEXT = "Make an offer";
const SEND_BUTTON_TEXT = "Send";
const ACCEPT_BUTTON_TEXT = "Deal";
const DECLINE_BUTTON_TEXT = "No deal";

const ANON_ID_KEY = "scopegenNegoAnonId";
const STYLE_TAG_ID = "sgn-negotiation-widget-styles";

function getAnonymousId() {
  try {
    const existing = window.localStorage.getItem(ANON_ID_KEY);
    if (existing) return existing;
    const fresh =
      "anon_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2);
    window.localStorage.setItem(ANON_ID_KEY, fresh);
    return fresh;
  } catch {
    return "anon_" + Date.now().toString(36);
  }
}

// Pattern-matching price extraction - the first number-looking sequence in
// the text wins. Handles "$500", "500", "Rs 1,500", "pay 500 for it",
// "500.50". Does not understand ranges, "half price", or other genuinely
// ambiguous phrasing - see the file header comment on why that tradeoff
// was made deliberately.
function extractPrice(text: string): number | null {
  const match = text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/);
  if (!match) return null;
  const cleaned = match[0].replace(/,/g, "");
  const value = parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Reads whichever variant is CURRENTLY selected on the page, right at the
// moment it's called - not tracked continuously, since all that matters is
// the variant actually in play right when a negotiation starts (replaces
// the v1 "always the product's first variant" limitation noted in
// negotiation-engine.server.ts). Relies on Shopify's own documented
// product-form convention, a form field named "id" holding the variant
// (confirmed via shopify.dev's theme docs) - covers Dawn and the large
// majority of Online Store 2.0 themes. Falls back to whichever variant was
// selected at page load (read from Liquid) if that field can't be found,
// e.g. on a theme that doesn't follow the convention - same behavior as
// before this existed, not a regression for that case.
function readSelectedVariantId(fallback: string | null): string | null {
  const field = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    'form[action*="/cart/add"] [name="id"]',
  );
  const rawId = field?.value;
  return rawId ? `gid://shopify/ProductVariant/${rawId}` : fallback;
}

// Darkens a hex color by a fixed percentage per channel, for the hover
// shade of a merchant-chosen accent color - same relationship the fixed
// midnight-blue default already had (#191970 -> #12124f, roughly a 22%
// reduction per channel). Falls back to the input unchanged if it isn't a
// valid 6-digit hex, so a malformed merchant value never throws.
function darkenColor(hex: string, amount = 0.22): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return hex;
  const num = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const value = (num >> shift) & 0xff;
    return Math.max(0, Math.round(value * (1 - amount)));
  };
  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(channel(16))}${toHex(channel(8))}${toHex(channel(0))}`;
}

// Applies a merchant's chosen accent color at runtime by overriding the
// CSS custom properties the injected STYLESHEET reads - see the file
// header comment. No-ops (keeps the stylesheet's own midnight-blue
// default) when the rule hasn't set one.
function setAccentColor(primaryColor: string | null | undefined) {
  if (!primaryColor) return;
  document.documentElement.style.setProperty("--sgn-accent", primaryColor);
  document.documentElement.style.setProperty(
    "--sgn-accent-hover",
    darkenColor(primaryColor),
  );
}

function formatTime(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// A message's whole meta line (sender label + time) only repeats when the
// minute actually changes from the last message that showed one -
// back-to-back messages landing in the same minute (e.g. the two-part
// greeting) show no meta line at all, not even a repeated name with no
// time. System messages never show meta, so they're skipped when looking
// back for the last shown time rather than resetting it. Pure lookback (no
// mutated state) so it's safe to call during render.
function shouldShowTime(messages: Message[], i: number) {
  for (let j = i - 1; j >= 0; j--) {
    if (messages[j].role !== "system") {
      return messages[j].time !== messages[i].time;
    }
  }
  return true;
}

function ChatIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 4h16v12H7l-3 3V4z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Price tag + sparkle marks, shown once in the congratulations banner on
// acceptance - see showDiscountPercent below for why it only ever renders
// with a real, computed discount, never a placeholder.
function TagIcon() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="sgn-tag-icon"
    >
      <path
        d="M11.5 3.5h5A2 2 0 0 1 18.5 5.5v5a2 2 0 0 1-.586 1.414l-7 7a2 2 0 0 1-2.828 0l-5-5a2 2 0 0 1 0-2.828l7-7A2 2 0 0 1 11.5 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="14.75" cy="8.25" r="1.25" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M4 4l1.4 1.4" />
        <path d="M2.5 9h2" />
        <path d="M6 2.5v2" />
        <path d="M20.5 15.5l1.2 1.2" />
        <path d="M21.5 20h-2" />
      </g>
    </svg>
  );
}

function ChatWidget({
  productId,
  initialVariantId,
}: {
  productId: string;
  initialVariantId: string | null;
}) {
  const [eligible, setEligible] = useState(false);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  // Whether there's a standing bot offer the customer can accept right now
  // - separate from the final-tier-only inline Deal/No deal buttons, this
  // gates a persistent Accept button beside Send so the customer never has
  // to wait for the final offer if they're happy sooner.
  const [hasOffer, setHasOffer] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  // Both only needed to compute the congratulations banner's discount
  // percentage once accepted - startingPrice comes back from /start but was
  // otherwise unused until now.
  const [startingPrice, setStartingPrice] = useState<number | null>(null);
  const [acceptedPrice, setAcceptedPrice] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const greetingRef = useRef<string[]>(FALLBACK_GREETING);
  const greetingShownRef = useRef(false);
  // Set once the shopper has opened or closed the panel themselves, so a
  // pending auto-open timer never reopens something they just closed.
  const manualRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams({ productId });
    if (initialVariantId) params.set("variantId", initialVariantId);
    fetch("/apps/negotiate/eligibility?" + params.toString())
      .then((res) => res.json())
      .then((data) => {
        setEligible(Boolean(data && data.eligible));
        if (data && data.config) {
          setConfig(data.config);
          setAccentColor(data.config.primaryColor);
        }
        // One or two bubbles: our built-in greetings are two, a merchant's
        // own first message may be just the initial message on its own.
        if (
          data &&
          Array.isArray(data.greeting) &&
          data.greeting.length >= 1 &&
          data.greeting.length <= 2 &&
          data.greeting.every(
            (line: unknown) => typeof line === "string" && line.length > 0,
          )
        ) {
          greetingRef.current = data.greeting;
        }
      })
      .catch(() => setEligible(false));
  }, [productId, initialVariantId]);

  // Opening the panel (by click or automatically) only shows it and the
  // greeting - it deliberately creates nothing on the server. A negotiation
  // is only created when the shopper sends their first message (see
  // startSessionWithMessage). Uses only refs and state setters so it stays
  // stable across renders.
  const openPanel = useCallback(() => {
    setOpen(true);
    if (greetingShownRef.current) return;
    greetingShownRef.current = true;
    const lines = greetingRef.current;
    setMessages((prev) => [
      ...prev,
      ...lines.map(
        (text): Message => ({
          id: Math.random().toString(36).slice(2),
          role: "bot",
          text,
          time: formatTime(new Date()),
        }),
      ),
    ]);
  }, []);

  const autoOpen = config?.autoOpen ?? null;
  useEffect(() => {
    if (!eligible || !autoOpen) return;
    // Once per product per browser session: closing it, or refreshing the
    // page, doesn't bring it back. If storage is blocked we still auto-open,
    // we just can't remember that we did.
    const storageKey = `sgnAutoOpened:${productId}`;
    try {
      if (sessionStorage.getItem(storageKey)) return;
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      if (manualRef.current) return;
      try {
        sessionStorage.setItem(storageKey, "1");
      } catch {
        // ignore
      }
      openPanel();
    }, autoOpen.delaySeconds * 1000);
    return () => clearTimeout(timer);
  }, [eligible, autoOpen, productId, openPanel]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Disabling the input while a message is in flight (below) kicks keyboard
  // focus out of it - that's just how disabled form elements work in every
  // browser - and re-enabling it afterward doesn't bring focus back on its
  // own. Without this, every single message sent means clicking the input
  // again before the next one can be typed. Runs whenever sending flips back
  // to false; harmless no-op via the ref when the input isn't even rendered
  // yet (before the panel's first response arrives) or not rendered at all
  // (status isn't "active").
  useEffect(() => {
    if (!sending) inputRef.current?.focus();
  }, [sending]);

  const headerTitle = config?.headerTitle || "Negotiate";

  function addMessage(
    role: Message["role"],
    text: string,
    isFinalOffer?: boolean,
  ) {
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        role,
        text,
        time: formatTime(new Date()),
        isFinalOffer,
      },
    ]);
  }

  // The shopper's first message: creates the negotiation and handles that
  // message in ONE request (see proxy.start.tsx), so the first reply isn't
  // slower than later ones. The variant is read right now, at the moment
  // they actually send something - not when the panel opened - so switching
  // size/colour before typing is picked up.
  async function startSessionWithMessage(price: number | null) {
    setSending(true);
    try {
      const fd = new FormData();
      fd.set("productId", productId);
      fd.set("triggerType", "ALWAYS_ON");
      fd.set("anonymousId", getAnonymousId());
      const variantId = readSelectedVariantId(initialVariantId);
      if (variantId) fd.set("variantId", variantId);
      fd.set("firstAction", "counter");
      if (price != null) fd.set("offerPrice", String(price));
      const res = await fetch("/apps/negotiate/start", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (data && data.sessionId) {
        sessionIdRef.current = data.sessionId;
        setStatus("active");
        if (typeof data.startingPrice === "number") {
          setStartingPrice(data.startingPrice);
        }
        if (data.offer) {
          applyOfferResponse(data.offer);
        } else {
          // A backend that doesn't take a first message on /start yet:
          // the session exists now, so send the message the usual way.
          await sendAction("counter", price ?? undefined);
        }
      } else if (data && data.error === "rate_limited") {
        setStatus("rate_limited");
        addMessage("system", data.message);
      } else {
        // Status stays "idle" on purpose so the input stays usable - e.g.
        // the variant they picked is out of stock, and choosing another
        // one and sending again is a perfectly good retry.
        addMessage(
          "system",
          (data && data.message) || "Couldn't start a negotiation right now.",
        );
      }
    } catch {
      addMessage("system", "Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
  }

  // Shared by every reply to a shopper message: /offer's response, and the
  // `offer` embedded in /start's response for their first message.
  function applyOfferResponse(data: OfferResponse) {
    if (data.status === "ACCEPTED") {
      setStatus("accepted");
      setCheckoutUrl(data.checkoutUrl ?? null);
      if (typeof data.price === "number") setAcceptedPrice(data.price);
      addMessage("bot", data.message ?? "");
      return;
    }
    if (data.status === "DECLINED") {
      setStatus("declined");
      addMessage("bot", data.message ?? "");
      return;
    }
    if (data.status === "EXPIRED") {
      setStatus("expired");
      addMessage("system", data.message ?? "");
      return;
    }
    if (data.error === "rate_limited") {
      setStatus("rate_limited");
      addMessage("system", data.message ?? "");
      return;
    }
    if (data.error) {
      // eslint-disable-next-line no-console
      console.error("[Scopegen Negotiator] offer failed:", data);
      addMessage("system", "Something went wrong — please try again.");
      return;
    }
    // finalTier: this round's counter IS the segment's final tier.
    // floorReached: the segment was already at its final tier and the
    // visitor countered again - both mean "show Deal/No deal now".
    const isFinalOffer = Boolean(data.finalTier) || Boolean(data.floorReached);
    // A "no price found" nudge or the ASK_FOR_MORE tier both come back
    // with no price at all - nothing to accept yet in either case.
    setHasOffer(data.price != null);
    addMessage("bot", data.message ?? "", isFinalOffer);
  }

  async function sendAction(
    action: "counter" | "accept" | "decline",
    offerPrice?: number,
  ) {
    if (!sessionIdRef.current) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.set("sessionId", sessionIdRef.current);
      fd.set("action", action);
      if (offerPrice != null) fd.set("offerPrice", String(offerPrice));
      const res = await fetch("/apps/negotiate/offer", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      applyOfferResponse(data);
    } catch {
      addMessage("system", "Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
  }

  function handleOpen() {
    manualRef.current = true;
    openPanel();
    // Focus used to land in the input on its own once the greeting finished
    // loading from the server. Nothing loads on open now, so do it directly -
    // for a click only: doing it on an automatic open would grab focus from
    // the page (and pop the keyboard up on phones).
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleClose() {
    manualRef.current = true;
    setOpen(false);
  }

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    // No client-side block on missing/unparseable prices - a reply like
    // "hi" or "maybe a bit less" still gets sent through. The server
    // decides what to do when it can't find a price (a conversational
    // nudge, not an error) - see negotiation-tiers.server.ts's
    // getNoPriceMessage. Extraction here is just to fill offerPrice when
    // there IS one; undefined when there isn't lets the server's own
    // "no price found" branch run.
    const price = extractPrice(trimmed);
    addMessage("customer", trimmed);
    setInput("");
    // No session yet means this is their first message - see
    // startSessionWithMessage.
    if (sessionIdRef.current) sendAction("counter", price ?? undefined);
    else startSessionWithMessage(price);
  }

  if (!eligible) return null;

  // "idle" is the state before the shopper's first message: the panel is
  // open and showing the greeting, but no negotiation exists yet.
  const showInput = status === "idle" || status === "active";
  // Deal/No deal only ever show attached to the bot's final-tier offer, not
  // any earlier counter - and only for as long as that's still the latest
  // message (a customer typing a new counter after it moves the
  // conversation on, hiding these until the next final-offer message, if
  // any, arrives).
  const lastMessage = messages[messages.length - 1];
  const showDealButtons =
    status === "active" &&
    lastMessage?.role === "bot" &&
    lastMessage.isFinalOffer === true;

  // Rounded to the nearest whole percent for the congratulations banner -
  // null (never 0 or a placeholder) whenever either price is missing, so
  // the banner simply doesn't render rather than showing a wrong number.
  const discountPercent =
    startingPrice && acceptedPrice != null && startingPrice > 0
      ? Math.round(((startingPrice - acceptedPrice) / startingPrice) * 100)
      : null;

  // Rendered unconditionally, not just when closed - the launcher lives
  // inline in the merchant's product template now (it's a real page
  // element, not a floating trigger sharing the panel's corner), so
  // hiding it on open would leave a jarring empty gap where a button used
  // to be. The panel opens as an overlay ON TOP of it below, not instead
  // of it. handleOpen is safe to call again while already open (setOpen
  // is a no-op if already true, and the greeting is only ever added once),
  // so leaving this clickable the whole time is harmless.
  const launcher = (
    <button type="button" onClick={handleOpen} className="sgn-launcher">
      <ChatIcon />
      {config?.launcherButtonText || LAUNCHER_TEXT}
    </button>
  );

  if (!open) {
    return launcher;
  }

  return (
    <>
      {launcher}
      {/* Portaled straight to document.body, not rendered in place - the
      panel is position: fixed and needs to stay anchored to the real
      viewport. Now that the launcher (and this mount point) lives inline
      inside the merchant's product template instead of body-injected,
      any ancestor in the theme's own markup with a CSS transform/filter/
      perspective/contain would silently turn position: fixed into "fixed
      relative to that ancestor" instead of the viewport - a real, common
      thing themes do (sliders, sticky sections, animations). The portal
      sidesteps that entirely: this DOM subtree's parent is always
      document.body itself, regardless of where in the page the block was
      dropped. */}
      {createPortal(
    <div className="sgn-panel">
      <div className="sgn-header">
        <div className="sgn-header-title">{headerTitle}</div>
        <button
          type="button"
          onClick={handleClose}
          className="sgn-close-btn"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div ref={scrollRef} className="sgn-message-list">
        {messages.map((m, i) => {
          const showTime = m.role !== "system" && shouldShowTime(messages, i);
          return (
            <div key={m.id} className={`sgn-message-row sgn-row-${m.role}`}>
              {showTime && (
                <div className="sgn-message-meta">
                  {m.role === "customer" ? "You" : headerTitle} · {m.time}
                </div>
              )}
              <div
                className={
                  m.role === "system"
                    ? "sgn-bubble sgn-bubble-system"
                    : m.role === "customer"
                      ? "sgn-bubble sgn-bubble-customer"
                      : "sgn-bubble sgn-bubble-bot"
                }
              >
                {m.text}
              </div>
              {/* Attached to whichever message is CURRENTLY the latest final
                offer - i === messages.length - 1 keeps this from also
                showing under an earlier final offer once the conversation
                has moved past it. */}
              {showDealButtons && i === messages.length - 1 && (
                <div className="sgn-action-row">
                  <button
                    type="button"
                    onClick={() => sendAction("accept")}
                    disabled={sending}
                    className="sgn-btn"
                  >
                    {ACCEPT_BUTTON_TEXT}
                  </button>
                  <button
                    type="button"
                    onClick={() => sendAction("decline")}
                    disabled={sending}
                    className="sgn-btn-secondary"
                  >
                    {DECLINE_BUTTON_TEXT}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {sending && (
          <div className="sgn-bubble sgn-bubble-bot sgn-typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
      </div>

      {status === "accepted" && discountPercent !== null && discountPercent > 0 && (
        <div className="sgn-congrats">
          <TagIcon />
          <p className="sgn-congrats-text">
            You got a <span className="sgn-congrats-badge">{discountPercent}%</span>{" "}
            discount!
          </p>
        </div>
      )}

      {checkoutUrl && (
        <a
          href={checkoutUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="sgn-checkout-link"
        >
          Complete checkout
        </a>
      )}

      {showInput && (
        <div className="sgn-footer">
          <div className="sgn-input-row">
            <input
              ref={inputRef}
              type="text"
              placeholder="Type your offer…"
              value={input}
              disabled={sending}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              className="sgn-input"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sending}
              className="sgn-btn"
            >
              {SEND_BUTTON_TEXT}
            </button>
            {hasOffer && (
              <button
                type="button"
                onClick={() => sendAction("accept")}
                disabled={sending}
                className="sgn-btn"
              >
                {ACCEPT_BUTTON_TEXT}
              </button>
            )}
          </div>
        </div>
      )}
    </div>,
        document.body,
      )}
    </>
  );
}

// Default accent color (midnight blue) - used whenever a rule doesn't set
// its own primaryColor. Referenced only to compute the hover shade below;
// the stylesheet itself reads the CSS custom properties, not these
// directly, so a merchant's color can override them at runtime without
// re-injecting CSS. See setAccentColor and the file header comment.
const DEFAULT_ACCENT = "#191970";
const DEFAULT_ACCENT_HOVER = "#12124f";

const STYLESHEET = `
:root {
  --sgn-accent: ${DEFAULT_ACCENT};
  --sgn-accent-hover: ${DEFAULT_ACCENT_HOVER};
}
.sgn-launcher, .sgn-panel, .sgn-panel * {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-sizing: border-box;
}
.sgn-launcher {
  /* Was: position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
     Commented out rather than deleted for a fast rollback - this is going
     straight to production with no staging environment. That fixed
     positioning made sense when this rendered from an app EMBED
     (target: body, floating on every page); now it's a regular app BLOCK
     (target: section) the merchant places inline in their product
     template themselves, so the launcher should flow in the page
     normally instead of floating over it. The chat panel below
     (.sgn-panel) is untouched and still position: fixed - the overlay
     that opens on click stays a floating overlay, only the launcher
     trigger itself moved inline. */
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; padding: 14px 22px; border-radius: 999px; border: none;
  background: var(--sgn-accent); color: #fff; font-size: 14px; font-weight: 600;
  cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.12);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.sgn-launcher:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 28px rgba(0,0,0,0.22), 0 3px 8px rgba(0,0,0,0.15);
}
.sgn-panel {
  position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
  width: 340px; max-height: 480px; display: flex; flex-direction: column;
  border-radius: 18px; background: #fff; color: #111;
  box-shadow: 0 16px 48px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.12);
  overflow: hidden; animation: sgn-panel-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes sgn-panel-in {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.sgn-header {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 16px; background: var(--sgn-accent); color: #fff;
}
.sgn-header-title { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.sgn-close-btn {
  background: rgba(255,255,255,0.15); border: none; color: #fff;
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer; flex-shrink: 0;
  font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center;
  transition: background 0.15s ease;
}
.sgn-close-btn:hover { background: rgba(255,255,255,0.3); }
.sgn-message-list {
  flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px;
  background: #fafafa; scrollbar-width: thin;
}
.sgn-message-list::-webkit-scrollbar { width: 6px; }
.sgn-message-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 3px; }
.sgn-message-row { display: flex; flex-direction: column; max-width: 100%; }
.sgn-row-customer { align-items: flex-end; }
.sgn-row-bot { align-items: flex-start; }
.sgn-row-system { align-items: center; }
.sgn-message-meta { font-size: 11px; color: #9aa0a6; margin-bottom: 3px; padding: 0 2px; }
.sgn-bubble {
  max-width: 82%; padding: 10px 14px; border-radius: 16px; line-height: 1.45;
  word-break: break-word; font-size: 13.5px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  animation: sgn-bubble-in 0.18s ease;
}
@keyframes sgn-bubble-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.sgn-bubble-bot { background: #f0f1f3; color: #111; border-bottom-left-radius: 4px; }
.sgn-bubble-customer { background: var(--sgn-accent); color: #fff; border-bottom-right-radius: 4px; }
.sgn-bubble-system {
  background: transparent; color: #9aa0a6; font-size: 12px; font-style: italic;
  box-shadow: none; max-width: 100%; text-align: center;
}
.sgn-typing { display: inline-flex; gap: 4px; padding: 12px 14px; }
.sgn-typing span {
  width: 6px; height: 6px; border-radius: 50%; background: #999; display: inline-block;
  animation: sgn-typing-bounce 1.2s infinite ease-in-out;
}
.sgn-typing span:nth-child(2) { animation-delay: 0.15s; }
.sgn-typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes sgn-typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}
.sgn-congrats {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  margin: 4px 16px 16px; padding: 18px 16px 16px; text-align: center;
  animation: sgn-congrats-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes sgn-congrats-in {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}
.sgn-tag-icon { color: var(--sgn-accent); }
.sgn-congrats-text { margin: 0; font-size: 14px; color: #333; font-weight: 500; }
.sgn-congrats-badge {
  display: inline-block; padding: 2px 10px; border-radius: 999px;
  background: var(--sgn-accent); color: #fff; font-weight: 700;
}
.sgn-checkout-link {
  display: block; text-align: center; margin: 0 16px 16px; padding: 12px;
  border-radius: 999px; background: var(--sgn-accent); color: #fff; text-decoration: none;
  font-weight: 700; font-size: 13.5px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  transition: transform 0.12s ease;
}
.sgn-checkout-link:hover { transform: translateY(-1px); }
.sgn-footer { border-top: 1px solid #eee; padding: 12px 16px 16px; }
.sgn-input-row { display: flex; gap: 8px; }
.sgn-input {
  flex: 1; min-width: 0; padding: 10px 14px; border: 1.5px solid #e5e5e5;
  border-radius: 999px; font-size: 13.5px; outline: none; transition: border-color 0.15s ease;
}
.sgn-input:focus { border-color: var(--sgn-accent); }
.sgn-action-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.sgn-btn {
  padding: 9px 16px; border: none; border-radius: 999px; background: var(--sgn-accent);
  color: #fff; cursor: pointer; font-size: 13px; font-weight: 600;
  transition: transform 0.12s ease, background 0.12s ease;
}
.sgn-btn:hover:not(:disabled) { transform: translateY(-1px); background: var(--sgn-accent-hover); }
.sgn-btn:disabled { opacity: 0.6; cursor: default; }
.sgn-btn-secondary {
  padding: 9px 16px; border: 1.5px solid #e0e0e0; border-radius: 999px; background: #fff;
  color: #333; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.12s ease;
}
.sgn-btn-secondary:hover:not(:disabled) { background: #f5f5f5; }
.sgn-btn-secondary:disabled { opacity: 0.6; cursor: default; }
`;

function injectStylesheet() {
  if (document.getElementById(STYLE_TAG_ID)) return;
  const styleEl = document.createElement("style");
  styleEl.id = STYLE_TAG_ID;
  styleEl.textContent = STYLESHEET;
  document.head.appendChild(styleEl);
}

function bootstrap() {
  const mount = document.getElementById("scopegen-nego-widget");
  if (!mount) return;
  const pageType = mount.dataset.pageType;
  const productId = mount.dataset.productId;
  if (pageType !== "product" || !productId) return;

  injectStylesheet();
  const root = createRoot(mount);
  root.render(
    <ChatWidget
      productId={productId}
      initialVariantId={mount.dataset.variantId ?? null}
    />,
  );
}

bootstrap();
