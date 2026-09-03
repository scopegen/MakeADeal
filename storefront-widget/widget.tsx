import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

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
// Deliberately not merchant-customizable: one fixed blue accent color and
// fixed button/header copy throughout, everywhere. The only thing a
// merchant configures is the bot's name (headerTitle) - see the Rules
// admin page.
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

// The only merchant-configurable thing left - everything else about the
// widget's look and copy is fixed (see the file header comment).
type WidgetConfig = {
  headerTitle: string | null;
};

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

function ChatWidget({ productId }: { productId: string }) {
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
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(
      "/apps/negotiate/eligibility?productId=" + encodeURIComponent(productId),
    )
      .then((res) => res.json())
      .then((data) => {
        setEligible(Boolean(data && data.eligible));
        if (data && data.config) setConfig(data.config);
      })
      .catch(() => setEligible(false));
  }, [productId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

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

  async function startSession() {
    setSending(true);
    try {
      const fd = new FormData();
      fd.set("productId", productId);
      fd.set("triggerType", "ALWAYS_ON");
      fd.set("anonymousId", getAnonymousId());
      const res = await fetch("/apps/negotiate/start", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (data && data.sessionId) {
        sessionIdRef.current = data.sessionId;
        setStatus("active");
        // Greeting is always two separate messages (see proxy.start's
        // `messages` array) - rendered as two consecutive bot bubbles,
        // not one message with a line break.
        if (Array.isArray(data.messages)) {
          for (const line of data.messages) addMessage("bot", line);
        } else if (data.message) {
          addMessage("bot", data.message);
        }
      } else {
        setStatus("error");
        addMessage(
          "system",
          (data && data.message) || "Couldn't start a negotiation right now.",
        );
      }
    } catch {
      setStatus("error");
      addMessage("system", "Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
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

      if (data.status === "ACCEPTED") {
        setStatus("accepted");
        setCheckoutUrl(data.checkoutUrl);
        addMessage("bot", data.message);
        return;
      }
      if (data.status === "DECLINED") {
        setStatus("declined");
        addMessage("bot", data.message);
        return;
      }
      if (data.status === "EXPIRED") {
        setStatus("expired");
        addMessage("system", data.message);
        return;
      }
      if (data.error === "rate_limited") {
        setStatus("rate_limited");
        addMessage("system", data.message);
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
      const isFinalOffer =
        Boolean(data.finalTier) || Boolean(data.floorReached);
      // A "no price found" nudge or the ASK_FOR_MORE tier both come back
      // with no price at all - nothing to accept yet in either case.
      setHasOffer(data.price != null);
      addMessage("bot", data.message, isFinalOffer);
    } catch {
      addMessage("system", "Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
  }

  function handleOpen() {
    setOpen(true);
    if (!sessionIdRef.current) startSession();
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
    sendAction("counter", price ?? undefined);
  }

  if (!eligible) return null;

  const showInput = status === "active";
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

  if (!open) {
    return (
      <button type="button" onClick={handleOpen} className="sgn-launcher">
        <ChatIcon />
        {LAUNCHER_TEXT}
      </button>
    );
  }

  return (
    <div className="sgn-panel">
      <div className="sgn-header">
        <div className="sgn-header-title">{headerTitle}</div>
        <button
          type="button"
          onClick={() => setOpen(false)}
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
    </div>
  );
}

// One fixed accent color, everywhere - not a merchant setting. See the
// file header comment.
const ACCENT = "#191970"; // midnight blue
const ACCENT_HOVER = "#12124f"; // slightly darker, for hover feedback

const STYLESHEET = `
.sgn-launcher, .sgn-panel, .sgn-panel * {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-sizing: border-box;
}
.sgn-launcher {
  position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 14px 22px; border-radius: 999px; border: none;
  background: ${ACCENT}; color: #fff; font-size: 14px; font-weight: 600;
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
  padding: 16px; background: ${ACCENT}; color: #fff;
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
.sgn-bubble-customer { background: ${ACCENT}; color: #fff; border-bottom-right-radius: 4px; }
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
.sgn-checkout-link {
  display: block; text-align: center; margin: 0 16px 16px; padding: 12px;
  border-radius: 999px; background: ${ACCENT}; color: #fff; text-decoration: none;
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
.sgn-input:focus { border-color: ${ACCENT}; }
.sgn-action-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.sgn-btn {
  padding: 9px 16px; border: none; border-radius: 999px; background: ${ACCENT};
  color: #fff; cursor: pointer; font-size: 13px; font-weight: 600;
  transition: transform 0.12s ease, background 0.12s ease;
}
.sgn-btn:hover:not(:disabled) { transform: translateY(-1px); background: ${ACCENT_HOVER}; }
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
  root.render(<ChatWidget productId={productId} />);
}

bootstrap();
