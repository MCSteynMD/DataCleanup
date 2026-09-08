/** Client-side tokenize + Jaccard clustering (mirrors desktop text_normalize / similarity). */
import { scorePass4Product } from "./naming.js?v=3";
export { scorePass4Product };

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
  // Same A→Z parent-name queue order as Pass 1
  const reviewOrder = clusterOrder.slice().sort((a, b) => {
    const na = String(clusters[a]?.[0]?.description || "").trim().toLocaleLowerCase();
    const nb = String(clusters[b]?.[0]?.description || "").trim().toLocaleLowerCase();
    return na.localeCompare(nb) || a - b;
  });
  return {
    catalog: {
      cluster_order: reviewOrder,
      clusters,
      by_product: byProduct,
      semantic: {},
      stats: {
        n_products: Object.keys(byProduct).length,
        n_clusters: reviewOrder.length,
        n_pass1_children: childOrder.length,
        n_auto_duplicates: Object.keys(autoDecisions).length,
      },
    },
    autoDecisions,
  };
}

const P3_STOP = new Set(["THE", "AND", "W", "WITH", "FOR", "OF", "A", "AN", "X"]);
const P3_SIZE_WORDS = new Set([
  "XXS", "XS", "XL", "XXL", "XXXL", "XXXXL", "XXXXXL",
  "SMALL", "MEDIUM", "LARGE",
]);
const P3_UNITS =
  /(?:\d+(?:\.\d+)?)\s*(?:MM|CM|MT\b|IN\b|FT\b|KG|G\b|L\b|ML|TON|KW|NPT|BSP)|(?:\bM\d{1,3}(?:X\d+(?:\.\d+)?)?\b)|(?:\d+\/\d+\s*"?)|(?:\d+\s*")/i;
const P3_DRAW = /\b[A-Z]{1,8}-?\d{2,}[A-Z0-9\-]*\b|\b\d{6,}\b/;
const P3_OFFICE = new Set([
  "HELMET", "BROOM", "FRIDGE", "KETTLE", "MICROWAVE", "PILLOW", "STAPLER",
  "HIGHLIGHTER", "CALCULATOR", "LANTERN", "LIFEJACKET", "SUNBLOCK", "SHOVEL",
  "PICKAXE", "WHEELBARROW", "CHAIR", "BOOK", "BANNER", "STAINSHIELD", "OXYGEN",
  "ACETELEEN", "FOOD", "FUEL",
]);
const P3_COMMODITY = new Set([
  "FILTER", "WIPER", "GUSSET", "NUT", "BOLT", "WASHER", "SEAL", "GASKET",
  "HOSE", "VALVE", "BEARING", "CLAMP", "SPRING", "BUSH", "SCREW", "PIPE",
  "TAPE", "PLUG", "CAP", "COUPLING", "FITTING", "NIPPLE", "ELBOW", "SHIM",
]);
/** Required facet: size (mm / garment / thread) or code (drawing / SKU). */
const P3_NEED = {
  BOLT: "size", NUT: "size", WASHER: "size", SCREW: "size",
  HOSE: "size", PIPE: "size", TUBE: "size", TAPE: "size",
  SHIRT: "size", PANTS: "size", JACKET: "size", GLOVES: "size",
  SPANNER: "size", WRENCH: "size",
  BEARING: "code", FILTER: "code", VALVE: "code", GASKET: "size",
  SEAL: "size", INSERT: "code", SWITCH: "code",
};
const P3_SEEDS = {
  TAPE: {
    good: [
      "TAPE, RED HONEYCOMB REFLECTIVE, 48MMX50M, JT-RT-LR-SA48-50-H",
      "CABLE TIE, STAINLESS STEEL, BALL TIE, 362 X 8MM, 107 PER BAG",
    ],
    bad: ["TAPE, CLEAR", "TAPE, INSULATION", "TAPE, MATERIAL", "TAPE, DANGER, BARRIER"],
  },
  BEARING: {
    good: ["BEARING, 6305-2RS1, SKF", "WHEEL BEARING, GD6, RIGHT HAND"],
    bad: ["BEARING", "BEARING, HANGER, DD, BQ"],
  },
  BOLT: {
    good: ["HEX BOLT, M16 X 50, GR8.8, DIN 933", "SOCKET BOLT, M3 X 10, GR8.8"],
    bad: ["BOLT", "SCREW PLUG"],
  },
  HOSE: {
    good: ["HOSE, HYD, 1/4\", 4SP, S4SP04, DYNAMISCHE PREMIUM"],
    bad: ["HOSE, RUBBER", "AIRCON HOSE"],
  },
  SHIRT: {
    good: ["SHIRT, TWO TONE, REFLECTIVE, FRONT AND BACK, SIZE XL, JONSSON"],
    bad: ["SHIRT, SHORT SLEEVE", "SHIRT, BLUE"],
  },
  FILTER: {
    good: ["FILTER, HYDRAULIC, DF BN/HC 240 T E 10 B 1.1/-B6, HYDAC"],
    bad: ["FILTER", "FILTER, BREATHER, DD"],
  },
  WASHER: {
    good: ["WASHER, M12 GALV, LM90 HT", "WASHER, SPRING, M22"],
    bad: ["WASHER", "WASHER, WHITE PLASTIC"],
  },
  VALVE: {
    good: ["VALVE, CHECK, S 25 A15-1X/420J3, R901454080"],
    bad: ["CHECK VALVE", "VALVE, FOOT, START BAR"],
  },
};

function p3Tokens(text) {
  return normalizeTokens(text).filter((t) => t && !P3_STOP.has(t));
}

function p3Family(text) {
  const t = p3Tokens(text);
  return t[0] || "";
}

function p3Features(pn, text) {
  const raw = String(text || "");
  const upper = raw.toUpperCase();
  const toks = p3Tokens(raw);
  return {
    nTok: toks.length,
    hasNum: /\d/.test(raw),
    hasUnit: P3_UNITS.test(raw),
    hasDraw: P3_DRAW.test(upper),
    hasSizeWord: toks.some((t) => P3_SIZE_WORDS.has(t)),
    dryrun: upper.includes("DRYRUN"),
    noUsar: upper.includes("NO USAR"),
    sCode: /^S/i.test(String(pn || "").trim()),
    empty: !raw.trim(),
    toks,
    family: toks[0] || "",
  };
}

function p3Vec(toks) {
  const c = new Map();
  for (const t of toks) c.set(t, (c.get(t) || 0) + 1);
  let n = 0;
  for (const v of c.values()) n += v * v;
  return { c, n: Math.sqrt(n) || 1 };
}

function p3Cos(a, b) {
  let inter = 0;
  for (const [k, v] of a.c) {
    const u = b.c.get(k);
    if (u) inter += v * u;
  }
  return inter / (a.n * b.n);
}

function p3Centroid(descList) {
  const c = new Map();
  for (const d of descList) {
    for (const t of p3Tokens(d)) c.set(t, (c.get(t) || 0) + 1);
  }
  let n = 0;
  for (const v of c.values()) n += v * v;
  return { c, n: Math.sqrt(n) || 1 };
}

function p3HasFacet(feat, need) {
  if (need === "size") return feat.hasNum || feat.hasUnit || feat.hasSizeWord;
  if (need === "code") return feat.hasDraw || feat.hasNum;
  return feat.hasNum || feat.hasDraw;
}

function p3FamilyProto(family, familyPeers = [], seeds = null) {
  const seed = seeds || P3_SEEDS[family] || { good: [], bad: [] };
  const peerDescs = (familyPeers || []).map((p) => p.description || p);
  const richPeers = peerDescs.filter((d) => {
    const f = p3Features("", d);
    return f.nTok >= 6 && f.hasNum;
  });
  const thinPeers = peerDescs.filter((d) => {
    const f = p3Features("", d);
    return f.nTok <= 3 && !f.hasDraw;
  });
  const goodList = [...seed.good, ...richPeers.slice(0, 8)];
  const badList = [...seed.bad, ...thinPeers.slice(0, 8)];
  return {
    goodList,
    badList,
    goodC: goodList.length ? p3Centroid(goodList) : null,
    badC: badList.length ? p3Centroid(badList) : null,
    familyRich: peerDescs.length >= 12 ? richPeers.length / peerDescs.length : 0,
  };
}

/**
 * Lightweight prototype scorer: hard rules, then family good/bad examples
 * plus completeness features. verdict: discard | ok | review.
 */
export function scorePass3Product(pn, description, familyPeers = [], seeds = null, proto = null) {
  const feat = p3Features(pn, description);
  const family = feat.family;
  const need = P3_NEED[family] || null;
  const pack = proto || p3FamilyProto(family, familyPeers, seeds);
  const { goodList, badList, familyRich } = pack;
  let margin = 0;
  if (pack.goodC && pack.badC) {
    const v = p3Vec(feat.toks);
    margin = p3Cos(v, pack.goodC) - p3Cos(v, pack.badC);
  }
  const missing = [];
  if (need && !p3HasFacet(feat, need)) missing.push(need);
  if (feat.nTok <= 2 && !feat.hasDraw) missing.push("detail");

  if (feat.sCode) {
    return { verdict: "discard", status: "discard", note: "auto: service_code", family, feat, margin, missing, reason: "Service / GL code (starts with S)" };
  }
  if (feat.empty) {
    return { verdict: "discard", status: "discard", note: "auto: empty", family, feat, margin, missing, reason: "Empty description" };
  }
  if (feat.dryrun || feat.noUsar) {
    return { verdict: "discard", status: "discard", note: "auto: DRYRUN- reference", family, feat, margin, missing, reason: feat.noUsar ? "NO USAR" : "DRYRUN reference" };
  }
  if (P3_OFFICE.has(family) && feat.nTok >= 1) {
    return { verdict: "ok", status: "ok", note: "auto: office_ok", family, feat, margin, missing, reason: "Short office / PPE name — enough for this family" };
  }
  if (feat.nTok <= 1 && P3_COMMODITY.has(family)) {
    return { verdict: "insufficient", status: "insufficient", note: "auto: one_word", family, feat, margin, missing, reason: "One-word commodity — not enough to identify" };
  }

  const specified = feat.nTok >= 6 && feat.hasNum && (feat.hasUnit || feat.hasDraw || feat.hasSizeWord);
  const longSpec = feat.nTok >= 8 && feat.hasNum;
  const clearlySpecified = feat.hasNum && (feat.hasUnit || feat.hasDraw || feat.hasSizeWord);
  if ((specified || longSpec || clearlySpecified) && margin >= -0.12 && !(need === "code" && !feat.hasDraw && feat.nTok <= 2)) {
    return { verdict: "ok", status: "ok", note: "auto: complete", family, feat, margin, missing, reason: "Size/code present" };
  }

  const peerThin = pack.familyRich >= 0.45 && feat.nTok <= 4 && !feat.hasDraw && !feat.hasUnit && !feat.hasNum;
  const closerToBad = badList.length >= 3 && margin < -0.08 && !clearlySpecified;
  const missingFacet = Boolean(need) && !p3HasFacet(feat, need);
  const shortVague = feat.nTok <= 3 && !feat.hasDraw && !feat.hasNum && !feat.hasUnit;

  if (peerThin || closerToBad || missingFacet || shortVague) {
    const bits = [];
    if (missingFacet) bits.push(`missing ${need}`);
    if (peerThin) bits.push("thinner than most in this family");
    if (closerToBad) bits.push("closer to thin examples");
    if (feat.nTok <= 3) bits.push("short name");
    return {
      verdict: "review",
      status: "",
      note: "",
      family,
      feat,
      margin,
      missing,
      reason: bits.join(" · ") || "Needs a human look",
      goodPeers: goodList.slice(0, 3),
      badPeers: badList.slice(0, 3),
    };
  }

  return { verdict: "ok", status: "ok", note: "auto: complete", family, feat, margin, missing, reason: "Enough information vs family peers" };
}

/**
 * Pass 3: completeness. Keepers (not Duplicate/Discard in the source job)
 * are scored. Hard discards and clear-OK are pre-marked; the review queue
 * is the grey zone (one product per cluster).
 */
export async function buildPass3Catalog(sourceCatalog, sourceDecisions = {}, onProgress) {
  const byIn = sourceCatalog?.by_product || {};
  const all = Object.values(byIn);
  if (!all.length) throw new Error("Source catalog is empty");

  const dropped = new Set();
  for (const [pn, dec] of Object.entries(sourceDecisions || {})) {
    const st = String(dec?.status || "").toLowerCase();
    if (st === "duplicate" || st === "same" || st === "discard") dropped.add(String(pn));
  }

  const keepers = all.filter((p) => !dropped.has(String(p.product_number)));
  if (!keepers.length) throw new Error("No keepers left after Pass 1/2 Duplicate and Discard.");

  if (onProgress) onProgress(`Scoring ${keepers.length.toLocaleString()} keepers…`, 8);

  const byFam = new Map();
  for (const p of keepers) {
    const fam = p3Family(p.description || "") || "_";
    let list = byFam.get(fam);
    if (!list) {
      list = [];
      byFam.set(fam, list);
    }
    list.push(p);
  }

  const famProto = new Map();
  for (const [fam, peers] of byFam) {
    famProto.set(fam, p3FamilyProto(fam, peers));
  }

  const autoDecisions = {};
  const review = [];
  let done = 0;
  for (const p of keepers) {
    done += 1;
    const fam = p3Family(p.description || "") || "_";
    const peers = byFam.get(fam) || [];
    const scored = scorePass3Product(p.product_number, p.description || "", peers, null, famProto.get(fam));
    const row = { p, scored };
    if (scored.verdict === "review") review.push(row);
    else {
      autoDecisions[String(p.product_number)] = {
        status: scored.status,
        note: scored.note,
        reason: scored.reason,
      };
    }
    if (onProgress && done % 400 === 0) {
      onProgress(`Scoring… ${done.toLocaleString()}/${keepers.length.toLocaleString()}`, 8 + (done / keepers.length) * 70);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  review.sort((a, b) => {
    const na = String(a.p.description || "").trim().toLocaleLowerCase();
    const nb = String(b.p.description || "").trim().toLocaleLowerCase();
    return na.localeCompare(nb) || String(a.p.product_number).localeCompare(String(b.p.product_number));
  });

  if (onProgress) onProgress("Building Pass 3 queue…", 88);

  const clusters = {};
  const byProduct = {};
  const clusterOrder = [];
  let cid = 0;

  function emit(p, size, inQueue) {
    const item = {
      cluster_id: cid,
      cluster_size: size,
      position_in_cluster: 0,
      depth: 0,
      product_number: String(p.product_number),
      description: p.description || "",
      linked_to_product: "",
      score_to_parent: "",
      n_similar_in_cluster: 0,
      exact_dup_group: "",
    };
    clusters[cid] = [item];
    byProduct[item.product_number] = item;
    if (inQueue) clusterOrder.push(cid);
    cid += 1;
  }

  for (const { p } of review) emit(p, 1, true);
  for (const p of keepers) {
    const pn = String(p.product_number);
    if (byProduct[pn]) continue;
    emit(p, 1, false);
  }

  if (onProgress) onProgress("Pass 3 ready", 100);
  return {
    catalog: {
      cluster_order: clusterOrder,
      clusters,
      by_product: byProduct,
      semantic: {},
      stats: {
        n_products: Object.keys(byProduct).length,
        n_clusters: clusterOrder.length,
        n_keepers: keepers.length,
        n_auto_ok: Object.values(autoDecisions).filter((d) => d.status === "ok").length,
        n_auto_discard: Object.values(autoDecisions).filter((d) => d.status === "discard").length,
        n_auto_insufficient: Object.values(autoDecisions).filter((d) => d.status === "insufficient").length,
        n_review: review.length,
      },
    },
    autoDecisions,
  };
}

function p4IsDropStatus(st) {
  const s = String(st || "").toLowerCase();
  return s === "duplicate" || s === "same" || s === "discard" || s === "insufficient" || s === "thin";
}

/**
 * Pass 4 catalog: Pass 3 keepers minus Duplicate / Discard / Insufficient.
 * Auto-standard and auto-rewrite are pre-marked; queue is the grey zone.
 */
export async function buildPass4Catalog(sourceCatalog, sourceDecisions = {}, onProgress) {
  const byIn = sourceCatalog?.by_product || {};
  const all = Object.values(byIn);
  if (!all.length) throw new Error("Source catalog is empty");

  const dropped = new Set();
  for (const [pn, dec] of Object.entries(sourceDecisions || {})) {
    if (p4IsDropStatus(dec?.status)) dropped.add(String(pn));
  }
  const keepers = all.filter((p) => !dropped.has(String(p.product_number)));
  if (!keepers.length) throw new Error("No keepers left after Pass 3 Duplicate / Discard / Insufficient.");

  if (onProgress) onProgress(`Scoring ${keepers.length.toLocaleString()} names…`, 10);

  const autoDecisions = {};
  const review = [];
  let done = 0;
  for (const p of keepers) {
    done += 1;
    const scored = scorePass4Product(p.product_number, p.description || "");
    if (scored.verdict === "review") review.push({ p, scored });
    else {
      autoDecisions[String(p.product_number)] = {
        status: scored.status,
        note: scored.note,
        reason: scored.reason,
        proposal: scored.proposal,
      };
    }
    if (onProgress && done % 400 === 0) {
      onProgress(`Scoring… ${done.toLocaleString()}/${keepers.length.toLocaleString()}`, 10 + (done / keepers.length) * 70);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  review.sort((a, b) => {
    const na = String(a.p.description || "").trim().toLocaleLowerCase();
    const nb = String(b.p.description || "").trim().toLocaleLowerCase();
    return na.localeCompare(nb) || String(a.p.product_number).localeCompare(String(b.p.product_number));
  });

  if (onProgress) onProgress("Building Pass 4 queue…", 88);

  const clusters = {};
  const byProduct = {};
  const clusterOrder = [];
  let cid = 0;

  function emit(p, inQueue, scored) {
    const item = {
      cluster_id: cid,
      cluster_size: 1,
      position_in_cluster: 0,
      depth: 0,
      product_number: String(p.product_number),
      description: p.description || "",
      linked_to_product: "",
      score_to_parent: "",
      n_similar_in_cluster: 0,
      exact_dup_group: scored?.proposal || "",
    };
    clusters[cid] = [item];
    byProduct[item.product_number] = item;
    if (inQueue) clusterOrder.push(cid);
    cid += 1;
  }

  for (const { p, scored } of review) emit(p, true, scored);
  for (const p of keepers) {
    const pn = String(p.product_number);
    if (byProduct[pn]) continue;
    emit(p, false, autoDecisions[pn] ? { proposal: autoDecisions[pn].proposal } : null);
  }

  if (onProgress) onProgress("Pass 4 ready", 100);
  return {
    catalog: {
      cluster_order: clusterOrder,
      clusters,
      by_product: byProduct,
      semantic: {},
      stats: {
        n_products: Object.keys(byProduct).length,
        n_clusters: clusterOrder.length,
        n_keepers: keepers.length,
        n_auto_standard: Object.values(autoDecisions).filter((d) => d.status === "standard").length,
        n_auto_rewritten: Object.values(autoDecisions).filter((d) => d.status === "rewritten").length,
        n_review: review.length,
      },
    },
    autoDecisions,
  };
}
