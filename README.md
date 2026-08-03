# Similarity Parser

Windows tool to find near-duplicate product descriptions and review them in a desktop UI.

## Run from source

```powershell
pip install -r requirements.txt
python download_model.py            # one-time: vendor the semantic model offline
python similarity.py path\to\FOExport.xlsx -o results.xlsx
python review_gui.py
```

## Semantic "possible related" suggestions

Strict clustering is lexical (Jaccard over normalized tokens), so many synonym
cases like `ZIP TIE` vs `CABLE TIE` still land in different clusters. A semantic
pass (sentence-transformers `all-MiniLM-L6-v2`, bundled offline) embeds every
description and finds near neighbours in a *different* cluster.

- Semantic hits **never auto-merge** clusters — they are review-only suggestions.
- They are written to a `Semantic Suggestions` sheet in the results workbook.
- In the reviewer, the right-hand **Related (semantic)** panel lists them for the
  current parent:
  - **Jump** — open that product's existing cluster
  - **Pull in** — explicitly move it into the *current* cluster and mark it
    duplicate (saved in the decisions sidecar; original results file untouched)
- Toggle the panel with the `Related` button or the `G` key.

Token normalization (shared in `text_normalize.py`) also helps Jaccard catch
more near-misses: delimiter splits, `M8X50`-style codes, light plurals, and a
small synonym map (`ZIP`→`CABLE`, `SS`→`STAINLESS STEEL`, …).

Tuning (top of [`similarity.py`](similarity.py)):
- `SEMANTIC_ENABLED` — turn the pass on/off.
- `SIMILARITY_THRESHOLD` — Jaccard cutoff for cluster matches (default `0.60`).
- `SEMANTIC_THRESHOLD` — cosine cutoff for Related (default `0.50`).
  Raise it for fewer, higher-confidence suggestions.
- `SEMANTIC_TOP_K` — max suggestions kept per product (default `10`).

Run `python download_model.py` once on a machine with internet before packaging
so the model is available offline; `build_package.ps1` bundles it into the Engine.

## Build manager installer

Requires [Inno Setup 6](https://jrsoftware.org/isinfo.php) and PyInstaller:

```powershell
powershell -ExecutionPolicy Bypass -File .\build_package.ps1
```

Outputs:
- `dist\SimilarityParser_Setup.exe` — send this to managers
- `dist\SimilarityParser_for_manager.zip` — portable fallback

## Input format

Works with FOExport-style Excel columns:
- `Product number`
- `Product name`
(optional `Search name` fallback)
