/**
 * Related matching on Cloudflare Workers AI (permanent).
 * Chunked + resumable so large catalogs (30k+) finish safely.
 * Cross-cluster neighbours via BGE-small (384-d), cosine ≥ 0.50.
 */

const MODEL = "@cf/baai/bge-small-en-v1.5";
const THRESHOLD = 0.5;
const TOP_K = 10;
const EMBED_BATCH = 32;
/** Unique texts to embed per Worker invocation (then self-chain). */
const EMBED_PER_SLICE = 3 * EMBED_BATCH; // 96 — smaller so progress keeps moving
/** Unique query rows to score per invocation. */
const SCORE_PER_SLICE = 64;
const DIM = 384;
/** Hard ceiling — above this we refuse (Worker memory / cost). */
const MAX_PRODUCTS = 100000;
const STATE_TTL = 60 * 60 * 36; // 36h
const AI_TIMEOUT_MS = 45000;
const AI_RETRIES = 3;

function kvMeta(jobId) {
  return `rel:${jobId}:meta`;
}
function kvUniq(jobId) {
  return `rel:${jobId}:uniq`;
}
function kvProducts(jobId) {
  return `rel:${jobId}:prod`;
}
function kvEmbPart(jobId, start) {
  return `rel:${jobId}:emb:${start}`;
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function packVectors(vecs, dim) {
  const buf = new Float32Array(vecs.length * dim);
  for (let i = 0; i < vecs.length; i++) {
    const v = vecs[i];
    if (v.length !== dim) throw new Error(`Bad embedding dim ${v.length}`);
    buf.set(v, i * dim);
  }
  return buf.buffer;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function embedBatch(ai, texts) {
  let lastErr;
  for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
    try {
      const res = await withTimeout(
        ai.run(MODEL, { text: texts }),
        AI_TIMEOUT_MS,
        `Workers AI embed (attempt ${attempt})`,
      );
      const rows = res?.data ?? res;
      if (!Array.isArray(rows) || rows.length !== texts.length) {
        throw new Error(`Embedding batch size mismatch (${rows?.length} vs ${texts.length})`);
      }
      return rows.map((row) => {
        const v = Array.isArray(row) ? row : row?.embedding || row?.values;
        if (!Array.isArray(v) || !v.length) throw new Error("Empty embedding vector");
        return l2normalize(v);
      });
    } catch (e) {
      lastErr = e;
      if (attempt < AI_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
      }
    }
  }
  throw lastErr || new Error("embedBatch failed");
}

async function clearRelatedState(env, jobId, meta) {
  const deletes = [kvMeta(jobId), kvUniq(jobId), kvProducts(jobId)];
  for (const start of meta?.embedParts || []) {
    deletes.push(kvEmbPart(jobId, start));
  }
  // Also sweep a few common offsets if meta incomplete
  if (!meta?.embedParts?.length) {
    for (let s = 0; s < 200000; s += EMBED_PER_SLICE) {
      deletes.push(kvEmbPart(jobId, s));
      if (deletes.length > 80) break;
    }
  }
  await Promise.all(deletes.map((k) => env.CATALOG.delete(k).catch(() => {})));
}

async function putJson(env, key, obj) {
  await env.CATALOG.put(key, JSON.stringify(obj), { expirationTtl: STATE_TTL });
}

async function getJson(env, key) {
  const raw = await env.CATALOG.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadAllEmbeddings(env, jobId, meta) {
  const m = meta.m;
  const dim = meta.dim || DIM;
  const out = new Array(m);
  const parts = meta.embedParts || [];
  for (const start of parts) {
    const ab = await env.CATALOG.get(kvEmbPart(jobId, start), { type: "arrayBuffer" });
    if (!ab) throw new Error(`Missing embedding part @${start}`);
    const f = new Float32Array(ab);
    const n = f.length / dim;
    for (let i = 0; i < n; i++) {
      out[start + i] = f.subarray(i * dim, (i + 1) * dim);
    }
  }
  for (let i = 0; i < m; i++) {
    if (!out[i]) throw new Error(`Embedding gap at ${i}`);
  }
  return out;
}

/**
 * One bounded slice of work. Call repeatedly until { done: true }.
 * Resumable across Worker invocations (state in KV).
 */
export async function runRelatedSlice(env, jobId, setProgress) {
  if (!env.AI) throw new Error("Workers AI binding missing");
  if (!env.CATALOG) throw new Error("KV CATALOG binding missing");

  let meta = await getJson(env, kvMeta(jobId));

  // --- init ---
  if (!meta || meta.phase === "init") {
    await setProgress({
      status: "running",
      error: "",
      detail: "Loading catalog…",
      progress: 0.02,
      n_suggestions: 0,
    });

    const { results } = await env.DB.prepare(
      `SELECT product_number, description, cluster_id FROM products WHERE job_id = ?`,
    )
      .bind(jobId)
      .all();

    const products = (results || [])
      .map((r) => ({
        product_number: String(r.product_number || "").trim(),
        description: String(r.description || ""),
        cluster_id: Number.isFinite(Number(r.cluster_id)) ? Number(r.cluster_id) : -1,
      }))
      .filter((p) => p.product_number);

    if (products.length < 2) {
      await clearRelatedState(env, jobId, meta);
      await setProgress({
        status: "done",
        detail: "Too few products for Related",
        progress: 1,
        n_suggestions: 0,
      });
      return { done: true, n_suggestions: 0 };
    }
    if (products.length > MAX_PRODUCTS) {
      throw new Error(
        `Catalog too large for Related (${products.length.toLocaleString()} > ${MAX_PRODUCTS.toLocaleString()})`,
      );
    }

    await setProgress({
      status: "running",
      detail: `Deduplicating ${products.length.toLocaleString()} products…`,
      progress: 0.04,
    });

    const uniqIndex = new Map();
    const uniqTexts = [];
    const uniqRows = [];
    for (let i = 0; i < products.length; i++) {
      const key = products[i].description.trim().toLowerCase();
      let u = uniqIndex.get(key);
      if (u == null) {
        u = uniqTexts.length;
        uniqIndex.set(key, u);
        uniqTexts.push(products[i].description);
        uniqRows.push([]);
      }
      uniqRows[u].push(i);
    }
    const m = uniqTexts.length;

    await putJson(env, kvProducts(jobId), products);
    await putJson(env, kvUniq(jobId), { texts: uniqTexts, rows: uniqRows });

    meta = {
      phase: "embed",
      nProducts: products.length,
      m,
      dim: DIM,
      embedAt: 0,
      scoreAt: 0,
      nSuggestions: 0,
      embedParts: [],
      semanticCleared: false,
    };
    await putJson(env, kvMeta(jobId), meta);

    await setProgress({
      status: "running",
      detail: `Embedding ${m.toLocaleString()} unique texts (chunked)…`,
      progress: 0.06,
    });
    return { done: false };
  }

  // --- embed ---
  if (meta.phase === "embed") {
    const uniq = await getJson(env, kvUniq(jobId));
    if (!uniq?.texts) throw new Error("Related state missing unique texts");
    const { texts } = uniq;
    const m = meta.m;
    const start = meta.embedAt;
    // Re-check cursor (avoid double-writers if two chains overlap)
    const live = await getJson(env, kvMeta(jobId));
    if (!live || live.phase !== "embed" || live.embedAt !== start) {
      return { done: false };
    }
    const stop = Math.min(start + EMBED_PER_SLICE, m);
    const packed = [];

    for (let i = start; i < stop; i += EMBED_BATCH) {
      const slice = texts
        .slice(i, Math.min(i + EMBED_BATCH, stop))
        .map((t) => (t || " ").slice(0, 2000));
      const vecs = await embedBatch(env.AI, slice);
      packed.push(...vecs);
    }

    await env.CATALOG.put(kvEmbPart(jobId, start), packVectors(packed, meta.dim || DIM), {
      expirationTtl: STATE_TTL,
    });
    meta.embedParts = meta.embedParts || [];
    if (!meta.embedParts.includes(start)) meta.embedParts.push(start);
    meta.embedAt = stop;

    if (stop >= m) {
      meta.phase = "score";
      meta.scoreAt = 0;
      await setProgress({
        status: "running",
        detail: `Finding Related neighbours (≥ ${(THRESHOLD * 100).toFixed(0)}%)…`,
        progress: 0.62,
      });
    } else {
      await setProgress({
        status: "running",
        detail: `Embedded ${stop.toLocaleString()}/${m.toLocaleString()}`,
        progress: 0.06 + 0.54 * (stop / m),
      });
    }
    await putJson(env, kvMeta(jobId), meta);
    return { done: false };
  }

  // --- score ---
  if (meta.phase === "score") {
    if (!meta.semanticCleared) {
      await env.DB.prepare(`DELETE FROM semantic WHERE job_id = ?`).bind(jobId).run();
      meta.semanticCleared = true;
      await putJson(env, kvMeta(jobId), meta);
    }

    const products = await getJson(env, kvProducts(jobId));
    const uniq = await getJson(env, kvUniq(jobId));
    if (!products || !uniq?.rows) throw new Error("Related state incomplete for scoring");

    const embeddings = await loadAllEmbeddings(env, jobId, meta);
    const m = meta.m;
    const kbuf = Math.min(m - 1, Math.max(TOP_K * 4, TOP_K + 8));
    const start = meta.scoreAt;
    const stop = Math.min(start + SCORE_PER_SLICE, m);
    const batchSug = [];

    for (let ui = start; ui < stop; ui++) {
      const a = embeddings[ui];
      const neighbours = [];
      for (let uj = 0; uj < m; uj++) {
        if (uj === ui) continue;
        const score = dot(a, embeddings[uj]);
        if (score < THRESHOLD) continue;
        if (neighbours.length < kbuf) {
          neighbours.push([uj, score]);
          if (neighbours.length === kbuf) neighbours.sort((x, y) => x[1] - y[1]);
        } else if (score > neighbours[0][1]) {
          neighbours[0] = [uj, score];
          neighbours.sort((x, y) => x[1] - y[1]);
        }
      }
      neighbours.sort((x, y) => y[1] - x[1]);
      if (!neighbours.length) continue;

      for (const i of uniq.rows[ui]) {
        const ci = products[i].cluster_id;
        let kept = 0;
        for (const [uj, score] of neighbours) {
          const rep = uniq.rows[uj].find((j) => products[j].cluster_id !== ci);
          if (rep == null) continue;
          batchSug.push({
            product_number: products[i].product_number,
            suggested_product: products[rep].product_number,
            suggested_cluster_id: products[rep].cluster_id,
            suggested_description: (products[rep].description || "").slice(0, 200),
            semantic_score: Math.round(score * 10000) / 10000,
          });
          kept += 1;
          if (kept >= TOP_K) break;
        }
      }
    }

    const chunk = 100;
    for (let i = 0; i < batchSug.length; i += chunk) {
      const slice = batchSug.slice(i, i + chunk);
      const stmts = slice.map((s) =>
        env.DB.prepare(
          `INSERT INTO semantic (
             job_id, product_number, suggested_product, suggested_cluster_id,
             suggested_description, semantic_score
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id, product_number, suggested_product) DO UPDATE SET
             suggested_cluster_id=excluded.suggested_cluster_id,
             suggested_description=excluded.suggested_description,
             semantic_score=excluded.semantic_score`,
        ).bind(
          jobId,
          s.product_number,
          s.suggested_product,
          s.suggested_cluster_id,
          s.suggested_description,
          s.semantic_score,
        ),
      );
      if (stmts.length) await env.DB.batch(stmts);
    }

    meta.scoreAt = stop;
    meta.nSuggestions = (meta.nSuggestions || 0) + batchSug.length;

    if (stop >= m) {
      const nSug = meta.nSuggestions;
      await setProgress({
        status: "done",
        detail: "complete",
        progress: 1,
        n_suggestions: nSug,
        error: "",
      });
      await clearRelatedState(env, jobId, meta);
      return { done: true, n_suggestions: nSug };
    }

    await putJson(env, kvMeta(jobId), meta);
    await setProgress({
      status: "running",
      detail: `Scored ${stop.toLocaleString()}/${m.toLocaleString()} · ${meta.nSuggestions.toLocaleString()} suggestions`,
      progress: 0.62 + 0.36 * (stop / m),
      n_suggestions: meta.nSuggestions,
    });
    return { done: false };
  }

  await clearRelatedState(env, jobId, meta);
  await setProgress({
    status: "done",
    detail: "complete",
    progress: 1,
    n_suggestions: meta?.nSuggestions || 0,
  });
  return { done: true, n_suggestions: meta?.nSuggestions || 0 };
}

/**
 * Run one slice. Prefer chaining via /api/related-continue instead of looping
 * many slices in one waitUntil (avoids silent Worker kills mid-job).
 */
export async function runRelatedJob(env, jobId, setProgress, { fresh = false } = {}) {
  if (fresh) {
    const old = await getJson(env, kvMeta(jobId));
    await clearRelatedState(env, jobId, old);
  }
  return runRelatedSlice(env, jobId, setProgress);
}

export { MAX_PRODUCTS, getJson, kvMeta, EMBED_PER_SLICE };
