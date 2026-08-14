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
  // Review queue: alphabetical by parent item name (description)
  multi.sort((a, b) => {
    const nameA = String(rows[a[0]].description || "").toLocaleLowerCase();
    const nameB = String(rows[b[0]].description || "").toLocaleLowerCase();
    return (
      nameA.localeCompare(nameB) ||
      String(rows[a[0]].product_number).localeCompare(String(rows[b[0]].product_number))
    );
  });
  // Stable order for unmatched products
  singles.sort((a, b) => {
    const nameA = String(rows[a[0]].description || "").toLocaleLowerCase();
    const nameB = String(rows[b[0]].description || "").toLocaleLowerCase();
    return (
      nameA.localeCompare(nameB) ||
      String(rows[a[0]].product_number).localeCompare(String(rows[b[0]].product_number))
    );
  });

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

/**
 * Pass 2: every Pass-1 child becomes a parent, matched (Jaccard ≥ 0.60) against
 * the full catalog. Returns { catalog, autoDecisions } where autoDecisions
 * pre-marks any product that was Duplicate in Pass 1.
 *
 * @param {{ cluster_order:number[], clusters:Record<number, any[]>, by_product:Record<string, any> }} pass1Catalog
 * @param {Record<string, {status?:string}>} pass1Decisions
 * @param {(msg:string, pct:number)=>void} [onProgress]
 */
export async function buildPass2Catalog(pass1Catalog, pass1Decisions = {}, onProgress) {
  const byIn = pass1Catalog?.by_product || {};
  const all = Object.values(byIn);
  if (!all.length) throw new Error("Pass 1 catalog is empty");

  const rows = all.map((p) => ({
    product_number: String(p.product_number),
    description: p.description || "",
  }));
  const pnToIdx = new Map(rows.map((r, i) => [r.product_number, i]));

  // Every non-root member of a Pass-1 review cluster is a Pass-2 parent.
  const childOrder = [];
  const childSet = new Set();
  for (const cid of pass1Catalog.cluster_order || []) {
    const members = pass1Catalog.clusters?.[cid] || [];
    if (members.length < 2) continue;
    const root =
      members.find((m) => Number(m.depth) === 0) ||
      members.slice().sort((a, b) => a.position_in_cluster - b.position_in_cluster)[0];
    const rootPn = root?.product_number;
    for (const m of members) {
      const pn = String(m.product_number || "");
      if (!pn || pn === rootPn || childSet.has(pn)) continue;
      childSet.add(pn);
      childOrder.push(pn);
    }
  }

  if (!childOrder.length) {
    throw new Error("No Pass-1 children found — finish Pass 1 clusters first.");
  }

  if (onProgress) onProgress(`Tokenizing ${rows.length.toLocaleString()} products…`, 5);
  const tokenSets = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    tokenSets[i] = tokenize(rows[i].description).tokens;
    if (onProgress && i > 0 && i % 2000 === 0) {
      onProgress(`Tokenizing… ${i.toLocaleString()}/${rows.length.toLocaleString()}`, 5 + (i / rows.length) * 15);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const inv = new Map();
  for (let i = 0; i < rows.length; i++) {
    for (const t of tokenSets[i]) {
      let list = inv.get(t);
      if (!list) {
        list = [];
        inv.set(t, list);
      }
      if (list.length < MAX_POSTING) list.push(i);
      else if (list.length === MAX_POSTING) list.push(-1);
    }
  }

  const thr = SIMILARITY_THRESHOLD;
  const pass1Dup = new Set();
  for (const [pn, dec] of Object.entries(pass1Decisions || {})) {
    const st = String(dec?.status || "").toLowerCase();
    if (st === "duplicate" || st === "same") pass1Dup.add(String(pn));
  }

  // Edges: child → [{j, score}, ...]
  const edges = new Map();
  let done = 0;
  let lastYield = Date.now();
  if (onProgress) onProgress(`Matching ${childOrder.length.toLocaleString()} children…`, 25);

  for (const childPn of childOrder) {
    const i = pnToIdx.get(childPn);
    done += 1;
    if (i == null) continue;
    const seen = new Set([i]);
    const hits = [];
    for (const t of tokenSets[i]) {
      const idxs = inv.get(t);
      if (!idxs || idxs.length < 2) continue;
      if (idxs[idxs.length - 1] === -1 || idxs.length > MAX_POSTING) continue;
      for (const j of idxs) {
        if (seen.has(j)) continue;
        seen.add(j);
        const A = tokenSets[i];
        const B = tokenSets[j];
        const min = Math.min(A.size, B.size);
        const max = Math.max(A.size, B.size);
        if (!max || min / max < thr) continue;
        const score = jaccard(A, B);
        if (score >= thr) hits.push({ j, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    if (hits.length) edges.set(childPn, hits);
    if (onProgress && done % 40 === 0) {
      onProgress(
        `Matching children… ${done.toLocaleString()}/${childOrder.length.toLocaleString()}`,
        25 + (done / childOrder.length) * 55,
      );
    }
    if (Date.now() - lastYield > 60) {
      lastYield = Date.now();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (onProgress) onProgress("Building Pass 2 clusters…", 85);

  // Assign each non-parent product to at most one Pass-2 parent (best score).
  // Pass-2 parents may still appear as candidates under other parents (list copies).
  const bestForCand = new Map(); // candPn -> { childPn, score }
  for (const [childPn, hits] of edges) {
    for (const { j, score } of hits) {
      const candPn = rows[j].product_number;
      if (childSet.has(candPn)) continue; // other Pass-2 parents handled as list-only copies
      const cur = bestForCand.get(candPn);
      if (!cur || score > cur.score) bestForCand.set(candPn, { childPn, score });
    }
  }

  const assigned = new Map(); // childPn -> [{ pn, score }]
  for (const [candPn, { childPn, score }] of bestForCand) {
    let list = assigned.get(childPn);
    if (!list) {
      list = [];
      assigned.set(childPn, list);
    }
    list.push({ pn: candPn, score });
  }

  // Also attach other Pass-2 parents as candidates under each parent (cross-child matches)
  for (const [childPn, hits] of edges) {
    let list = assigned.get(childPn);
    if (!list) {
      list = [];
      assigned.set(childPn, list);
    }
    const have = new Set(list.map((x) => x.pn));
    for (const { j, score } of hits) {
      const candPn = rows[j].product_number;
      if (!childSet.has(candPn) || candPn === childPn) continue;
      if (have.has(candPn)) continue;
      have.add(candPn);
      list.push({ pn: candPn, score });
    }
  }

  const clusters = {};
  const byProduct = {};
  const clusterOrder = [];
  const autoDecisions = {};
  let cid = 0;

  for (const childPn of childOrder) {
    const cands = (assigned.get(childPn) || []).slice().sort((a, b) => b.score - a.score);
    if (!cands.length) continue;

    const parentRow = byIn[childPn] || { product_number: childPn, description: "" };
    const items = [
      {
        cluster_id: cid,
        cluster_size: cands.length + 1,
        position_in_cluster: 0,
        depth: 0,
        product_number: childPn,
        description: parentRow.description || "",
        linked_to_product: "",
        score_to_parent: "",
        n_similar_in_cluster: cands.length,
        exact_dup_group: "",
      },
    ];
    byProduct[childPn] = items[0];

    cands.forEach((c, pos) => {
      const src = byIn[c.pn] || { product_number: c.pn, description: "" };
      const item = {
        cluster_id: cid,
        cluster_size: cands.length + 1,
        position_in_cluster: pos + 1,
        depth: 1,
        product_number: c.pn,
        description: src.description || "",
        linked_to_product: childPn,
        score_to_parent: Math.round(c.score * 10000) / 10000,
        n_similar_in_cluster: cands.length,
        exact_dup_group: "",
      };
      items.push(item);
      // Prefer parent-role by_product for other Pass-2 parents; else store candidate
      if (!childSet.has(c.pn) || !byProduct[c.pn]) byProduct[c.pn] = item;
      if (pass1Dup.has(c.pn) && !autoDecisions[c.pn]) {
        autoDecisions[c.pn] = {
          status: "duplicate",
          cluster_id: cid,
          note: "from_pass1",
        };
      }
    });

    clusters[cid] = items;
    clusterOrder.push(cid);
    cid += 1;
  }

  // Keep every Pass-1 product in the catalog (singletons for anything unused)
  for (const p of all) {
    const pn = String(p.product_number);
    if (byProduct[pn]) continue;
    const item = {
      cluster_id: cid,
      cluster_size: 1,
      position_in_cluster: 0,
      depth: 0,
      product_number: pn,
      description: p.description || "",
      linked_to_product: "",
      score_to_parent: "",
      n_similar_in_cluster: 0,
      exact_dup_group: "",
    };
    clusters[cid] = [item];
    byProduct[pn] = item;
    cid += 1;
  }

  if (onProgress) onProgress("Pass 2 ready", 100);
  return {
    catalog: {
      cluster_order: clusterOrder,
      clusters,
      by_product: byProduct,
      semantic: {},
      stats: {
        n_products: Object.keys(byProduct).length,
        n_clusters: clusterOrder.length,
        n_pass1_children: childOrder.length,
        n_auto_duplicates: Object.keys(autoDecisions).length,
      },
    },
    autoDecisions,
  };
}
