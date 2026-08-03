/**
 * Auth gate + cleanup reviewer API + SPA shell.
 * Catalog storage: gzip + KV chunks (avoids 25 MiB single-key limit).
 * Related matching: Workers AI (permanent, no external backend).
 */

import { runRelatedJob, getJson, kvMeta } from "./related.js";

const COOKIE = "cleanup_session";
const SESSION_DAYS = 30;
const KV_CHUNK = 1 * 1024 * 1024; // 1 MiB chunks — safely under KV 25 MiB limit

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, ...extraHeaders },
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function relatedEnabled(env) {
  return Boolean(env.AI);
}

async function setRelatedProgress(env, jobId, fields) {
  const ts = nowIso();
  const status = fields.status != null ? String(fields.status).slice(0, 40) : null;
  const err = fields.error != null ? String(fields.error).slice(0, 500) : null;
  const detail = fields.detail != null ? String(fields.detail).slice(0, 240) : null;
  const progress =
    fields.progress != null && Number.isFinite(Number(fields.progress))
      ? Math.max(0, Math.min(1, Number(fields.progress)))
      : null;
  const n =
    fields.n_suggestions != null && Number.isFinite(Number(fields.n_suggestions))
      ? Number(fields.n_suggestions)
      : null;
  const token = fields.token != null ? String(fields.token) : null;

  try {
    await env.DB.prepare(
      `UPDATE progress SET
         related_status = COALESCE(?, related_status),
         related_error = COALESCE(?, related_error),
         related_detail = COALESCE(?, related_detail),
         related_progress = COALESCE(?, related_progress),
         related_n_suggestions = COALESCE(?, related_n_suggestions),
         related_token = COALESCE(?, related_token),
         updated_at = ?
       WHERE job_id = ?`,
    )
      .bind(status, err, detail, progress, n, token, ts, jobId)
      .run();
  } catch {
    await env.DB.prepare(
      `UPDATE progress SET related_status = COALESCE(?, related_status),
         related_error = COALESCE(?, related_error),
         related_n_suggestions = COALESCE(?, related_n_suggestions),
         updated_at = ?
       WHERE job_id = ?`,
    )
      .bind(status, err, n, ts, jobId)
      .run();
  }
}

async function kickRelatedSlices(env, jobId, { fresh = false, maxSlices = 4 } = {}) {
  try {
    if (fresh) {
      const r = await runRelatedJob(
        env,
        jobId,
        (fields) => setRelatedProgress(env, jobId, fields),
        { fresh: true },
      );
      if (r?.done) return;
      maxSlices -= 1;
    }
    for (let i = 0; i < maxSlices; i++) {
      const r = await runRelatedJob(
        env,
        jobId,
        (fields) => setRelatedProgress(env, jobId, fields),
        { fresh: false },
      );
      if (r?.done) return;
    }
    // Leave status=running — browser will POST /related/tick for the next batch.
    // Do NOT self-fetch the custom domain (that caused HTTP 522s).
  } catch (e) {
    await setRelatedProgress(env, jobId, {
      status: "failed",
      error: String(e?.message || e),
      detail: String(e?.message || e).slice(0, 240),
    });
  }
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeSession(env, email) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${email}|${exp}`;
  const sig = await hmacSign(env.SESSION_SECRET, payload);
  return `${payload}|${sig}`;
}

async function readSession(env, request) {
  if (!env.SESSION_SECRET) return null;
  const cookieHeader = request.headers.get("Cookie") || "";
  const part = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!part) return null;
  const raw = decodeURIComponent(part.slice(COOKIE.length + 1));
  const bits = raw.split("|");
  if (bits.length !== 3) return null;
  const [email, expStr, sig] = bits;
  const exp = Number(expStr);
  if (!email || !Number.isFinite(exp) || Date.now() > exp) return null;
  const expected = await hmacSign(env.SESSION_SECRET, `${email}|${exp}`);
  if (!timingSafeEqual(sig, expected)) return null;
  if (
    !timingSafeEqual(
      email.toLowerCase(),
      String(env.AUTH_EMAIL || "").toLowerCase(),
    )
  ) {
    return null;
  }
  return email;
}

function sessionCookie(value) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function loginPage(error = "") {
  const err = error
    ? `<p class="err" role="alert">${escapeHtml(error)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html { height: 100%; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh; width: 100%;
      display: grid; place-items: center; padding: 24px;
      font-family: "Outfit", "Segoe UI", sans-serif; color: #1b2430;
      background: radial-gradient(900px 480px at 50% 35%, #d5ebe7 0%, transparent 60%), #e8edf3;
    }
    .card {
      width: min(100%, 360px); margin: 0 auto; padding: 28px 24px 24px;
      background: #f7f8fa; border: 1px solid #c5cdd9; border-radius: 12px;
      box-shadow: 0 16px 36px rgba(27, 36, 48, 0.1);
    }
    .brand { margin: 0 0 10px; text-align: center; font-size: 0.7rem; font-weight: 700;
      letter-spacing: 0.16em; text-transform: uppercase; color: #0f766e; }
    h1 { margin: 0 0 6px; text-align: center; font-size: 1.45rem; font-weight: 700; }
    p.sub { margin: 0 0 20px; text-align: center; color: #5a6575; font-size: 0.92rem; }
    .field { margin: 0 0 12px; }
    label { display: block; font-size: 0.75rem; font-weight: 600; margin: 0 0 5px; color: #5a6575; }
    input {
      display: block; width: 100%; max-width: 100%; min-width: 0; padding: 11px 12px;
      border: 1px solid #c5cdd9; border-radius: 8px; font: inherit; font-size: 0.98rem; background: #fff;
    }
    input:focus { border-color: #0f766e; outline: none; box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.16); }
    button {
      display: block; width: 100%; margin-top: 6px; padding: 12px; background: #0f766e; color: #fff;
      border: 0; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
    }
    .err {
      margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; background: #fdecec;
      color: #a32828; font-size: 0.86rem; text-align: center;
    }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/login" autocomplete="on">
    <p class="brand">Marnus · private</p>
    <h1>Sign in</h1>
    <p class="sub">Data cleanup workspace</p>
    ${err}
    <div class="field"><label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username" /></div>
    <div class="field"><label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" /></div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;
}

function appShell() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Cleanup Review</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/app.css?v=18" />
  <script src="/xlsx.full.min.js?v=15"></script>
  <script>
    try {
      if (localStorage.getItem("cleanup-dark-mode") === "1") {
        document.documentElement.setAttribute("data-theme", "dark");
      }
    } catch (e) {}
  </script>
</head>
<body>
  <div class="app">
    <header class="top">
      <div class="brand">Marnus · cleanup</div>
      <div class="meta" id="topMeta">Upload a sheet to begin</div>
      <div class="actions">
        <button type="button" class="btn ghost" id="btnTheme" title="Toggle dark mode (T)">Dark</button>
        <button type="button" class="btn ghost" id="btnHome">Jobs</button>
        <button type="button" class="btn" id="btnReports" title="Reports (R)">Reports</button>
        <button type="button" class="btn" id="btnRelatedRun" title="Run Related matching on backend">Run Related</button>
        <button type="button" class="btn" id="btnExport">Export JSON</button>
        <button type="button" class="btn primary" id="btnFocus" title="App fullscreen + lock shortcuts (use this instead of F11)">Focus mode</button>
        <a class="btn ghost" href="/logout">Sign out</a>
      </div>
    </header>

    <section class="screen active" data-screen="upload">
      <div class="upload-wrap">
        <div class="upload-card">
          <h1>Start a cleanup job</h1>
          <p>A <strong>job</strong> is one saved review session for a workbook — every product is kept. Near-duplicates go into the review queue; unmatched products stay in the catalog and on the Excel <strong>Unmatched</strong> sheet. Drop a <strong>similarity results</strong> workbook (Grouped Review) or an <strong>FOExport</strong> sheet. FOExport is clustered in your browser (Jaccard ≥ 0.60); Related (≥ 0.50) runs on Cloudflare after upload.</p>
          <div class="drop" id="dropZone">Drop .xlsx here or click to choose</div>
          <input id="fileInput" type="file" accept=".xlsx,.xlsm" hidden />
          <div class="progress" id="uploadProgress">
            <div id="uploadProgressMsg">Working…</div>
            <div class="bar"><span id="uploadBar"></span></div>
          </div>
          <div class="job-list" id="jobList"></div>
        </div>
      </div>
    </section>

    <section class="screen" data-screen="review">
      <div class="review-body">
        <aside class="rail" id="queueRail"><h3>Queue</h3></aside>
        <div>
          <div class="hero" id="hero"></div>
          <div class="decision-bar">
            <button type="button" class="btn danger" id="btnDup">Duplicate ←</button>
            <button type="button" class="btn primary" id="btnUnique">Unique →</button>
            <button type="button" class="btn" id="btnDiscard">Discard ↑</button>
            <button type="button" class="btn" id="btnClear">Unreview ↓</button>
            <button type="button" class="btn" id="btnPrev">Prev parent</button>
            <button type="button" class="btn" id="btnNext">Next parent</button>
            <div class="help">Alt+↓ = next child · Ctrl+Alt+↓ = prev child · Space = next parent · ← dup · → unique · G = Related · R = Reports · T = dark · Focus mode locks keys</div>
          </div>
        </div>
        <aside class="related" id="relatedPanel"><h3>Related</h3></aside>
      </div>
    </section>

    <section class="screen" data-screen="reports">
      <div class="reports-wrap">
        <div class="reports-head">
          <h1>Reports</h1>
          <div class="reports-actions">
            <button type="button" class="btn" id="btnReportsRefresh">Refresh</button>
            <button type="button" class="btn primary" id="btnReportsExcel">Export Excel…</button>
            <button type="button" class="btn" id="btnReportsBack">← Back to review</button>
          </div>
        </div>
        <div class="kpi-row" id="reportsKpis"></div>
        <pre class="reports-summary" id="reportsSummary"></pre>
        <div class="reports-split">
          <div>
            <h2>Duplicates marked</h2>
            <div class="table-scroll">
              <table class="report-table" id="reportsDupTable">
                <thead><tr><th>Product</th><th>Cluster</th><th>Linked to</th><th>Score</th><th>Updated</th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
          <div>
            <h2>Cluster progress</h2>
            <div class="table-scroll">
              <table class="report-table" id="reportsClusterTable">
                <thead><tr><th>Cluster</th><th>Reference</th><th>Size</th><th>Marked</th><th>Dup</th><th>Unique</th><th>Done</th><th>Time</th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
  <script type="module" src="/app.js?v=20"></script>
</body>
</html>`;
}

function uid() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function splitChunks(bytes, size) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) {
    // IMPORTANT: copy — KV rejects oversized puts if given a subarray *view*
    // over a huge underlying buffer in some runtimes.
    chunks.push(bytes.slice(i, Math.min(i + size, bytes.length)));
  }
  return chunks.length ? chunks : [new Uint8Array(0)];
}

async function putCatalogChunks(env, jobId, gzipped) {
  const chunks = splitChunks(gzipped, KV_CHUNK);
  const meta = {
    v: 2,
    encoding: "gzip-json",
    bytes: gzipped.length,
    chunks: chunks.length,
  };
  await env.CATALOG.put(`job:${jobId}:meta`, JSON.stringify(meta));
  for (let i = 0; i < chunks.length; i++) {
    await env.CATALOG.put(`job:${jobId}:c:${i}`, chunks[i]);
  }
  await env.CATALOG.delete(`job:${jobId}`);
  return chunks.length;
}

async function getCatalogObject(env, jobId) {
  const metaRaw = await env.CATALOG.get(`job:${jobId}:meta`);
  if (metaRaw) {
    const meta = JSON.parse(metaRaw);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const part = await env.CATALOG.get(`job:${jobId}:c:${i}`, { type: "arrayBuffer" });
      if (!part) throw new Error(`Missing catalog chunk ${i}`);
      parts.push(new Uint8Array(part));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    const raw = await gunzipBytes(merged);
    return JSON.parse(new TextDecoder().decode(raw));
  }

  // Legacy single JSON key
  const legacy = await env.CATALOG.get(`job:${jobId}`);
  if (!legacy) return null;
  return JSON.parse(legacy);
}

async function deleteJobCatalog(env, jobId) {
  const metaRaw = await env.CATALOG.get(`job:${jobId}:meta`);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      const n = Number(meta.chunks) || 0;
      for (let i = 0; i < n; i++) {
        await env.CATALOG.delete(`job:${jobId}:c:${i}`);
      }
    } catch {
      /* ignore bad meta */
    }
    await env.CATALOG.delete(`job:${jobId}:meta`);
  }
  await env.CATALOG.delete(`job:${jobId}`);
}

/**
 * Expand compact wire format → runtime catalog shape used by the SPA.
 */
function expandCatalog(wire) {
  if (wire.by_product && wire.clusters && wire.cluster_order) {
    return wire; // already full shape
  }
  const products = wire.products || {};
  const cluster_order = wire.cluster_order || [];
  const clusters = {};
  const by_product = {};
  for (const [pn, p] of Object.entries(products)) {
    const item = {
      cluster_id: p.c,
      cluster_size: p.s || 0,
      position_in_cluster: p.p || 0,
      depth: p.d || 0,
      product_number: pn,
      description: p.desc || "",
      linked_to_product: p.l || "",
      score_to_parent: p.sc ?? "",
      n_similar_in_cluster: Math.max((p.s || 0) - 1, 0),
      exact_dup_group: "",
    };
    by_product[pn] = item;
    if (!clusters[item.cluster_id]) clusters[item.cluster_id] = [];
    clusters[item.cluster_id].push(item);
  }
  for (const cid of Object.keys(clusters)) {
    clusters[cid].sort(
      (a, b) => a.depth - b.depth || a.position_in_cluster - b.position_in_cluster,
    );
    const size = clusters[cid].length;
    for (const it of clusters[cid]) {
      it.cluster_size = size;
      it.n_similar_in_cluster = Math.max(size - 1, 0);
    }
  }
  let order = cluster_order.filter((cid) => clusters[cid]?.length);
  if (!order.length) {
    order = Object.keys(clusters)
      .map(Number)
      .sort((a, b) => (clusters[b]?.length || 0) - (clusters[a]?.length || 0));
  }
  const semantic = {};
  for (const [pn, arr] of Object.entries(wire.semantic || {})) {
    semantic[pn] = (arr || []).map((row) => ({
      suggested_product: row[0],
      semantic_score: row[1],
      suggested_description: row[2] || "",
      suggested_cluster_id: row[3] ?? null,
    }));
  }
  return {
    cluster_order: order,
    clusters,
    by_product,
    semantic,
    stats: wire.stats || {
      n_products: Object.keys(by_product).length,
      n_clusters: order.length,
    },
  };
}

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    return json({ relatedBackend: relatedEnabled(env) });
  }

  if (path === "/api/jobs" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, source_kind, created_at, updated_at, n_products, n_clusters, cluster_index
       FROM jobs ORDER BY updated_at DESC LIMIT 50`,
    ).all();
    return json({ jobs: results || [] });
  }

  // Create job metadata only — catalog uploaded separately as gzip chunks
  if (path === "/api/jobs" && request.method === "POST") {
    const body = await request.json();
    const id = uid();
    const name = String(body.name || "job.xlsx").slice(0, 200);
    const kind = String(body.source_kind || "results").slice(0, 40);
    const ts = nowIso();
    const nProducts = Number(body.n_products) || 0;
    const nClusters = Number(body.n_clusters) || 0;

    await env.DB.prepare(
      `INSERT INTO jobs (id, name, source_kind, created_at, updated_at, n_products, n_clusters, cluster_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(id, name, kind, ts, ts, nProducts, nClusters)
      .run();
    await env.DB.prepare(
      `INSERT INTO progress (job_id, clusters_completed, parent_times, updated_at) VALUES (?, '[]', '{}', ?)`,
    )
      .bind(id, ts)
      .run();

    return json({ id });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(.*)$/);
  if (!jobMatch) return json({ error: "Not found" }, 404);
  const jobId = jobMatch[1];
  const rest = jobMatch[2] || "";

  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first();
  if (!job) return json({ error: "Job not found" }, 404);

  if ((rest === "" || rest === "/") && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM decisions WHERE job_id = ?`).bind(jobId),
      env.DB.prepare(`DELETE FROM cluster_moves WHERE job_id = ?`).bind(jobId),
      env.DB.prepare(`DELETE FROM progress WHERE job_id = ?`).bind(jobId),
      env.DB.prepare(`DELETE FROM products WHERE job_id = ?`).bind(jobId),
      env.DB.prepare(`DELETE FROM semantic WHERE job_id = ?`).bind(jobId),
      env.DB.prepare(`DELETE FROM job_meta WHERE job_id = ?`).bind(jobId),
      env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId),
    ]);
    try {
      await deleteJobCatalog(env, jobId);
    } catch (e) {
      console.warn("KV catalog cleanup failed", e);
    }
    return json({ ok: true });
  }

  // --- Catalog via D1 (no KV — avoids "Set maximum size exceeded") ---

  if (rest === "/products" && request.method === "POST") {
    const body = await request.json();
    const rows = Array.isArray(body.products) ? body.products : [];
    if (!rows.length) return json({ error: "No products" }, 400);
    if (rows.length > 400) return json({ error: "Max 400 products per batch" }, 400);

    const stmts = rows.map((p) =>
      env.DB.prepare(
        `INSERT INTO products (
           job_id, product_number, cluster_id, cluster_size, position_in_cluster,
           depth, description, linked_to_product, score_to_parent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, product_number) DO UPDATE SET
           cluster_id=excluded.cluster_id,
           cluster_size=excluded.cluster_size,
           position_in_cluster=excluded.position_in_cluster,
           depth=excluded.depth,
           description=excluded.description,
           linked_to_product=excluded.linked_to_product,
           score_to_parent=excluded.score_to_parent`,
      ).bind(
        jobId,
        String(p.product_number || "").slice(0, 120),
        Number(p.cluster_id) || 0,
        Number(p.cluster_size) || 0,
        Number(p.position_in_cluster) || 0,
        Number(p.depth) || 0,
        String(p.description || "").slice(0, 2000),
        String(p.linked_to_product || "").slice(0, 120),
        p.score_to_parent == null || p.score_to_parent === ""
          ? null
          : Number(p.score_to_parent),
      ),
    );
    await env.DB.batch(stmts);
    return json({ ok: true, inserted: rows.length });
  }

  if (rest === "/semantic" && request.method === "POST") {
    const body = await request.json();
    const rows = Array.isArray(body.items) ? body.items : [];
    if (!rows.length) return json({ ok: true, inserted: 0 });
    if (rows.length > 400) return json({ error: "Max 400 semantic rows per batch" }, 400);
    const stmts = rows.map((s) =>
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
        String(s.product_number || "").slice(0, 120),
        String(s.suggested_product || "").slice(0, 120),
        s.suggested_cluster_id == null ? null : Number(s.suggested_cluster_id),
        String(s.suggested_description || "").slice(0, 200),
        s.semantic_score == null || s.semantic_score === ""
          ? null
          : Number(s.semantic_score),
      ),
    );
    await env.DB.batch(stmts);
    return json({ ok: true, inserted: rows.length });
  }

  if (rest === "/finalize" && request.method === "POST") {
    const body = await request.json();
    const order = Array.isArray(body.cluster_order) ? body.cluster_order : [];
    const ts = nowIso();
    await env.DB.prepare(
      `INSERT INTO job_meta (job_id, cluster_order) VALUES (?, ?)
       ON CONFLICT(job_id) DO UPDATE SET cluster_order=excluded.cluster_order`,
    )
      .bind(jobId, JSON.stringify(order))
      .run();
    await env.DB.prepare(
      `UPDATE jobs SET n_products = ?, n_clusters = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        Number(body.n_products) || job.n_products,
        Number(body.n_clusters) || order.length,
        ts,
        jobId,
      )
      .run();
    return json({ ok: true });
  }

  if (rest === "" && request.method === "GET") {
    const meta = await env.DB.prepare(
      `SELECT cluster_order FROM job_meta WHERE job_id = ?`,
    )
      .bind(jobId)
      .first();

    const prodRows = await env.DB.prepare(
      `SELECT product_number, cluster_id, cluster_size, position_in_cluster, depth,
              description, linked_to_product, score_to_parent
       FROM products WHERE job_id = ?`,
    )
      .bind(jobId)
      .all();

    const by_product = {};
    const clusters = {};
    for (const row of prodRows.results || []) {
      const item = {
        cluster_id: row.cluster_id,
        cluster_size: row.cluster_size,
        position_in_cluster: row.position_in_cluster,
        depth: row.depth,
        product_number: row.product_number,
        description: row.description || "",
        linked_to_product: row.linked_to_product || "",
        score_to_parent: row.score_to_parent,
        n_similar_in_cluster: Math.max((row.cluster_size || 0) - 1, 0),
        exact_dup_group: "",
      };
      by_product[item.product_number] = item;
      if (!clusters[item.cluster_id]) clusters[item.cluster_id] = [];
      clusters[item.cluster_id].push(item);
    }
    for (const cid of Object.keys(clusters)) {
      clusters[cid].sort(
        (a, b) =>
          a.depth - b.depth || a.position_in_cluster - b.position_in_cluster,
      );
    }

    let cluster_order = [];
    try {
      cluster_order = JSON.parse(meta?.cluster_order || "[]");
    } catch {
      cluster_order = [];
    }
    if (!cluster_order.length) {
      cluster_order = Object.keys(clusters)
        .map(Number)
        .filter((cid) => (clusters[cid]?.length || 0) > 1)
        .sort((a, b) => (clusters[b]?.length || 0) - (clusters[a]?.length || 0));
    } else {
      // Review queue must stay multi-item only even if meta was stale
      cluster_order = cluster_order.filter((cid) => (clusters[cid]?.length || 0) > 1);
    }
    cluster_order = cluster_order.filter((cid) => clusters[cid]?.length);

    const semRows = await env.DB.prepare(
      `SELECT product_number, suggested_product, suggested_cluster_id,
              suggested_description, semantic_score
       FROM semantic WHERE job_id = ?`,
    )
      .bind(jobId)
      .all();
    const semantic = {};
    for (const row of semRows.results || []) {
      if (!semantic[row.product_number]) semantic[row.product_number] = [];
      semantic[row.product_number].push({
        suggested_product: row.suggested_product,
        suggested_cluster_id: row.suggested_cluster_id,
        suggested_description: row.suggested_description || "",
        semantic_score: row.semantic_score,
      });
    }

    const catalog = {
      cluster_order,
      clusters,
      by_product,
      semantic,
      stats: {
        n_products: Object.keys(by_product).length,
        n_clusters: cluster_order.length,
      },
    };

    const decisionsRows = await env.DB.prepare(
      `SELECT product_number, status, cluster_id, note, updated_at FROM decisions WHERE job_id = ?`,
    )
      .bind(jobId)
      .all();
    const decisions = {};
    for (const row of decisionsRows.results || []) {
      decisions[row.product_number] = {
        status: row.status,
        cluster_id: row.cluster_id,
        note: row.note,
        updated_at: row.updated_at,
      };
    }

    const moveRows = await env.DB.prepare(
      `SELECT product_number, cluster_id, from_cluster_id, linked_to_product, semantic_score, updated_at
       FROM cluster_moves WHERE job_id = ?`,
    )
      .bind(jobId)
      .all();
    const moves = {};
    for (const row of moveRows.results || []) {
      moves[row.product_number] = {
        cluster_id: row.cluster_id,
        from_cluster_id: row.from_cluster_id,
        linked_to_product: row.linked_to_product,
        semantic_score: row.semantic_score,
        updated_at: row.updated_at,
      };
    }

    let prog;
    try {
      prog = await env.DB.prepare(
        `SELECT clusters_completed, parent_times, updated_at,
                related_status, related_error, related_n_suggestions,
                related_progress, related_detail
         FROM progress WHERE job_id = ?`,
      )
        .bind(jobId)
        .first();
    } catch {
      prog = await env.DB.prepare(
        `SELECT clusters_completed, parent_times, updated_at,
                related_status, related_error, related_n_suggestions
         FROM progress WHERE job_id = ?`,
      )
        .bind(jobId)
        .first();
    }
    let clusters_completed = [];
    let parent_times = {};
    try {
      clusters_completed = JSON.parse(prog?.clusters_completed || "[]");
    } catch {
      clusters_completed = [];
    }
    try {
      parent_times = JSON.parse(prog?.parent_times || "{}");
      if (!parent_times || typeof parent_times !== "object") parent_times = {};
    } catch {
      parent_times = {};
    }

    return json({
      job,
      catalog,
      decisions,
      moves,
      clusters_completed,
      parent_times,
      progress_updated_at: prog?.updated_at || null,
      related: {
        status: prog?.related_status || "idle",
        error: prog?.related_error || "",
        detail: prog?.related_detail || "",
        progress: Number(prog?.related_progress) || 0,
        n_suggestions: prog?.related_n_suggestions || 0,
        backend: relatedEnabled(env),
      },
    });
  }

  if (rest === "/decisions" && request.method === "PUT") {
    const body = await request.json();
    const pn = String(body.product_number || "").trim();
    const status = String(body.status || "").trim();
    if (!pn || !status) return json({ error: "Missing fields" }, 400);
    const ts = nowIso();
    await env.DB.prepare(
      `INSERT INTO decisions (job_id, product_number, status, cluster_id, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, product_number) DO UPDATE SET
         status=excluded.status,
         cluster_id=excluded.cluster_id,
         note=excluded.note,
         updated_at=excluded.updated_at`,
    )
      .bind(
        jobId,
        pn,
        status,
        body.cluster_id ?? null,
        body.note || "",
        ts,
      )
      .run();
    await env.DB.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`)
      .bind(ts, jobId)
      .run();
    return json({ ok: true });
  }

  if (rest === "/decisions" && request.method === "DELETE") {
    const body = await request.json();
    const pn = String(body.product_number || "").trim();
    await env.DB.prepare(
      `DELETE FROM decisions WHERE job_id = ? AND product_number = ?`,
    )
      .bind(jobId, pn)
      .run();
    return json({ ok: true });
  }

  if (rest === "/progress" && request.method === "PUT") {
    const body = await request.json();
    const ts = nowIso();
    const completed = JSON.stringify(body.clusters_completed || []);
    const parentTimes = JSON.stringify(body.parent_times || {});
    await env.DB.prepare(
      `INSERT INTO progress (job_id, clusters_completed, parent_times, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         clusters_completed=excluded.clusters_completed,
         parent_times=excluded.parent_times,
         updated_at=excluded.updated_at`,
    )
      .bind(jobId, completed, parentTimes, ts)
      .run();
    if (body.cluster_index != null) {
      await env.DB.prepare(
        `UPDATE jobs SET cluster_index = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(Number(body.cluster_index) || 0, ts, jobId)
        .run();
    }
    return json({ ok: true });
  }

  if (rest === "/pull" && request.method === "POST") {
    const body = await request.json();
    const pn = String(body.product_number || "").trim();
    const clusterId = Number(body.cluster_id);
    if (!pn || !Number.isFinite(clusterId)) {
      return json({ error: "Missing fields" }, 400);
    }
    const ts = nowIso();
    await env.DB.prepare(
      `INSERT INTO cluster_moves (job_id, product_number, cluster_id, from_cluster_id, linked_to_product, semantic_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, product_number) DO UPDATE SET
         cluster_id=excluded.cluster_id,
         from_cluster_id=excluded.from_cluster_id,
         linked_to_product=excluded.linked_to_product,
         semantic_score=excluded.semantic_score,
         updated_at=excluded.updated_at`,
    )
      .bind(
        jobId,
        pn,
        clusterId,
        body.from_cluster_id ?? null,
        body.linked_to_product || "",
        body.semantic_score ?? null,
        ts,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO decisions (job_id, product_number, status, cluster_id, note, updated_at)
       VALUES (?, ?, 'duplicate', ?, 'pulled_from_related', ?)
       ON CONFLICT(job_id, product_number) DO UPDATE SET
         status='duplicate', cluster_id=excluded.cluster_id, note='pulled_from_related', updated_at=excluded.updated_at`,
    )
      .bind(jobId, pn, clusterId, ts)
      .run();
    await env.DB.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`)
      .bind(ts, jobId)
      .run();
    return json({ ok: true });
  }

  if (rest === "/related/run" && request.method === "POST") {
    if (!relatedEnabled(env)) {
      return json(
        { error: "Workers AI not bound", hint: "Add [ai] binding = \"AI\" in wrangler.toml and redeploy" },
        503,
      );
    }
    const body = await request.json().catch(() => ({}));
    const forceFresh = body?.fresh === true;
    let fresh = forceFresh;
    if (!forceFresh) {
      const meta = await getJson(env, kvMeta(jobId));
      const resumable = meta && (meta.phase === "embed" || meta.phase === "score");
      fresh = !resumable;
    }
    await setRelatedProgress(env, jobId, {
      status: "queued",
      error: "",
      detail: fresh ? "queued on Cloudflare (chunked)" : "resuming Related…",
      progress: fresh ? 0 : undefined,
      n_suggestions: fresh ? 0 : undefined,
    });
    const kick = () => kickRelatedSlices(env, jobId, { fresh, maxSlices: 4 });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(kick());
    else await kick();
    return json({ ok: true, status: "queued", fresh });
  }

  // Browser-driven next chunk (avoids Worker→self fetch which caused 522s)
  if (rest === "/related/tick" && request.method === "POST") {
    if (!relatedEnabled(env)) return json({ error: "Workers AI not bound" }, 503);
    const meta = await getJson(env, kvMeta(jobId));
    if (!meta || (meta.phase !== "embed" && meta.phase !== "score")) {
      return json({ ok: true, done: true, idle: true });
    }
    const kick = () => kickRelatedSlices(env, jobId, { fresh: false, maxSlices: 4 });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(kick());
    else await kick();
    return json({ ok: true, continued: true }, 202);
  }

  if (rest === "/related/status" && request.method === "GET") {
    let prog;
    try {
      prog = await env.DB.prepare(
        `SELECT related_status, related_error, related_n_suggestions,
                related_progress, related_detail, updated_at
         FROM progress WHERE job_id = ?`,
      )
        .bind(jobId)
        .first();
    } catch {
      prog = await env.DB.prepare(
        `SELECT related_status, related_error, related_n_suggestions, updated_at
         FROM progress WHERE job_id = ?`,
      )
        .bind(jobId)
        .first();
    }
    return json({
      status: prog?.related_status || "idle",
      error: prog?.related_error || "",
      detail: prog?.related_detail || "",
      progress: Number(prog?.related_progress) || 0,
      n_suggestions: prog?.related_n_suggestions || 0,
      updated_at: prog?.updated_at || null,
      backend: relatedEnabled(env),
    });
  }

  if (rest === "/export" && request.method === "GET") {
    const decisionsRows = await env.DB.prepare(
      `SELECT product_number, status, cluster_id, note, updated_at FROM decisions WHERE job_id = ? ORDER BY updated_at`,
    )
      .bind(jobId)
      .all();
    const moveRows = await env.DB.prepare(
      `SELECT * FROM cluster_moves WHERE job_id = ?`,
    )
      .bind(jobId)
      .all();
    const prog = await env.DB.prepare(
      `SELECT clusters_completed, parent_times, updated_at FROM progress WHERE job_id = ?`,
    )
      .bind(jobId)
      .first();
    let clusters_completed = [];
    let parent_times = {};
    try {
      clusters_completed = JSON.parse(prog?.clusters_completed || "[]");
    } catch {
      clusters_completed = [];
    }
    try {
      parent_times = JSON.parse(prog?.parent_times || "{}") || {};
    } catch {
      parent_times = {};
    }
    return new Response(
      JSON.stringify(
        {
          job,
          decisions: decisionsRows.results || [],
          cluster_moves: moveRows.results || [],
          clusters_completed,
          parent_times,
          progress_updated_at: prog?.updated_at || null,
          exported_at: nowIso(),
        },
        null,
        2,
      ),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="review_decisions__${jobId}.json"`,
        },
      },
    );
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!env.AUTH_EMAIL || !env.AUTH_PASSWORD || !env.SESSION_SECRET) {
      return html(loginPage("Server secrets not configured yet."), 503);
    }

    if (url.pathname === "/logout") {
      return redirect("/", { "Set-Cookie": clearCookie() });
    }

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") || "").trim();
      const password = String(form.get("password") || "");
      const emailOk = timingSafeEqual(
        email.toLowerCase(),
        String(env.AUTH_EMAIL).toLowerCase(),
      );
      const passOk = timingSafeEqual(password, String(env.AUTH_PASSWORD));
      if (!emailOk || !passOk) {
        return html(loginPage("Invalid email or password."), 401);
      }
      const token = await makeSession(env, String(env.AUTH_EMAIL));
      return redirect("/", { "Set-Cookie": sessionCookie(token) });
    }

    const session = await readSession(env, request);
    if (!session) {
      if (url.pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, 401);
      if (
        url.pathname === "/app.js" ||
        url.pathname === "/app.css" ||
        url.pathname === "/engine.js"
      ) {
        return json({ error: "Unauthorized" }, 401);
      }
      return html(loginPage());
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 500);
      }
    }

    if (
      url.pathname === "/app.js" ||
      url.pathname === "/app.css" ||
      url.pathname === "/engine.js" ||
      url.pathname === "/xlsx.full.min.js"
    ) {
      // Strip cache-bust query for asset lookup
      const assetUrl = new URL(request.url);
      assetUrl.search = "";
      return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    }

    if (url.pathname === "/favicon.ico") {
      // Tiny teal SVG — avoids console 404 noise
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0f766e"/><text x="16" y="22" text-anchor="middle" font-size="16" font-family="Segoe UI,sans-serif" fill="#fff" font-weight="700">C</text></svg>`;
      return new Response(svg, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/app") {
      return html(appShell());
    }

    return env.ASSETS.fetch(request);
  },
};
