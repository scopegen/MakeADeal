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
- Counts do not shrink after the retention job in item 3 goes live: it removes shopper ids from old negotiations but keeps the records, so per-store history stays. Only the split between Active and Expired changes.

## 3. 30-day retention job: built, running in dry-run

Shopify's protected customer data rules say personal data must not be kept
longer than needed, and the privacy policy promised deletion 30 days after a
negotiation starts. Nothing did this: sessions and rate-limit rows piled up
forever, and shoppers' real IP addresses were kept in the rate-limit table.

**Decision:** remove what identifies a shopper after 30 days, keep the record.
Not delete whole negotiations, so per-store history and stats survive.

**What the job does** (app/models/data-retention.server.ts, hourly, inside the app)
- Marks negotiations past their 30 days as EXPIRED if they were still ACTIVE.
- Clears customerId and anonymousId on negotiations past their 30 days.
- Deletes rate-limit rows older than 1 hour (each is keyed by a shopper's IP).
- Keeps: the negotiation rows, offers, prices, outcomes, draft order references, all merchant settings.
- Never touches Shopify draft orders or orders. Uninstall deletion is still the shop/redact webhook.
- Works in small batches. Logs counts only, never ids or IPs.

**Status**
- Built and tested locally on fake year-2000 records (22 checks, including multi-batch deletion and real data untouched). The test also caught a time-zone bug in a raw SQL date comparison, fixed by using Prisma's typed filter.
- Ships with DRY_RUN = true: it only counts and changes nothing.
- Privacy policy wording updated to match (section 1 IP line, section 3 retention lines).
- Backend only. No Shopify version release.

**To go live**
- Deploy to EC2 (pull, rebuild, restart) with the policy change.
- Check logs: docker logs <container> 2>&1 | grep data-retention
- Expect: "scheduled every 60 minutes, mode: DRY RUN (changes nothing)".
- Counts appear only when there is something to change. Nothing real is old enough before about October 17, 2026, so silence is expected until then.
- Take a manual RDS snapshot first. The first live run cleans the whole backlog and can't be undone.
- Set DRY_RUN to false in the file and redeploy.
- Before and after, compare SELECT COUNT(*) FROM "NegotiationSession". The two numbers must match.

**Still open**
- A lawyer should confirm the policy wording, in particular that the remaining record counts as no longer identifying the shopper (it keeps a draft order reference).
- Chats, when stored later, need to be cleared by this job at 30 days too.
- The customers/data_request webhook still prints whole sessions into the container logs.
- Logs and RDS backups keep older copies until they roll off.

**Related**
- Deleting or scrubbing a session never touches its Shopify draft order, by design. See item 1.

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
