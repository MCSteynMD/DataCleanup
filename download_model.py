"""
One-time helper: vendor the semantic model for offline use.

The reviewer's engine loads a sentence-transformers model from a local folder so
it never needs the network at runtime (managers' machines are often offline or
corporate-locked). Run this once on a machine WITH internet before building the
installer:

    pip install -r requirements.txt
    python download_model.py

It downloads all-MiniLM-L6-v2 and saves it to models/all-MiniLM-L6-v2, which is
what SEMANTIC_MODEL_PATH in similarity.py points at and what build_package.ps1
bundles into the Engine.
"""

from __future__ import annotations

import sys
from pathlib import Path

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DEST = Path(__file__).resolve().parent / "models" / "all-MiniLM-L6-v2"


def main() -> int:
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:  # noqa: BLE001
        print(f"sentence-transformers not installed: {exc}")
        print("Run: pip install -r requirements.txt")
        return 1

    DEST.parent.mkdir(parents=True, exist_ok=True)
    if DEST.exists() and any(DEST.iterdir()):
        print(f"Model already present at {DEST} — nothing to do.")
        return 0

    print(f"Downloading {MODEL_NAME} ...")
    model = SentenceTransformer(MODEL_NAME)
    print(f"Saving to {DEST} ...")
    model.save(str(DEST))
    print("Done. This folder is bundled offline by build_package.ps1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
