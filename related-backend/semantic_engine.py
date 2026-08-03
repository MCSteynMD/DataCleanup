"""MiniLM cross-cluster Related suggestions (mirrors similarity.py)."""

from __future__ import annotations

import os
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


def _resolve_model_path(explicit: str | None) -> str | None:
    if explicit:
        p = Path(explicit)
        if p.exists():
            return str(p)
    env = os.environ.get("MODEL_PATH", "").strip()
    if env and Path(env).exists():
        return env
    # Prefer bundled desktop model if present next to SimilarityPhaser
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "models" / "all-MiniLM-L6-v2",
        here / "models" / "all-MiniLM-L6-v2",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    # Fall back to Hugging Face id (first run downloads)
    return "sentence-transformers/all-MiniLM-L6-v2"


def _pct_bar(done: int, total: int, width: int = 24) -> str:
    if total <= 0:
        return "[" + ("-" * width) + "]"
    frac = min(1.0, max(0.0, done / total))
    filled = int(round(frac * width))
    return f"[{'#' * filled}{'-' * (width - filled)}] {frac * 100:5.1f}%"


def compute_related_suggestions(
    products: list[dict[str, Any]],
    *,
    threshold: float = 0.50,
    top_k: int = 10,
    model_path: str | None = None,
    progress_cb: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    """
    products: [{product_number, description, cluster_id}, ...]
    Returns suggestion dicts compatible with Semantic Suggestions / D1.
    """
    n = len(products)
    if n < 2:
        return []

    def prog(msg: str) -> None:
        line = f"[Related] {msg}"
        if progress_cb:
            progress_cb(line)
        print(line, flush=True)

    # Allow HF download when no local bundle (offline if model path is local)
    resolved = _resolve_model_path(model_path)
    local = resolved and Path(resolved).exists()
    if local:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"sentence-transformers import failed: {exc}") from exc

    prog(f"1/4 Loading model ({resolved}) …")
    t0 = time.perf_counter()
    try:
        model = SentenceTransformer(resolved, device="cpu")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"model load failed: {exc}") from exc
    prog(f"1/4 Model ready ({time.perf_counter() - t0:.1f}s)")

    pns = [str(p.get("product_number") or "").strip() for p in products]
    descs = [str(p.get("description") or "") for p in products]
    cids: list[int] = []
    for p in products:
        try:
            cids.append(int(p.get("cluster_id")))
        except (TypeError, ValueError):
            cids.append(-1)

    # Drop empty product numbers
    keep = [i for i, pn in enumerate(pns) if pn]
    pns = [pns[i] for i in keep]
    descs = [descs[i] for i in keep]
    cids = [cids[i] for i in keep]
    n = len(pns)
    if n < 2:
        return []

    prog(f"2/4 Deduplicating descriptions ({n:,} products) …")
    uniq_index: dict[str, int] = {}
    uniq_texts: list[str] = []
    uniq_rows: list[list[int]] = []
    for i, desc in enumerate(descs):
        key = (desc or "").strip().lower()
        u = uniq_index.get(key)
        if u is None:
            u = len(uniq_texts)
            uniq_index[key] = u
            uniq_texts.append(desc or "")
            uniq_rows.append([])
        uniq_rows[u].append(i)
    m = len(uniq_texts)
    prog(f"2/4 {m:,} unique texts to embed")

    prog("3/4 Embedding on CPU (tqdm bar below) …")
    t_emb = time.perf_counter()
    emb = model.encode(
        uniq_texts,
        batch_size=256,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    ).astype("float32")
    prog(f"3/4 Embeddings done ({time.perf_counter() - t_emb:.1f}s)")

    thr = float(threshold)
    k = int(top_k)
    kbuf = min(m - 1, max(k * 4, k + 8))
    block = 512
    out: list[dict[str, Any]] = []
    t_nn = time.perf_counter()
    prog(f"4/4 Cross-cluster neighbours (threshold ≥ {thr:.0%}) …")

    for start in range(0, m, block):
        stop = min(start + block, m)
        sims = emb[start:stop] @ emb.T
        for bi in range(stop - start):
            ui = start + bi
            row = sims[bi].copy()
            row[ui] = -1.0
            part = np.argpartition(row, -kbuf)[-kbuf:]
            part = part[np.argsort(row[part])[::-1]]
            neighbours: list[tuple[int, float]] = []
            for uj in part:
                score = float(row[uj])
                if score < thr:
                    break
                neighbours.append((int(uj), score))
            if not neighbours:
                continue
            for i in uniq_rows[ui]:
                ci = cids[i]
                kept = 0
                for uj, score in neighbours:
                    rep = next((j for j in uniq_rows[uj] if cids[j] != ci), None)
                    if rep is None:
                        continue
                    out.append(
                        {
                            "product_number": pns[i],
                            "suggested_product": pns[rep],
                            "suggested_cluster_id": cids[rep],
                            "suggested_description": (descs[rep] or "")[:200],
                            "semantic_score": round(score, 4),
                        }
                    )
                    kept += 1
                    if kept >= k:
                        break
        elapsed = time.perf_counter() - t_nn
        rate = stop / elapsed if elapsed > 0 else 0
        eta = (m - stop) / rate if rate > 0 else 0
        prog(
            f"4/4 {_pct_bar(stop, m)}  {stop:,}/{m:,} unique  ·  "
            f"{len(out):,} suggestions  ·  elapsed {elapsed:.0f}s  ·  eta {eta:.0f}s",
        )

    prog(f"Done — {len(out):,} suggestions in {time.perf_counter() - t0:.1f}s total")
    return out


if __name__ == "__main__":
    print("Use: python run_once.py path\\to\\workbook.xlsx", file=sys.stderr)
