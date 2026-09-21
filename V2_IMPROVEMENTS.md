# V2 Improvements

Improvements to things that already exist, kept separate from V2_ROADMAP.md
(which lists new features). Not in priority order. Add items as they come up.

## 1. Draft order cleanup: go live

Abandoned negotiated draft orders are deleted after 24 hours. Built and pushed
(commit c3c3f8f), currently running in dry-run mode, which only logs.

**What it touches, and nothing else**
- Only drafts tagged Noodle.
- Only drafts still OPEN.
- Only drafts created more than 24 hours ago.
- Hourly, capped at 100 per shop per run.
- Tag, status, and age are re-checked in code after Shopify's search.

**To go live**
- Deploy to EC2 (pull, rebuild, restart). No Shopify version release.
- Check logs: docker logs <container> 2>&1 | grep draft-cleanup
- Expect: "scheduled every 60 minutes, mode: DRY RUN (deletes nothing)".
- After about a day, compare the "would delete" lines with Noodle-tagged open drafts in Shopify Admin.
- If they match, set DRY_RUN to false in app/models/draft-order-cleanup.server.ts and redeploy.

**Follow-ups**
- Drafts created before Sept 18, 2026 have no tag and are never matched. Clear those by hand in Admin.
- Invoice-sent drafts are deliberately left alone. Decide later if they should go too.
- Shopify's docs only showed the OPEN status. Confirm the other status names before ever widening this.
- Age counts from creation. A merchant who edits a Noodle draft and leaves it open past 24 hours will still lose it.
- Sessions store a 48 hour draftOrderExpiresAt that nothing reads. Remove it or leave it.
- Update the project history doc, it still says this cleanup was never built.

## 2. Per-store negotiation records on the backend

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
- An hourly job using the same timer pattern as the draft order cleanup.
- Delete sessions where the expiry date has passed. Their offers go with them automatically.
- Optionally mark them EXPIRED first so statuses are accurate.
- If lifetime per-store totals are wanted, save counts to a small table before deleting (ties to item 2).
- Backend only, no Shopify version release.

**Related**
- Deleting a session does not delete its Shopify draft order. That is item 1.

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
