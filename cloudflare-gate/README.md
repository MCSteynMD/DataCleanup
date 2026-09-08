# Cleanup web gate (Cloudflare Worker)

Private reviewer at `https://cleanup23.tabletoptools.cc`

## What it does

- Login (Worker secrets: `AUTH_EMAIL`, `AUTH_PASSWORD`, `SESSION_SECRET`)
- **Timesheet** — records local wall-clock login / logout; export CSV from the Timesheet screen
- Upload **similarity results** (Grouped Review + optional Semantic Suggestions) **or** FOExport
- FOExport is clustered in-browser (Jaccard ≥ 0.60); unmatched products are kept
- Related panel uses Semantic Suggestions from a desktop results upload (run Related once locally)
- Decisions / pulls / progress persist in D1
- **Pass 2** — promote Pass 1 children to parents and rematch against the full catalog

## Deploy

```powershell
wrangler deploy
wrangler d1 execute cleanup-db --remote --file=schema.sql   # first time only
wrangler d1 execute cleanup-db --remote --file=migrate_work_sessions.sql  # timesheet table
wrangler d1 execute cleanup-db --remote --file=migrate_related_dump.sql    # Related dump/hide
wrangler d1 execute cleanup-db --remote --file=migrate_pass_number.sql     # Pass 1 / Pass 2 jobs
```

## Pass 2

Pass 2 promotes every Pass 1 **child** to a parent and rematches them against the full catalog (Jaccard ≥ 0.60). Duplicates marked in Pass 1 are pre-marked on the Pass 2 job. Use the **Pass 2** tab → **Start Pass 2** on a Pass 1 job.

## Pass 4 naming backbone

**Slot for field lists:** `NAMING_STANDARDS.js` at the repo root. Paste category → required fields there (Cap screw, Hex Bolt, …). Then:

```bash
node cloudflare-gate/scripts/build-naming-backbone.mjs
```

Pass 4 also scores against the MDCOE product-master convention (leaf category + spec fields, ALL CAPS, comma-separated). A full procurement dump is optional:

```bash
# On the machine / Cloudflare account that owns procurement-config-db:
wrangler d1 execute procurement-config-db --remote --json --file=scripts/dump-procurement-naming.sql > data/procurement-naming-dump.json

# In this repo:
node scripts/build-naming-backbone.mjs
# or: node scripts/build-naming-backbone.mjs --from /path/to/dump.json
```

Until a live dump is imported, Cap Screw and most fasteners have **no field lists** (the local hub snapshot only has fittings / cable ties). The engine still matches those category names; missing templates fall back to caps / comma / type-first checks.
