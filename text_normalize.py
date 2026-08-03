"""Shared product-name tokenization for Jaccard matching and UI chips.

Normalizes industrial naming quirks so near-duplicates and light synonyms
share more tokens without changing the cluster model itself.
"""

from __future__ import annotations

import re

# Split on whitespace and common industrial delimiters.
_SPLIT_RE = re.compile(r"[\s/_\-]+")
# M8X50 / M10x1.5 / 1/4X20 style dimension codes (kept as parts).
_DIM_RE = re.compile(
    r"^([A-Z]*)(\d+(?:\.\d+)?)[X×](\d+(?:\.\d+)?)([A-Z]*)$",
    re.IGNORECASE,
)
# Strip leftover punctuation but keep alphanumerics and decimal points in numbers.
_PUNCT_RE = re.compile(r"[^\w.]+", re.UNICODE)
_BAD_DOT_RE = re.compile(r"(?<!\d)\.|\.(?!\d)")


def _clean_token_piece(part: str) -> str:
    """Remove punctuation; keep dots only when they are decimal points."""
    cleaned = _PUNCT_RE.sub("", part)
    return _BAD_DOT_RE.sub("", cleaned)

# One token → canonical token (aliases).
TOKEN_ALIASES: dict[str, str] = {
    "ZIP": "CABLE",  # ZIP TIE ≈ CABLE TIE
    "HEXAGONAL": "HEX",
    "HEXAGON": "HEX",
}

# One token → one or more replacement tokens (expansions).
TOKEN_EXPANSIONS: dict[str, tuple[str, ...]] = {
    "SS": ("STAINLESS", "STEEL"),
    "SST": ("STAINLESS", "STEEL"),
    "SSTEEL": ("STAINLESS", "STEEL"),
}

# Tokens that should not lose a trailing S (plurals / short codes).
_NO_STEM = frozenset({
    "SS", "GAS", "BRASS", "GLASS", "PRESS", "CROSS", "CLASS", "PASS",
    "ABS", "PCS", "MM", "MS", "HS", "BS", "AS", "IS", "US",
})


def _singularize(token: str) -> str:
    if token in _NO_STEM or len(token) < 4:
        return token
    if token.endswith("IES") and len(token) > 4:
        return token[:-3] + "Y"
    if token.endswith("SSES"):
        return token[:-2]  # GLASSES → GLASS (also in _NO_STEM path rarely)
    if token.endswith("S") and not token.endswith("SS"):
        return token[:-1]
    return token


def _expand_dim_token(raw: str) -> list[str]:
    m = _DIM_RE.match(raw)
    if not m:
        return [raw]
    prefix, a, b, suffix = m.group(1), m.group(2), m.group(3), m.group(4)
    parts: list[str] = []
    if prefix:
        parts.append(prefix + a)
    else:
        parts.append(a)
    parts.append("X")
    parts.append(b)
    if suffix:
        parts.append(suffix)
    return parts


def _map_token(token: str) -> list[str]:
    token = TOKEN_ALIASES.get(token, token)
    if token in TOKEN_EXPANSIONS:
        return list(TOKEN_EXPANSIONS[token])
    return [token]


def normalize_tokens(text: str) -> list[str]:
    """Return ordered unique-preserving list of normalized UPPERCASE tokens."""
    if not isinstance(text, str) or not text.strip():
        return []

    upper = text.upper().strip()
    raw_parts = _SPLIT_RE.split(upper)
    out: list[str] = []
    seen: set[str] = set()

    for part in raw_parts:
        if not part:
            continue
        cleaned = _clean_token_piece(part)
        if not cleaned:
            continue
        for piece in _expand_dim_token(cleaned):
            piece = _clean_token_piece(piece)
            if not piece:
                continue
            for mapped in _map_token(piece):
                mapped = _singularize(mapped)
                if not mapped or mapped in seen:
                    continue
                seen.add(mapped)
                out.append(mapped)
    return out


def tokenize(text: str) -> tuple[frozenset[str], str]:
    """UPPERCASE normalize → token set + alphabetical canonical string."""
    tokens = frozenset(normalize_tokens(text))
    canonical = " ".join(sorted(tokens))
    return tokens, canonical
