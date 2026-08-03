/** Client-side tokenize + Jaccard clustering (mirrors desktop text_normalize / similarity). */

const SPLIT_RE = /[\s/_\-]+/;
const DIM_RE = /^([A-Z]*)(\d+(?:\.\d+)?)[X×](\d+(?:\.\d+)?)([A-Z]*)$/i;
const PUNCT_RE = /[^\w.]+/gu;
const BAD_DOT_RE = /(?<!\d)\.|\.(?!\d)/g;

const TOKEN_ALIASES = {
  ZIP: "CABLE",
  HEXAGONAL: "HEX",
  HEXAGON: "HEX",
};

const TOKEN_EXPANSIONS = {
  SS: ["STAINLESS", "STEEL"],
  SST: ["STAINLESS", "STEEL"],
  SSTEEL: ["STAINLESS", "STEEL"],
};

const NO_STEM = new Set([
  "SS", "GAS", "BRASS", "GLASS", "PRESS", "CROSS", "CLASS", "PASS",
  "ABS", "PCS", "MM", "MS", "HS", "BS", "AS", "IS", "US",
]);

const SIMILARITY_THRESHOLD = 0.6;
/** Skip tokens that appear in more than this many products (avoids O(n²) blowups). */
const MAX_POSTING = 400;

function cleanTokenPiece(part) {
  return String(part).replace(PUNCT_RE, "").replace(BAD_DOT_RE, "");
}

function singularize(token) {
  if (NO_STEM.has(token) || token.length < 4) return token;
  if (token.endsWith("IES") && token.length > 4) return `${token.slice(0, -3)}Y`;
  if (token.endsWith("SSES")) return token.slice(0, -2);
  if (token.endsWith("S") && !token.endsWith("SS")) return token.slice(0, -1);
  return token;
}

function expandDim(raw) {
  const m = DIM_RE.exec(raw);
  if (!m) return [raw];
  const [, prefix, a, b, suffix] = m;
  const parts = [];
  parts.push(prefix ? prefix + a : a);
  parts.push("X");
  parts.push(b);
  if (suffix) parts.push(suffix);
  return parts;
}

function mapToken(token) {
  token = TOKEN_ALIASES[token] || token;
  if (TOKEN_EXPANSIONS[token]) return TOKEN_EXPANSIONS[token];
  return [token];
}

export function normalizeTokens(text) {
  if (!text || typeof text !== "string" || !text.trim()) return [];
  const upper = text.toUpperCase().trim();
  const rawParts = upper.split(SPLIT_RE);
  const out = [];
  const seen = new Set();
  for (const part of rawParts) {
    if (!part) continue;
    const cleaned = cleanTokenPiece(part);
    if (!cleaned) continue;
    for (const piece0 of expandDim(cleaned)) {
      const piece = cleanTokenPiece(piece0);
      if (!piece) continue;
      for (const mapped0 of mapToken(piece)) {
        const mapped = singularize(mapped0);
        if (!mapped || seen.has(mapped)) continue;
        seen.add(mapped);
        out.push(mapped);
      }
    }
  }
  return out;
}

export function tokenize(text) {
  const tokens = new Set(normalizeTokens(text));
  const canonical = [...tokens].sort().join(" ");
  return { tokens, canonical };
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
    this.r = Array(n).fill(0);
  }
  find(x) {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a === b) return;
    if (this.r[a] < this.r[b]) [a, b] = [b, a];
    this.p[b] = a;
    if (this.r[a] === this.r[b]) this.r[a] += 1;
  }
}

/**
 * @param {Array<{product_number:string, description:string}>} rows
 * @param {(msg:string, pct:number)=>void} [onProgress]
 */
export async function clusterProducts(rows, onProgress) {
  const n = rows.length;
  if (onProgress) onProgress(`Tokenizing ${n.toLocaleString()} products…`, 5);

  const tokenSets = new Array(n);
  for (let i = 0; i < n; i++) {
    tokenSets[i] = tokenize(rows[i].description).tokens;
    if (onProgress && i > 0 && i % 2000 === 0) {
      onProgress(`Tokenizing… ${i.toLocaleString()}/${n.toLocaleString()}`, 5 + (i / n) * 15);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const uf = new UnionFind(n);

  // inverted index — never track every pair in a Set (that hits V8 "Set maximum size exceeded")
  const inv = new Map();
  for (let i = 0; i < n; i++) {
    for (const t of tokenSets[i]) {
      let list = inv.get(t);
      if (!list) {
        list = [];
        inv.set(t, list);
      }
      if (list.length < MAX_POSTING) {
        list.push(i);
      } else if (list.length === MAX_POSTING) {
        list.push(-1); // sentinel: token is too common, skip later
      }
    }
  }

  const thr = SIMILARITY_THRESHOLD;
  const uniqueTokens = [...inv.keys()];
  let done = 0;
  let lastYield = Date.now();
  if (onProgress) onProgress("Comparing similar names…", 25);

  for (const t of uniqueTokens) {
    const idxs = inv.get(t);
    done += 1;
    if (!idxs || idxs.length < 2) continue;
    if (idxs[idxs.length - 1] === -1 || idxs.length > MAX_POSTING) continue;

    for (let a = 0; a < idxs.length; a++) {
      const i = idxs[a];
      for (let b = a + 1; b < idxs.length; b++) {
        const j = idxs[b];
        if (uf.find(i) === uf.find(j)) continue;
        const A = tokenSets[i];
        const B = tokenSets[j];
        const min = Math.min(A.size, B.size);
        const max = Math.max(A.size, B.size);
        if (!max || min / max < thr) continue;
        if (jaccard(A, B) >= thr) uf.union(i, j);
      }
    }

    if (onProgress && done % 80 === 0) {
      onProgress(
        `Clustering… ${done.toLocaleString()}/${uniqueTokens.length.toLocaleString()} tokens`,
        25 + (done / uniqueTokens.length) * 70,
      );
    }
    if (Date.now() - lastYield > 60) {
      lastYield = Date.now();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (onProgress) onProgress("Building clusters…", 96);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let members = groups.get(root);
    if (!members) {
      members = [];
      groups.set(root, members);
    }
    members.push(i);
  }

  const multi = [];
  const singles = [];
  for (const members of groups.values()) {
    if (members.length > 1) multi.push(members);
    else singles.push(members);
  }
  multi.sort((a, b) => b.length - a.length);
  // Stable order for unmatched products
  singles.sort((a, b) =>
    String(rows[a[0]].product_number).localeCompare(String(rows[b[0]].product_number)),
  );

  const clusterOrder = [];
  const clusters = {};
  const byProduct = {};
  let cid = 0;

  function emit(memberIdxs) {
    const items = memberIdxs.map((i, pos) => {
      const row = rows[i];
      return {
        cluster_id: cid,
        cluster_size: memberIdxs.length,
        position_in_cluster: pos,
        depth: pos === 0 ? 0 : 1,
        product_number: String(row.product_number),
        description: row.description || "",
        linked_to_product:
          pos === 0 ? "" : String(rows[memberIdxs[0]].product_number),
        score_to_parent: pos === 0 ? "" : null,
        n_similar_in_cluster: Math.max(memberIdxs.length - 1, 0),
        exact_dup_group: "",
      };
    });
    const rootTok = tokenSets[memberIdxs[0]];
    for (let k = 1; k < items.length; k++) {
      items[k].score_to_parent =
        Math.round(jaccard(rootTok, tokenSets[memberIdxs[k]]) * 10000) / 10000;
    }
    items.sort(
      (a, b) =>
        a.depth - b.depth || (b.score_to_parent || 0) - (a.score_to_parent || 0),
    );
    items.forEach((it, pos) => {
      it.position_in_cluster = pos;
      byProduct[it.product_number] = it;
    });
    clusters[cid] = items;
    clusterOrder.push(cid);
    cid += 1;
  }

  // Multi-item clusters first (these are what the reviewer walks).
  for (const m of multi) emit(m);
  const reviewClusterOrder = [...clusterOrder];

  // Keep every unmatched / singleton product in the catalog so nothing is lost.
  for (const s of singles) emit(s);

  if (onProgress) onProgress("Done clustering", 100);
  const nInReview = reviewClusterOrder.reduce(
    (sum, id) => sum + (clusters[id]?.length || 0),
    0,
  );
  return {
    // Review navigation = near-duplicate clusters only
    cluster_order: reviewClusterOrder,
    clusters,
    by_product: byProduct,
    semantic: {},
    stats: {
      n_products: n,
      n_clusters: reviewClusterOrder.length,
      n_singleton_clusters: singles.length,
      n_in_clusters: nInReview,
      n_unmatched: singles.length,
    },
  };
}

export function tokenDiff(refText, candText) {
  const ref = new Set(normalizeTokens(refText));
  const cand = new Set(normalizeTokens(candText));
  const shared = [];
  const onlyRef = [];
  const onlyCand = [];
  for (const t of ref) (cand.has(t) ? shared : onlyRef).push(t);
  for (const t of cand) if (!ref.has(t)) onlyCand.push(t);
  shared.sort();
  onlyRef.sort();
  onlyCand.sort();
  return { shared, onlyRef, onlyCand };
}
