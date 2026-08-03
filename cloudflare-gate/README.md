# Cleanup web gate (Cloudflare Worker)

Private reviewer at `https://cleanup23.tabletoptools.cc`

## What it does

- Login (Worker secrets: `AUTH_EMAIL`, `AUTH_PASSWORD`, `SESSION_SECRET`)
- Upload **similarity results** (Grouped Review + optional Semantic Suggestions) **or** FOExport
- FOExport is clustered in-browser (Jaccard ≥ 0.60); unmatched products are kept
- Related panel uses Semantic Suggestions from a desktop results upload (run Related once locally)
- Decisions / pulls / progress persist in D1

## Deploy

```powershell
wrangler deploy
wrangler d1 execute cleanup-db --remote --file=schema.sql   # first time only
```
