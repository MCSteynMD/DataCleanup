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

Strict clustering is purely lexical (Jaccard token overlap), so synonym cases
like `ZIP TIE` vs `CABLE TIE` never land in the same cluster. A semantic pass
(sentence-transformers `all-MiniLM-L6-v2`, bundled offline) embeds every
description and finds near neighbours that landed in a *different* cluster.

- These never change the strict clusters — they are review-only hints.
- They are written to a `Semantic Suggestions` sheet in the results workbook.
- In the reviewer, the right-hand **Related (semantic)** panel lists them for the
  current parent; click a row to jump to that product's cluster. Toggle the panel
  with the `Related` button or the `G` key.

Tuning (top of [`similarity.py`](similarity.py)):
- `SEMANTIC_ENABLED` — turn the pass on/off.
- `SEMANTIC_THRESHOLD` — cosine cutoff (default `0.55`). Raise it for fewer,
  higher-confidence suggestions; lower it to catch more (and noisier) matches.
- `SEMANTIC_TOP_K` — max suggestions kept per product.

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
