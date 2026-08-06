/**
 * Related matching on Cloudflare Workers AI (permanent).
 * Recovered from deployed worker (2026-08-03) — D1 related_blob storage.
 */

const MODEL = "@cf/baai/bge-small-en-v1.5";
const THRESHOLD = 0.5;
const TOP_K = 10;
const EMBED_BATCH = 32;
const EMBED_PER_SLICE = 6 * EMBED_BATCH;
const SCORE_PER_SLICE = 64;
const DIM = 384;
const MAX_PRODUCTS = 1e5;
const AI_TIMEOUT_MS = 45e3;
const AI_RETRIES = 3;
function blobName(kind, part = 0) {
  if (kind === "emb") return `emb:${part}`;
  return kind;
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
      })
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
        `Workers AI embed (attempt ${attempt})`
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
async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function nowIso() {
  return (new Date()).toISOString();
}
async function putBlob(env, jobId, name, data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  await env.DB.prepare(
    `INSERT INTO related_blob (job_id, name, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(job_id, name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).bind(jobId, name, bytes, nowIso()).run();
}
async function getBlob(env, jobId, name, { type = "arrayBuffer" } = {}) {
  const row = await env.DB.prepare(
    `SELECT data FROM related_blob WHERE job_id = ? AND name = ?`
  ).bind(jobId, name).first();
  if (!row?.data) return null;
  const u8 = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
  if (type === "text") return new TextDecoder().decode(u8);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
async function putJson(env, jobId, name, obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  const gz = await gzipBytes(raw);
  await putBlob(env, jobId, name, gz);
}
async function getJson(env, jobId, name) {
  const ab = await getBlob(env, jobId, name);
  if (!ab) return null;
  try {
    const raw = await gunzipBytes(new Uint8Array(ab));
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(ab)));
    } catch {
      return null;
    }
  }
}
async function getRelatedMeta(env, jobId) {
  return getJson(env, jobId, "meta");
}
async function clearRelatedState(env, jobId) {
  try {
    await env.DB.prepare(`DELETE FROM related_blob WHERE job_id = ?`).bind(jobId).run();
  } catch {
  }
  if (env.CATALOG) {
    await env.CATALOG.delete(`rel:${jobId}:meta`).catch(() => {
    });
  }
}
async function loadAllEmbeddings(env, jobId, meta) {
  const m = meta.m;
  const dim = meta.dim || DIM;
  const out = new Array(m);
  const parts = meta.embedParts || [];
  for (const start of parts) {
    const ab = await getBlob(env, jobId, blobName("emb", start));
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
async function loadProducts(env, jobId) {
  const { results } = await env.DB.prepare(
    `SELECT product_number, description, cluster_id FROM products WHERE job_id = ?`
  ).bind(jobId).all();
  return (results || []).map((r) => ({
    product_number: String(r.product_number || "").trim(),
    description: String(r.description || ""),
    cluster_id: Number.isFinite(Number(r.cluster_id)) ? Number(r.cluster_id) : -1
  })).filter((p) => p.product_number);
}
async function runRelatedSlice(env, jobId, setProgress) {
  if (!env.AI) throw new Error("Workers AI binding missing");
  if (!env.DB) throw new Error("D1 DB binding missing");
  let meta = await getRelatedMeta(env, jobId);
  if (!meta || meta.phase === "init") {
    await setProgress({
      status: "running",
      error: "",
      detail: "Loading catalog\u2026",
      progress: 0.02,
      n_suggestions: 0
    });
    const products = await loadProducts(env, jobId);
    if (products.length < 2) {
      await clearRelatedState(env, jobId);
      await setProgress({
        status: "done",
        detail: "Too few products for Related",
        progress: 1,
        n_suggestions: 0
      });
      return { done: true, n_suggestions: 0 };
    }
    if (products.length > MAX_PRODUCTS) {
      throw new Error(
        `Catalog too large for Related (${products.length.toLocaleString()} > ${MAX_PRODUCTS.toLocaleString()})`
      );
    }
    await setProgress({
      status: "running",
      detail: `Deduplicating ${products.length.toLocaleString()} products\u2026`,
      progress: 0.04
    });
    const uniqIndex = /* @__PURE__ */ new Map();
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
    await putJson(env, jobId, "uniq", { texts: uniqTexts, rows: uniqRows });
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
      storage: "d1"
    };
    await putJson(env, jobId, "meta", meta);
    await setProgress({
      status: "running",
      detail: `Embedding ${m.toLocaleString()} unique texts (chunked)\u2026`,
      progress: 0.06
    });
    return { done: false };
  }
  if (meta.phase === "embed") {
    const uniq = await getJson(env, jobId, "uniq");
    if (!uniq?.texts) throw new Error("Related state missing unique texts");
    const { texts } = uniq;
    const m = meta.m;
    const start = meta.embedAt;
    const live = await getRelatedMeta(env, jobId);
    if (!live || live.phase !== "embed" || live.embedAt !== start) {
      return { done: false };
    }
    const stop = Math.min(start + EMBED_PER_SLICE, m);
    const packed = [];
    for (let i = start; i < stop; i += EMBED_BATCH) {
      const slice = texts.slice(i, Math.min(i + EMBED_BATCH, stop)).map((t) => (t || " ").slice(0, 2e3));
      const vecs = await embedBatch(env.AI, slice);
      packed.push(...vecs);
    }
    await putBlob(env, jobId, blobName("emb", start), packVectors(packed, meta.dim || DIM));
    meta.embedParts = meta.embedParts || [];
    if (!meta.embedParts.includes(start)) meta.embedParts.push(start);
    meta.embedAt = stop;
    if (stop >= m) {
      meta.phase = "score";
      meta.scoreAt = 0;
      await setProgress({
        status: "running",
        detail: `Finding Related neighbours (\u2265 ${(THRESHOLD * 100).toFixed(0)}%)\u2026`,
        progress: 0.62
      });
    } else {
      await setProgress({
        status: "running",
        detail: `Embedded ${stop.toLocaleString()}/${m.toLocaleString()}`,
        progress: 0.06 + 0.54 * (stop / m)
      });
    }
    await putJson(env, jobId, "meta", meta);
    return { done: false };
  }
  if (meta.phase === "score") {
    if (!meta.semanticCleared) {
      await env.DB.prepare(`DELETE FROM semantic WHERE job_id = ?`).bind(jobId).run();
      meta.semanticCleared = true;
      await putJson(env, jobId, "meta", meta);
    }
    const products = await loadProducts(env, jobId);
    const uniq = await getJson(env, jobId, "uniq");
    if (!products.length || !uniq?.rows) throw new Error("Related state incomplete for scoring");
    if (products.length !== meta.nProducts) {
      throw new Error(
        `Catalog changed during Related (${products.length} vs ${meta.nProducts}) \u2014 re-run fresh`
      );
    }
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
            semantic_score: Math.round(score * 1e4) / 1e4
          });
          kept += 1;
          if (kept >= TOP_K) break;
        }
      }
    }
    const chunk = 100;
    for (let i = 0; i < batchSug.length; i += chunk) {
      const slice = batchSug.slice(i, i + chunk);
      const stmts = slice.map(
        (s) => env.DB.prepare(
          `INSERT INTO semantic (
             job_id, product_number, suggested_product, suggested_cluster_id,
             suggested_description, semantic_score
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id, product_number, suggested_product) DO UPDATE SET
             suggested_cluster_id=excluded.suggested_cluster_id,
             suggested_description=excluded.suggested_description,
             semantic_score=excluded.semantic_score`
        ).bind(
          jobId,
          s.product_number,
          s.suggested_product,
          s.suggested_cluster_id,
          s.suggested_description,
          s.semantic_score
        )
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
        error: ""
      });
      await clearRelatedState(env, jobId);
      return { done: true, n_suggestions: nSug };
    }
    await putJson(env, jobId, "meta", meta);
    await setProgress({
      status: "running",
      detail: `Scored ${stop.toLocaleString()}/${m.toLocaleString()} \xB7 ${meta.nSuggestions.toLocaleString()} suggestions`,
      progress: 0.62 + 0.36 * (stop / m),
      n_suggestions: meta.nSuggestions
    });
    return { done: false };
  }
  await clearRelatedState(env, jobId);
  await setProgress({
    status: "done",
    detail: "complete",
    progress: 1,
    n_suggestions: meta?.nSuggestions || 0
  });
  return { done: true, n_suggestions: meta?.nSuggestions || 0 };
}
async function runRelatedJob(env, jobId, setProgress, { fresh = false } = {}) {
  if (fresh) {
    await clearRelatedState(env, jobId);
  }
  return runRelatedSlice(env, jobId, setProgress);
}
function kvMeta(jobId) {
  return jobId;
}

export {
  runRelatedJob,
  getRelatedMeta,
  kvMeta,
  getJson,
  putJson,
  clearRelatedState,
};
