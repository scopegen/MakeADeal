# V2 Improvements

Improvements to things that already exist, kept separate from V2_ROADMAP.md
(which lists new features). Not in priority order. Add items as they come up.

## 1. Draft orders are kept: no automatic deletion (decision)

Decided not to delete abandoned negotiated draft orders. They stay in the
merchant's Shopify Admin (Draft orders) as a record of every accepted
negotiation, paid or not.

**What happened**
- An hourly cleanup was built (commit c3c3f8f) to delete Noodle-tagged open drafts after 24 hours.
- It only ever ran in dry-run mode, which logs and deletes nothing, so no draft order was ever deleted.
- It was then removed entirely. The app never deletes a draft order.

**What this means**
- Unpaid drafts pile up in each merchant's Draft orders list. Every one is tagged Noodle, so a merchant can filter and clear them by hand.
- The internal stats pages show drafts as converted, open, invoice sent, or not found. "Not found" now means a merchant deleted it, since the app doesn't.
- Sessions still store a 48 hour draftOrderExpiresAt that nothing reads. Harmless. Remove it or leave it.
- Revisit only if merchants complain about clutter. If so, make it an opt-in setting per merchant, not a default.

## 2. Per-store negotiation records on the backend

**Status: built** as the internal stats pages (commit 77d04a4), inside the
app at /app/internal, visible only from the stores on the allowlist
(sg-noida.myshopify.com by default). It lists every store, with a per-store
page showing products, prices, conversions, and sales windows. Store names are
read live from each store. What is below is the original scoping, and the
open decisions still apply.

See which store has how many negotiations. The data already exists in
NegotiationSession (shop id, status, created date) and Shop (domain).

**Ways to do it**
- Run a query over the SSH tunnel in pgAdmin. No code, works now.
- A protected internal stats page in the app. Backend only, needs a secret token env var so a merchant can never see other stores' numbers.
- A separate counters table updated when a session starts. Only worth it for lifetime totals that survive purges.

**Query (built from the schema, not yet run on the live database)**
```sql
SELECT s."shopDomain",
       s."installedAt",
       s."uninstalledAt",
       COUNT(n.id) AS total,
       COUNT(n.id) FILTER (WHERE n.status = 'ACCEPTED') AS accepted,
       COUNT(n.id) FILTER (WHERE n.status = 'DECLINED') AS declined,
       COUNT(n.id) FILTER (WHERE n.status = 'ACTIVE')   AS active,
       COUNT(n.id) FILTER (WHERE n.status = 'EXPIRED')  AS expired,
       MAX(n."createdAt") AS last_negotiation
FROM "Shop" s
LEFT JOIN "NegotiationSession" n ON n."shopId" = s.id
GROUP BY s.id
ORDER BY total DESC;
```

**Decisions still open**
- What counts as a negotiation: every session started, or only accepted ones.
- The test store (sg-noida) shows up. Filter it out for real-merchant numbers.
- Uninstalled stores vanish 48 hours after uninstall (shop/redact deletes the Shop row and all sessions). Keeping history for them means an aggregates-only table, and whether even the shop domain can be kept after a redact is a compliance call.
- Counts will shrink once the purge job in item 3 exists.

## 3. 30-day session purge job

The privacy policy (section 3) promises negotiation data is automatically
deleted 30 days after it starts. The code does not do this.

**The gap**
- Every session gets an expiry date 30 days out (proxy.start.tsx).
- Nothing deletes anything when it passes. No job exists anywhere in the codebase.
- Anonymous visitors have no customer id, so customers/redact can never reach them. This purge was meant to be their only deletion path.
- The offer route returns an EXPIRED message for a lapsed session but never writes EXPIRED back, so abandoned sessions stay ACTIVE in the database forever.
- Unless something outside the repo (a cron on EC2) already does it, sessions and offers pile up indefinitely in RDS.

**Fix path**
- An hourly job started when the app boots (a timer inside the app process, no server setup needed).
- Delete sessions where the expiry date has passed. Their offers go with them automatically.
- Optionally mark them EXPIRED first so statuses are accurate.
- If lifetime per-store totals are wanted, save counts to a small table before deleting (ties to item 2).
- Backend only, no Shopify version release.

**Related**
- Deleting a session never touches its Shopify draft order, by design. See item 1.

## 4. Rules lookup should use the session's locked rule

Sessions store which rule applied at the start (ruleId), meant to be locked for
the whole conversation. The code does not read it back.

- resolveEffectiveLimits in app/models/negotiation-engine.server.ts re-resolves the rule live on every message.
- Harmless with one rule active.
- With several rules, or a merchant editing a rule mid-conversation, pricing could change between rounds.
- Fix: for messages after the first, read the rule and ladder snapshot from the session instead of resolving again.
- Backend only, no Shopify version release.

## 5. EC2 housekeeping

Not verified on the actual server, this is standard Docker behavior.

- Every redeploy builds a new image and the old ones stay until removed.
- Check where the disk stands: df -h and docker system df.
- Clear old unused images: docker image prune.
- Container logs are stored on the EC2 disk. Consider log rotation (a max size and file count) so they cannot grow without limit.

## (more to be added)
