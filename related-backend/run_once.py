"""
One-shot Related (semantic) pass — run locally once, then upload the workbook.

Usage:
  python run_once.py path\\to\\FOExport.xlsx
  python run_once.py path\\to\\similarity_results__FOExport.xlsx

Writes Semantic Suggestions into an output xlsx next to the input
(or refreshes that sheet on a results workbook). Prefer the desktop
similarity.py pipeline for the full results pack; this is a thin helper.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from semantic_engine import compute_related_suggestions


def _load_products(path: Path) -> list[dict]:
    xl = pd.ExcelFile(path)
    if "Grouped Review" in xl.sheet_names:
        df = pd.read_excel(path, sheet_name="Grouped Review")
        cols = {c.lower().strip(): c for c in df.columns}
        pn = cols.get("product_number")
        desc = cols.get("description")
        cid = cols.get("cluster_id")
        if not pn or not desc or not cid:
            raise SystemExit("Grouped Review missing product_number/description/cluster_id")
        out = []
        for _, row in df.iterrows():
            p = str(row[pn]).strip()
            if not p or p.lower() == "nan":
                continue
            try:
                c = int(row[cid])
            except (TypeError, ValueError):
                c = -1
            out.append(
                {
                    "product_number": p,
                    "description": "" if pd.isna(row[desc]) else str(row[desc]),
                    "cluster_id": c,
                }
            )
        return out

    # FOExport-ish: first sheet
    df = pd.read_excel(path, sheet_name=0)
    cols = {str(c).lower().strip(): c for c in df.columns}

    def pick(*names):
        for n in names:
            if n in cols:
                return cols[n]
        for key, orig in cols.items():
            for n in names:
                if n in key:
                    return orig
        return None

    pn_col = pick("product number", "product_number", "item number", "sku", "pn")
    name_col = pick("product name", "description", "search name", "name")
    if not pn_col or not name_col:
        raise SystemExit(f"Could not find product/name columns in {list(df.columns)}")

    # Without clusters, treat each product as its own cluster (Related still works)
    out = []
    for i, row in df.iterrows():
        p = str(row[pn_col]).strip()
        if not p or p.lower() == "nan":
            continue
        out.append(
            {
                "product_number": p,
                "description": "" if pd.isna(row[name_col]) else str(row[name_col]),
                "cluster_id": int(i),
            }
        )
    return out


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        raise SystemExit(f"Not found: {src}")

    print(f"[Related] Reading {src} …", flush=True)
    products = _load_products(src)
    print(f"[Related] Loaded {len(products):,} products from {src.name}", flush=True)
    suggestions = compute_related_suggestions(products, threshold=0.50, top_k=10)
    print(f"[Related] Writing workbook …", flush=True)

    sug_df = pd.DataFrame(suggestions)
    out = src.with_name(f"{src.stem}__related.xlsx")
    with pd.ExcelWriter(out, engine="openpyxl") as xl:
        sug_df.to_excel(xl, sheet_name="Semantic Suggestions", index=False)
    print(f"[Related] Wrote {out}", flush=True)
    print(
        "[Related] Prefer uploading a full similarity_results workbook from desktop "
        "(Grouped Review + Semantic Suggestions).",
        flush=True,
    )


if __name__ == "__main__":
    main()
