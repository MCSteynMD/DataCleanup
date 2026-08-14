import { clusterProducts, tokenDiff, buildPass2Catalog } from "./engine.js?v=17";

/** Parent/reference description for alphabetical cluster ordering. */
function clusterParentName(clusters, cid) {
  const items = clusters?.[cid] || [];
  if (!items.length) return "";
  const root =
    items.find((it) => Number(it.depth) === 0) ||
    items.slice().sort((a, b) => (a.position_in_cluster || 0) - (b.position_in_cluster || 0))[0];
  return String(root?.description || "").trim();
}

/** Sort review cluster ids A→Z by parent item name (description). */
function sortClusterOrderByName(clusterOrder, clusters) {
  return (clusterOrder || []).slice().sort((a, b) => {
    const na = clusterParentName(clusters, a).toLocaleLowerCase();
    const nb = clusterParentName(clusters, b).toLocaleLowerCase();
    return na.localeCompare(nb) || Number(a) - Number(b);
  });
}

const $ = (sel) => document.querySelector(sel);
const THEME_KEY = "cleanup-dark-mode";
const state = {
  pass: 1,
  jobId: null,
  jobName: "",
  catalog: null,
  decisions: {},
  moves: {},
  relatedDumps: new Set(), // `${clusterId}|${suggested_product}`
  completed: new Set(),
  parentTimes: {},
  progressUpdatedAt: "",
  clusterIndex: 0,
  selected: "",
  reference: "",
  candidates: [],
  timerClusterId: null,
  timerStartedAt: null,
  clockHandle: null,
};

function dumpKey(clusterId, suggestedProduct) {
  return `${Number(clusterId)}|${String(suggestedProduct)}`;
}

function loadRelatedDumps(rows) {
  const set = new Set();
  for (const r of rows || []) {
    if (r?.suggested_product == null || r?.cluster_id == null) continue;
    set.add(dumpKey(r.cluster_id, r.suggested_product));
  }
  state.relatedDumps = set;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    location.href = "/";
    throw new Error("Unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const el = document.querySelector(`[data-screen="${name}"]`);
  if (el) el.classList.add("active");
}

function setProgress(on, msg = "", pct = 0) {
  const box = $("#uploadProgress");
  if (box) {
    box.classList.toggle("on", on);
    const m = $("#uploadProgressMsg");
    if (m) m.textContent = msg;
    const bar = $("#uploadBar");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  // Global overlay (also used when opening saved jobs)
  let overlay = $("#bootOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "bootOverlay";
    overlay.innerHTML = `<div class="card"><div class="msg" id="bootMsg"></div><div class="sub" id="bootSub">Please wait…</div><div class="bar"><span id="bootBar"></span></div></div>`;
    document.body.appendChild(overlay);
  }
  overlay.classList.toggle("on", on);
  const bm = $("#bootMsg");
  const bb = $("#bootBar");
  if (bm) bm.textContent = msg || "Working…";
  if (bb) bb.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function normalizeStatus(s) {
  if (s === "same") return "duplicate";
  if (s === "different") return "unique";
  return s || "unreviewed";
}

function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try {
    localStorage.setItem(THEME_KEY, dark ? "1" : "0");
  } catch {
    /* ignore */
  }
  const btn = $("#btnTheme");
  if (btn) btn.textContent = dark ? "Light" : "Dark";
}

function toggleTheme() {
  applyTheme(!isDarkTheme());
}

function initTheme() {
  let dark = false;
  try {
    dark = localStorage.getItem(THEME_KEY) === "1";
  } catch {
    /* ignore */
  }
  applyTheme(dark);
}

const STATUS_LABELS = {
  duplicate: "Duplicate",
  unique: "Unique",
  discard: "Discard",
  skip: "Skip",
  unreviewed: "Unreviewed",
};

function statusLabel(s) {
  return STATUS_LABELS[normalizeStatus(s)] || "Unreviewed";
}

function formatScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function isDrawingNumber(token) {
  return Boolean(token) && /^[^\s-]+-[^\s-]+-[^\s-]+$/.test(String(token).trim());
}

function drawingPartsShared(raw, sharedSet) {
  if (!isDrawingNumber(raw)) return false;
  const parts = String(raw).toUpperCase().split("-").filter(Boolean);
  return parts.length > 0 && parts.every((p) => sharedSet.has(p));
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "—";
  const total = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function parentTimesNormalized() {
  const out = {};
  for (const [key, value] of Object.entries(state.parentTimes || {})) {
    const secs = Number(value);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    out[String(key)] = secs;
  }
  return out;
}

function accumulatedParentSeconds(cid) {
  if (cid == null) return 0;
  return Number(state.parentTimes[String(cid)] || 0) || 0;
}

function liveParentSeconds(cid = state.timerClusterId) {
  let seconds = accumulatedParentSeconds(cid);
  if (
    cid != null &&
    state.timerClusterId === cid &&
    state.timerStartedAt != null
  ) {
    seconds += Math.max(0, (performance.now() - state.timerStartedAt) / 1000);
  }
  return seconds;
}

function pauseParentTimer({ persist = true } = {}) {
  if (state.timerClusterId == null || state.timerStartedAt == null) {
    state.timerStartedAt = null;
    return;
  }
  const key = String(state.timerClusterId);
  const prior = Number(state.parentTimes[key] || 0) || 0;
  const elapsed = Math.max(0, (performance.now() - state.timerStartedAt) / 1000);
  state.parentTimes[key] = prior + elapsed;
  state.timerStartedAt = null;
  state.timerClusterId = null;
  if (persist && state.jobId) persistProgress().catch(() => {});
}

function resumeParentTimer(cid = null) {
  if (!isReviewScreen()) return;
  const order = state.catalog?.cluster_order || [];
  if (cid == null) cid = order[state.clusterIndex];
  if (cid == null) return;
  if (state.timerClusterId === cid && state.timerStartedAt != null) return;
  if (state.timerStartedAt != null) pauseParentTimer({ persist: true });
  state.timerClusterId = cid;
  state.timerStartedAt = performance.now();
}

function ensureClock() {
  if (state.clockHandle) return;
  state.clockHandle = setInterval(() => {
    if (isReviewScreen() && state.timerStartedAt != null) updateTop();
  }, 1000);
}

function pct(part, whole) {
  return whole ? (100 * part) / whole : 0;
}

function computeReviewStats() {
  const byProduct = state.catalog?.by_product || {};
  const clusters = state.catalog?.clusters || {};
  const clusterOrder = state.catalog?.cluster_order || [];
  const reviewCids = new Set(clusterOrder);
  const decisions = state.decisions || {};
  const completed = state.completed || new Set();
  const counts = { duplicate: 0, unique: 0, discard: 0, skip: 0 };

  // Parent/reference products are not in the duel queue — exclude them from
  // reviewable totals so "all children marked" can reach 100%.
  const parentPns = new Set();
  for (const cid of clusterOrder) {
    const root = clusterRoot(clusters[cid] || []);
    if (root?.product_number) parentPns.add(root.product_number);
  }

  let reviewedInQueue = 0;
  for (const [pn, dec] of Object.entries(decisions)) {
    const item = byProduct[pn];
    if (!item) continue;
    if (parentPns.has(pn)) continue;
    const st = normalizeStatus(dec.status);
    if (counts[st] != null) counts[st] += 1;
    if (reviewCids.has(item.cluster_id) && (item.cluster_size || 0) > 1) {
      reviewedInQueue += 1;
    }
  }
  const reviewed = counts.duplicate + counts.unique + counts.discard + counts.skip;
  const total = Object.keys(byProduct).length;
  let unmatched = 0;
  let reviewable = 0;
  for (const cid of clusterOrder) {
    reviewable += clusterCandidates(clusters[cid] || []).length;
  }
  for (const it of Object.values(byProduct)) {
    if ((it.cluster_size || 0) <= 1) unmatched += 1;
  }
  const nClusters = clusterOrder.length;
  const nClustersDone = clusterOrder.filter((cid) => completed.has(cid)).length;
  const currentClusterId = clusterOrder[state.clusterIndex] ?? null;
  let currentClusterSize = 0;
  let currentClusterReviewed = 0;
  if (currentClusterId != null) {
    const cands = clusterCandidates(clusters[currentClusterId] || []);
    currentClusterSize = cands.length;
    currentClusterReviewed = cands.filter((i) => decisions[i.product_number]).length;
  }
  const times = { ...parentTimesNormalized() };
  if (state.timerClusterId != null && state.timerStartedAt != null) {
    const key = String(state.timerClusterId);
    times[key] = liveParentSeconds(state.timerClusterId);
  }
  const timedParents = Object.keys(times).length;
  const totalParentSeconds = Object.values(times).reduce((a, b) => a + b, 0);
  const remainingQueue = Math.max(reviewable - reviewedInQueue, 0);
  return {
    total,
    reviewable,
    unmatched,
    reviewed,
    reviewed_in_queue: reviewedInQueue,
    remaining: remainingQueue,
    remaining_queue: remainingQueue,
    reviewed_pct: pct(reviewedInQueue, reviewable),
    n_clusters: nClusters,
    n_clusters_done: nClustersDone,
    clusters_done_pct: pct(nClustersDone, nClusters),
    duplicate: counts.duplicate,
    unique: counts.unique,
    discard: counts.discard,
    skip: counts.skip,
    duplicate_pct_of_reviewed: pct(counts.duplicate, reviewed),
    unique_pct_of_reviewed: pct(counts.unique, reviewed),
    discard_pct_of_reviewed: pct(counts.discard, reviewed),
    skip_pct_of_reviewed: pct(counts.skip, reviewed),
    duplicate_pct_of_total: pct(counts.duplicate, total),
    current_cluster_id: currentClusterId,
    current_cluster_index: state.clusterIndex,
    current_cluster_reviewed: currentClusterReviewed,
    current_cluster_size: currentClusterSize,
    timed_parents: timedParents,
    total_parent_seconds: totalParentSeconds,
    avg_seconds_per_parent: timedParents ? totalParentSeconds / timedParents : 0,
    source_file: state.jobName || "",
    updated_at: state.progressUpdatedAt || "",
  };
}

function formatReviewStats(stats) {
  const lines = [
    "REVIEW STATISTICS",
    "=".repeat(40),
    "",
    "Catalog",
    `  Products total     ${stats.total.toLocaleString()}`,
    `  In review queue    ${stats.reviewable.toLocaleString()} (near-duplicate clusters)`,
    `  Unmatched kept     ${stats.unmatched.toLocaleString()} (no near-dupe — not dropped)`,
    "",
    "Review progress (queue only)",
    `  Reviewed     ${stats.reviewed_in_queue.toLocaleString()} / ${stats.reviewable.toLocaleString()}  (${stats.reviewed_pct.toFixed(1)}%)`,
    `  Remaining    ${stats.remaining.toLocaleString()}`,
    "",
    "Clusters",
    `  Completed    ${stats.n_clusters_done.toLocaleString()} / ${stats.n_clusters.toLocaleString()}  (${stats.clusters_done_pct.toFixed(1)}%)`,
  ];
  if (stats.current_cluster_id != null) {
    lines.push(
      `  Current      cluster ${stats.current_cluster_index + 1} (id ${stats.current_cluster_id}) — ${stats.current_cluster_reviewed.toLocaleString()} / ${stats.current_cluster_size.toLocaleString()} marked`,
    );
  }
  lines.push(
    "",
    "Time per parent",
    `  Parents timed ${stats.timed_parents.toLocaleString()}`,
    `  Total time    ${formatDuration(stats.total_parent_seconds)}`,
    `  Average       ${formatDuration(stats.avg_seconds_per_parent)} per parent`,
    "",
    "Decisions (marked items)",
    `  Duplicate    ${stats.duplicate.toLocaleString()}  (${stats.duplicate_pct_of_reviewed.toFixed(1)}%)`,
    `  Unique       ${stats.unique.toLocaleString()}  (${stats.unique_pct_of_reviewed.toFixed(1)}%)`,
    `  Discard      ${stats.discard.toLocaleString()}  (${stats.discard_pct_of_reviewed.toFixed(1)}%)`,
  );
  if (stats.skip) {
    lines.push(
      `  Skip         ${stats.skip.toLocaleString()}  (${stats.skip_pct_of_reviewed.toFixed(1)}%)`,
    );
  }
  lines.push(
    "",
    "Key rates",
    `  Duplicate rate   ${stats.duplicate_pct_of_reviewed.toFixed(1)}% of marked`,
    `  Unique rate      ${stats.unique_pct_of_reviewed.toFixed(1)}% of marked`,
    `  Duplicates found ${stats.duplicate.toLocaleString()} (${stats.duplicate_pct_of_total.toFixed(1)}% of all products)`,
    "",
    "Session",
    `  Source file  ${stats.source_file || "(none)"}`,
    `  Last saved   ${stats.updated_at || "(never)"}`,
  );
  return lines.join("\n");
}

function buildDecisionRows() {
  const byProduct = state.catalog?.by_product || {};
  const rows = [];
  for (const [pn, dec] of Object.entries(state.decisions || {})) {
    const item = byProduct[pn];
    if (!item) continue;
    const st = normalizeStatus(dec.status);
    rows.push({
      product_number: pn,
      status: st,
      status_label: statusLabel(st),
      cluster_id: item.cluster_id,
      description: item.description || "",
      linked_to_product: item.linked_to_product || "",
      score_to_parent: item.score_to_parent,
      updated_at: dec.updated_at || "",
    });
  }
  rows.sort((a, b) =>
    a.status.localeCompare(b.status) ||
    a.cluster_id - b.cluster_id ||
    a.product_number.localeCompare(b.product_number),
  );
  return rows;
}

function buildClusterReportRows() {
  const order = state.catalog?.cluster_order || [];
  const reviewSet = new Set(order);
  const clusters = state.catalog?.clusters || {};
  const decisions = state.decisions || {};
  const times = parentTimesNormalized();
  if (state.timerClusterId != null && state.timerStartedAt != null) {
    times[String(state.timerClusterId)] = liveParentSeconds(state.timerClusterId);
  }
  const allIds = [
    ...order,
    ...Object.keys(clusters)
      .map(Number)
      .filter((cid) => Number.isFinite(cid) && !reviewSet.has(cid))
      .sort((a, b) => a - b),
  ];
  return allIds.map((cid) => {
    const items = clusters[cid] || [];
    const root = clusterRoot(items);
    const cands = clusterCandidates(items);
    const counts = { duplicate: 0, unique: 0, discard: 0 };
    for (const item of cands) {
      const dec = decisions[item.product_number];
      if (!dec) continue;
      const st = normalizeStatus(dec.status);
      if (counts[st] != null) counts[st] += 1;
    }
    const marked = counts.duplicate + counts.unique + counts.discard;
    const queueSize = cands.length;
    const seconds = times[String(cid)] || 0;
    const singleton = items.length <= 1;
    return {
      cluster_id: cid,
      size: items.length,
      marked,
      remaining: Math.max(queueSize - marked, 0),
      duplicate: counts.duplicate,
      unique: counts.unique,
      discard: counts.discard,
      completed: singleton ? true : state.completed.has(cid),
      reference: root?.product_number || "",
      time_seconds: seconds,
      time_label: seconds ? formatDuration(seconds) : "—",
      unmatched: singleton,
    };
  });
}

function unmatchedProductRows() {
  return Object.values(state.catalog?.by_product || {})
    .filter((it) => (it.cluster_size || 0) <= 1)
    .sort((a, b) => String(a.product_number).localeCompare(String(b.product_number)))
    .map((it) => ({
      product_number: it.product_number,
      description: it.description || "",
      cluster_id: it.cluster_id,
    }));
}

function showReportsScreen() {
  if (!state.catalog) {
    alert("Open a job first.");
    return;
  }
  pauseParentTimer({ persist: true });
  showScreen("reports");
  renderReports();
}

function showReviewFromReports() {
  showScreen("review");
  resumeParentTimer();
  renderCluster();
}

function defaultTimesheetRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 31);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(from), to: iso(to) };
}

function showTimesheetScreen() {
  pauseParentTimer({ persist: true });
  const fromEl = $("#tsFrom");
  const toEl = $("#tsTo");
  if (fromEl && !fromEl.value) {
    const r = defaultTimesheetRange();
    fromEl.value = r.from;
    toEl.value = r.to;
  }
  showScreen("timesheet");
  loadTimesheet().catch((e) => alert(e.message || String(e)));
}

async function loadTimesheet() {
  const from = $("#tsFrom")?.value || "";
  const to = $("#tsTo")?.value || "";
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const data = await api(`/api/timesheet?${qs}`);
  const kpis = $("#timesheetKpis");
  if (kpis) {
    const t = data.totals || {};
    kpis.innerHTML = [
      `<div class="kpi"><strong>Sessions</strong><div>${(t.sessions || 0).toLocaleString()}</div><span>${t.closed || 0} closed · ${t.open || 0} open</span></div>`,
      `<div class="kpi"><strong>Total hours</strong><div>${t.total_label || "0:00"}</div><span>closed sessions only</span></div>`,
      `<div class="kpi"><strong>Days worked</strong><div>${(data.daily || []).length}</div><span>with a closed session</span></div>`,
      `<div class="kpi"><strong>Range</strong><div style="font-size:1rem">${from || "…"} → ${to || "…"}</div><span>local login dates</span></div>`,
    ].join("");
  }
  const body = $("#timesheetTable tbody");
  if (!body) return;
  const rows = data.sessions || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6">No login sessions in this range yet. Sign out at end of day to close a session.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((s) => {
      const login = String(s.login_local || "").replace("T", " ");
      const logout = s.logout_local ? String(s.logout_local).replace("T", " ") : "—";
      const tz =
        s.tz_name ||
        (s.tz_offset_min != null
          ? `UTC${s.tz_offset_min >= 0 ? "+" : ""}${Math.trunc(s.tz_offset_min / 60)}`
          : "—");
      return `<tr>
        <td>${escapeHtml(s.date || "")}</td>
        <td>${escapeHtml(login)}</td>
        <td>${escapeHtml(logout)}</td>
        <td>${escapeHtml(s.duration_label || "—")}</td>
        <td>${escapeHtml(tz)}</td>
        <td>${escapeHtml(s.status)}</td>
      </tr>`;
    })
    .join("");
}

function exportTimesheetCsv() {
  const from = $("#tsFrom")?.value || "";
  const to = $("#tsTo")?.value || "";
  const qs = new URLSearchParams({ format: "csv" });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  window.location.href = `/api/timesheet?${qs}`;
}

function renderReports() {
  const stats = computeReviewStats();
  const decisionRows = buildDecisionRows();
  const clusterRows = buildClusterReportRows();
  const kpis = $("#reportsKpis");
  if (kpis) {
    kpis.innerHTML = [
      `<div class="kpi"><strong>Catalog</strong><div>${stats.total.toLocaleString()}</div><span>${stats.reviewable.toLocaleString()} in queue · ${stats.unmatched.toLocaleString()} unmatched kept</span></div>`,
      `<div class="kpi"><strong>Queue reviewed</strong><div>${stats.reviewed_in_queue.toLocaleString()} / ${stats.reviewable.toLocaleString()}</div><span>${stats.reviewed_pct.toFixed(1)}% · ${stats.remaining.toLocaleString()} left</span></div>`,
      `<div class="kpi"><strong>Duplicates</strong><div>${stats.duplicate.toLocaleString()}</div><span>${stats.duplicate_pct_of_total.toFixed(1)}% of all</span></div>`,
      `<div class="kpi"><strong>Avg / parent</strong><div>${formatDuration(stats.avg_seconds_per_parent)}</div><span>${stats.timed_parents.toLocaleString()} timed · ${formatDuration(stats.total_parent_seconds)} total</span></div>`,
    ].join("");
  }
  const summary = $("#reportsSummary");
  if (summary) summary.textContent = formatReviewStats(stats);

  const dupBody = $("#reportsDupTable tbody");
  if (dupBody) {
    const dups = decisionRows.filter((r) => r.status === "duplicate");
    dupBody.innerHTML = dups
      .map(
        (r) => `<tr>
        <td>${escapeHtml(r.product_number)}</td>
        <td>${escapeHtml(String(r.cluster_id))}</td>
        <td>${escapeHtml(r.linked_to_product)}</td>
        <td>${escapeHtml(formatScore(r.score_to_parent))}</td>
        <td>${escapeHtml(r.updated_at)}</td>
      </tr>`,
      )
      .join("") || `<tr><td colspan="5" class="empty">No duplicates marked yet.</td></tr>`;
  }

  const clusterBody = $("#reportsClusterTable tbody");
  if (clusterBody) {
    clusterBody.innerHTML = clusterRows
      .map(
        (r) => `<tr>
        <td>${escapeHtml(String(r.cluster_id))}</td>
        <td>${escapeHtml(r.reference)}</td>
        <td>${r.size}</td>
        <td>${r.marked}</td>
        <td>${r.duplicate}</td>
        <td>${r.unique}</td>
        <td>${r.completed ? "Yes" : "No"}</td>
        <td>${escapeHtml(r.time_label)}</td>
      </tr>`,
      )
      .join("") || `<tr><td colspan="8" class="empty">No clusters.</td></tr>`;
  }
}

function exportManagementExcel() {
  if (!state.catalog || typeof XLSX === "undefined") {
    alert("Open a job first (SheetJS required for Excel export).");
    return;
  }
  pauseParentTimer({ persist: true });
  const stats = computeReviewStats();
  const decisionRows = buildDecisionRows();
  const clusterRows = buildClusterReportRows();
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    ["Metric", "Value"],
    ["Source file", stats.source_file || ""],
    ["Report generated (UTC)", new Date().toISOString()],
    ["Last progress save", stats.updated_at || ""],
    ["Products total (catalog)", stats.total],
    ["In review queue (near-duplicates)", stats.reviewable],
    ["Unmatched kept (no near-dupe)", stats.unmatched],
    ["Queue reviewed", stats.reviewed_in_queue],
    ["Queue remaining", stats.remaining],
    ["Queue reviewed %", Math.round(stats.reviewed_pct * 10) / 10],
    ["Clusters total (review)", stats.n_clusters],
    ["Clusters completed", stats.n_clusters_done],
    ["Clusters completed %", Math.round(stats.clusters_done_pct * 10) / 10],
    ["Parents with time recorded", stats.timed_parents],
    ["Total time on parents", formatDuration(stats.total_parent_seconds)],
    ["Average time per parent", formatDuration(stats.avg_seconds_per_parent)],
    ["Average time per parent (seconds)", Math.round(stats.avg_seconds_per_parent * 10) / 10],
    ["Marked duplicate", stats.duplicate],
    ["Marked unique", stats.unique],
    ["Marked discard", stats.discard],
    ["Duplicate % of marked", Math.round(stats.duplicate_pct_of_reviewed * 10) / 10],
    ["Duplicate % of all products", Math.round(stats.duplicate_pct_of_total * 10) / 10],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), "Executive Summary");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Product", "Cluster", "Description", "Linked to", "Score to parent", "Updated (UTC)"],
      ...decisionRows
        .filter((r) => r.status === "duplicate")
        .map((r) => [
          r.product_number,
          r.cluster_id,
          r.description,
          r.linked_to_product,
          r.score_to_parent,
          r.updated_at,
        ]),
    ]),
    "Duplicates",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Product", "Decision", "Cluster", "Description", "Linked to", "Score to parent", "Updated (UTC)"],
      ...decisionRows.map((r) => [
        r.product_number,
        r.status_label,
        r.cluster_id,
        r.description,
        r.linked_to_product,
        r.score_to_parent,
        r.updated_at,
      ]),
    ]),
    "All Decisions",
  );
  const unmatched = unmatchedProductRows();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Product", "Description", "Cluster", "Status"],
      ...unmatched.map((r) => [
        r.product_number,
        r.description,
        r.cluster_id,
        "Unmatched — no near-duplicate (kept in catalog)",
      ]),
    ]),
    "Unmatched",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [
        "Cluster",
        "Reference",
        "Size",
        "Marked",
        "Remaining",
        "Duplicate",
        "Unique",
        "Discard",
        "Completed",
        "Unmatched",
        "Time",
        "Time (seconds)",
      ],
      ...clusterRows.map((r) => [
        r.cluster_id,
        r.reference,
        r.size,
        r.marked,
        r.remaining,
        r.duplicate,
        r.unique,
        r.discard,
        r.completed,
        r.unmatched ? "Yes" : "No",
        r.time_label,
        Math.round(r.time_seconds * 10) / 10,
      ]),
    ]),
    "Cluster Progress",
  );
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
  XLSX.writeFile(wb, `similarity_report_${stamp}.xlsx`);
}

function clusterRoot(items) {
  if (!items?.length) return null;
  const roots = items.filter((i) => i.depth === 0);
  if (!roots.length) return items.slice().sort((a, b) => a.position_in_cluster - b.position_in_cluster)[0];
  return roots.slice().sort((a, b) => a.position_in_cluster - b.position_in_cluster)[0];
}

/** Children only — the parent/reference is never marked in the duel queue. */
function clusterCandidates(items) {
  if (!items?.length) return [];
  const root = clusterRoot(items);
  const rootPn = root?.product_number;
  return items.filter((i) => i.product_number !== rootPn);
}

function scoreVal(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

function applyMoves(catalog, moves) {
  if (!moves || !Object.keys(moves).length) return catalog;
  const clusterOrder = [...catalog.cluster_order];
  const clusters = {};
  for (const [k, v] of Object.entries(catalog.clusters)) clusters[Number(k)] = v.map((x) => ({ ...x }));
  const byProduct = { ...catalog.by_product };
  for (const pn of Object.keys(byProduct)) byProduct[pn] = { ...byProduct[pn] };

  for (const [pn, move] of Object.entries(moves)) {
    const item = byProduct[pn];
    if (!item) continue;
    const newCid = Number(move.cluster_id);
    const oldCid = item.cluster_id;
    if (oldCid === newCid) {
      if (move.linked_to_product) item.linked_to_product = move.linked_to_product;
      continue;
    }
    if (clusters[oldCid]) {
      clusters[oldCid] = clusters[oldCid].filter((i) => i.product_number !== pn);
      if (!clusters[oldCid].length) {
        delete clusters[oldCid];
        const idx = clusterOrder.indexOf(oldCid);
        if (idx >= 0) clusterOrder.splice(idx, 1);
      }
    }
    item.cluster_id = newCid;
    if (move.linked_to_product) item.linked_to_product = move.linked_to_product;
    if (item.depth === 0) item.depth = 1;
    if (move.semantic_score != null && move.semantic_score !== "") {
      item.score_to_parent = Number(move.semantic_score);
    }
    if (!clusters[newCid]) clusters[newCid] = [];
    if (!clusters[newCid].some((i) => i.product_number === pn)) clusters[newCid].push(item);
    if (!clusterOrder.includes(newCid)) clusterOrder.push(newCid);
  }

  for (const members of Object.values(clusters)) {
    const size = members.length;
    for (const it of members) {
      it.cluster_size = size;
      it.n_similar_in_cluster = Math.max(size - 1, 0);
      byProduct[it.product_number] = it;
    }
  }

  return {
    ...catalog,
    cluster_order: clusterOrder.filter((cid) => clusters[cid]?.length),
    clusters,
    by_product: byProduct,
  };
}

function sheetToObjects(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows;
}

function parseResultsWorkbook(wb) {
  const grouped = wb.Sheets["Grouped Review"];
  if (!grouped) throw new Error("No 'Grouped Review' sheet — upload similarity results or a FOExport sheet.");
  const rows = sheetToObjects(grouped);
  const clusterOrder = [];
  const clusters = {};
  const byProduct = {};
  for (const row of rows) {
    const pn = String(row.product_number ?? "").trim();
    if (!pn) continue;
    const item = {
      cluster_id: Number(row.cluster_id),
      cluster_size: Number(row.cluster_size) || 0,
      position_in_cluster: Number(row.position_in_cluster) || 0,
      depth: Number(row.depth) || 0,
      product_number: pn,
      description: String(row.description ?? ""),
      linked_to_product: String(row.linked_to_product ?? ""),
      score_to_parent: row.score_to_parent,
      n_similar_in_cluster: Number(row.n_similar_in_cluster) || 0,
      exact_dup_group: row.exact_dup_group ?? "",
    };
    if (!clusters[item.cluster_id]) {
      clusters[item.cluster_id] = [];
      clusterOrder.push(item.cluster_id);
    }
    clusters[item.cluster_id].push(item);
    byProduct[pn] = item;
  }

  // Pull unmatched / singleton products from the full Clusters sheet when present
  // so Grouped Review uploads don't drop products either.
  const clustersSheet = wb.Sheets["Clusters"];
  let unmatchedAdded = 0;
  if (clustersSheet) {
    let nextCid = Math.max(0, ...Object.keys(clusters).map(Number), 0) + 1;
    for (const row of sheetToObjects(clustersSheet)) {
      const pn = String(row.product_number ?? "").trim();
      if (!pn || byProduct[pn]) continue;
      const size = Number(row.cluster_size) || 1;
      let cid = Number(row.cluster_id);
      if (!Number.isFinite(cid) || size > 1) {
        // Only absorb true singletons / missing rows as unmatched keeps
        if (size > 1 && Number.isFinite(cid) && clusters[cid]) continue;
      }
      if (!Number.isFinite(cid) || clusters[cid]) {
        cid = nextCid++;
      }
      const item = {
        cluster_id: cid,
        cluster_size: 1,
        position_in_cluster: 0,
        depth: 0,
        product_number: pn,
        description: String(row.description ?? ""),
        linked_to_product: "",
        score_to_parent: "",
        n_similar_in_cluster: 0,
        exact_dup_group: "",
      };
      clusters[cid] = [item];
      byProduct[pn] = item;
      unmatchedAdded += 1;
    }
  }

  const semantic = {};
  const semSheet = wb.Sheets["Semantic Suggestions"];
  if (semSheet) {
    for (const row of sheetToObjects(semSheet)) {
      const pn = String(row.product_number ?? "").trim();
      const sp = String(row.suggested_product ?? "").trim();
      if (!pn || !sp) continue;
      if (!byProduct[pn] || !byProduct[sp]) continue; // only keep in-catalog suggestions
      if (!semantic[pn]) semantic[pn] = [];
      if (semantic[pn].length >= 8) continue;
      semantic[pn].push({
        suggested_product: sp,
        suggested_cluster_id: Number(row.suggested_cluster_id),
        suggested_description: String(row.suggested_description ?? "").slice(0, 120),
        semantic_score: row.semantic_score,
      });
    }
  }

  const nUnmatched = Object.values(byProduct).filter((it) => (it.cluster_size || 0) <= 1).length;
  const reviewOrder = sortClusterOrderByName(
    clusterOrder.filter((cid) => (clusters[cid]?.length || 0) > 1),
    clusters,
  );
  return {
    cluster_order: reviewOrder,
    clusters,
    by_product: byProduct,
    semantic,
    stats: {
      n_products: Object.keys(byProduct).length,
      n_clusters: reviewOrder.length,
      n_in_clusters: Object.keys(byProduct).length - nUnmatched,
      n_unmatched: nUnmatched,
      n_from_clusters_sheet: unmatchedAdded,
    },
  };
}

function pickCol(row, candidates) {
  const keys = Object.keys(row || {});
  for (const want of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase() === want.toLowerCase());
    if (hit != null && row[hit] != null && String(row[hit]).trim() !== "") {
      return String(row[hit]).trim();
    }
  }
  // fuzzy contains
  for (const want of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase().includes(want.toLowerCase()));
    if (hit != null && row[hit] != null && String(row[hit]).trim() !== "") {
      return String(row[hit]).trim();
    }
  }
  return "";
}

function parseFoExport(wb) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetToObjects(sheet);
  if (!rows.length) throw new Error("Sheet is empty.");
  const products = [];
  const pnHints = [
    "Product number", "product number", "product_number", "Product Number",
    "Item number", "Part number", "SKU", "pn",
  ];
  const nameHints = [
    "Product name", "product name", "product_name", "Product Name",
    "Description", "Search name", "Name", "Item name",
  ];
  for (const row of rows) {
    const pn = pickCol(row, pnHints);
    let name = pickCol(row, nameHints);
    if (!name) name = pickCol(row, ["Search name", "search name"]);
    if (!pn || !name) continue;
    products.push({ product_number: pn, description: name });
  }
  if (!products.length) {
    const sample = Object.keys(rows[0] || {}).slice(0, 12).join(", ");
    throw new Error(
      `No product number / name columns found. Columns seen: ${sample || "(none)"}`,
    );
  }
  return products;
}

async function gzipJson(obj) {
  const text = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Compact wire format — no duplicated cluster arrays. */
function toWireCatalog(catalog) {
  const products = {};
  for (const [pn, it] of Object.entries(catalog.by_product || {})) {
    products[pn] = {
      c: it.cluster_id,
      s: it.cluster_size,
      p: it.position_in_cluster,
      d: it.depth,
      desc: it.description || "",
      l: it.linked_to_product || "",
      sc: it.score_to_parent ?? "",
    };
  }
  const semantic = {};
  for (const [pn, arr] of Object.entries(catalog.semantic || {})) {
    semantic[pn] = (arr || []).slice(0, 8).map((s) => [
      s.suggested_product,
      s.semantic_score ?? "",
      String(s.suggested_description || "").slice(0, 120),
      s.suggested_cluster_id ?? null,
    ]);
  }
  return {
    cluster_order: catalog.cluster_order,
    products,
    semantic,
    stats: catalog.stats || {
      n_products: Object.keys(products).length,
      n_clusters: (catalog.cluster_order || []).length,
    },
  };
}

const CLIENT_CHUNK = 1 * 1024 * 1024; // match server KV chunk size

async function idbSet(jobId, catalog) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cleanup23", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("catalogs")) db.createObjectStore("catalogs");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("catalogs", "readwrite");
      tx.objectStore("catalogs").put(catalog, jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(jobId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cleanup23", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("catalogs")) db.createObjectStore("catalogs");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("catalogs", "readonly");
      const g = tx.objectStore("catalogs").get(jobId);
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => reject(g.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(jobId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cleanup23", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("catalogs")) db.createObjectStore("catalogs");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("catalogs", "readwrite");
      tx.objectStore("catalogs").delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function ensureRelatedBanner() {
  let el = $("#relatedBanner");
  if (el) return el;
  el = document.createElement("div");
  el.id = "relatedBanner";
  el.className = "related-banner";
  el.hidden = true;
  const top = $(".top");
  if (top && top.parentNode) top.parentNode.insertBefore(el, top.nextSibling);
  else document.body.prepend(el);
  return el;
}

function setRelatedBanner(text, { error = false } = {}) {
  const el = ensureRelatedBanner();
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.classList.toggle("err", error);
  el.textContent = text;
}

async function maybeStartRelated(jobId, { quiet = false } = {}) {
  let cfg;
  try {
    cfg = await api("/api/config");
  } catch {
    return;
  }
  if (!cfg.relatedBackend) {
    if (!quiet) {
      setRelatedBanner("Related unavailable (Workers AI not configured)", { error: true });
    } else {
      setRelatedBanner("");
    }
    return;
  }
  setRelatedBanner("Related matching: starting on Cloudflare…");
  try {
    await api(`/api/jobs/${jobId}/related/run`, {
      method: "POST",
      body: "{}",
    });
  } catch (e) {
    setRelatedBanner(`Related matching unavailable: ${e.message || e}`, { error: true });
    return;
  }
  pollRelatedStatus(jobId);
}

async function pollRelatedStatus(jobId) {
  let lastFingerprint = "";
  let stallCount = 0;
  let tickInFlight = false;

  const requestTick = () => {
    if (tickInFlight) return;
    tickInFlight = true;
    api(`/api/jobs/${jobId}/related/tick`, { method: "POST", body: "{}" })
      .catch((e) => console.warn("Related tick", e))
      .finally(() => {
        tickInFlight = false;
      });
  };

  const tick = async () => {
    if (state.jobId && state.jobId !== jobId) return;
    try {
      const st = await api(`/api/jobs/${jobId}/related/status`);
      if (st.status === "done") {
        setRelatedBanner(
          `Related matching done · ${(st.n_suggestions || 0).toLocaleString()} suggestions · refreshing…`,
        );
        try {
          const data = await api(`/api/jobs/${jobId}`);
          if (state.jobId === jobId && data.catalog) {
            state.catalog.semantic = data.catalog.semantic || {};
            renderRelated();
          }
        } catch (e) {
          console.warn(e);
        }
        setRelatedBanner(
          `Related ready · ${(st.n_suggestions || 0).toLocaleString()} suggestions (G to toggle panel)`,
        );
        return;
      }
      if (st.status === "failed") {
        const err = String(st.error || "");
        if (/paused|timed out|continue failed|522/i.test(err)) {
          setRelatedBanner(`Related stalled — resuming… · ${st.detail || err}`);
          try {
            await api(`/api/jobs/${jobId}/related/run`, { method: "POST", body: "{}" });
            stallCount = 0;
            lastFingerprint = "";
            setTimeout(tick, 2000);
            return;
          } catch (e) {
            setRelatedBanner(`Related failed: ${e.message || err}`, { error: true });
            return;
          }
        }
        setRelatedBanner(`Related failed: ${st.error || "unknown error"}`, { error: true });
        return;
      }
      const pct = Math.round((Number(st.progress) || 0) * 100);
      const detail = st.detail ? ` · ${st.detail}` : "";
      const label =
        st.status === "queued"
          ? "queued"
          : st.status === "running"
            ? "running"
            : st.status || "working";
      setRelatedBanner(
        `Related matching: ${label}${pct ? ` ${pct}%` : ""}${detail} (keep this tab open)`,
      );

      // Drive the next chunk from the browser (no Worker self-fetch)
      if (st.status === "running" || st.status === "queued") {
        requestTick();
      }

      const fp = `${st.status}|${st.detail}|${st.progress}|${st.updated_at || ""}`;
      if (fp === lastFingerprint) stallCount += 1;
      else {
        stallCount = 0;
        lastFingerprint = fp;
      }
      if (stallCount >= 6 && (st.status === "running" || st.status === "queued")) {
        stallCount = 0;
        try {
          await api(`/api/jobs/${jobId}/related/run`, { method: "POST", body: "{}" });
        } catch (e) {
          console.warn("Related resume nudge failed", e);
        }
      }
      setTimeout(tick, 2000);
    } catch (e) {
      console.warn(e);
      setTimeout(tick, 8000);
    }
  };
  setTimeout(tick, 1000);
}

async function deleteJob(id, name = "") {
  const label = name || id;
  if (!confirm(`Delete job “${label}”?\n\nThis removes the catalog, decisions, Related pulls, and timing. Cannot be undone.`)) {
    return;
  }
  setProgress(true, "Deleting job…", 40);
  try {
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    try {
      await idbDelete(id);
    } catch (e) {
      console.warn("Local cache delete skipped", e);
    }
    if (state.jobId === id) {
      pauseParentTimer({ persist: false });
      state.jobId = null;
      state.jobName = "";
      state.catalog = null;
      state.decisions = {};
      state.moves = {};
      state.completed = new Set();
      state.parentTimes = {};
      state.clusterIndex = 0;
      state.selected = "";
      showScreen("upload");
      updateTop();
    }
    await refreshJobs();
    if (state.pass === 2) await refreshPass1Sources().catch(() => {});
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
  } finally {
    setProgress(false);
  }
}

async function uploadCatalogToD1(jobId, catalog) {
  const products = Object.values(catalog.by_product || {});
  const batchSize = 200;
  for (let i = 0; i < products.length; i += batchSize) {
    const slice = products.slice(i, i + batchSize);
    setProgress(
      true,
      `Saving products ${Math.min(i + batchSize, products.length).toLocaleString()}/${products.length.toLocaleString()}…`,
      85 + (i / Math.max(products.length, 1)) * 10,
    );
    await api(`/api/jobs/${jobId}/products`, {
      method: "POST",
      body: JSON.stringify({ products: slice }),
    });
  }

  // Flatten semantic suggestions
  const semItems = [];
  for (const [pn, arr] of Object.entries(catalog.semantic || {})) {
    for (const s of (arr || []).slice(0, 8)) {
      semItems.push({
        product_number: pn,
        suggested_product: s.suggested_product,
        suggested_cluster_id: s.suggested_cluster_id ?? null,
        suggested_description: String(s.suggested_description || "").slice(0, 200),
        semantic_score: s.semantic_score ?? null,
      });
    }
  }
  for (let i = 0; i < semItems.length; i += batchSize) {
    const slice = semItems.slice(i, i + batchSize);
    setProgress(
      true,
      `Saving related ${Math.min(i + batchSize, semItems.length)}/${semItems.length}…`,
      95,
    );
    await api(`/api/jobs/${jobId}/semantic`, {
      method: "POST",
      body: JSON.stringify({ items: slice }),
    });
  }

  await api(`/api/jobs/${jobId}/finalize`, {
    method: "POST",
    body: JSON.stringify({
      cluster_order: catalog.cluster_order,
      n_products: products.length,
      n_clusters: catalog.cluster_order.length,
    }),
  });
}

async function handleFile(file) {
  let step = "start";
  try {
    step = "read";
    setProgress(true, "Reading workbook…", 5);
    if (typeof XLSX === "undefined") {
      throw new Error("Spreadsheet library failed to load. Hard-refresh and try again.");
    }
    const buf = await file.arrayBuffer();
    step = "parse";
    setProgress(true, "Parsing workbook…", 12);
    const wb = XLSX.read(buf, { type: "array" });
    let catalog;
    let kind;

    if (wb.Sheets["Grouped Review"]) {
      kind = "results";
      step = "grouped";
      setProgress(true, "Parsing Grouped Review…", 30);
      catalog = parseResultsWorkbook(wb);
    } else {
      kind = "foexport";
      step = "foexport";
      setProgress(true, "Parsing product sheet…", 15);
      const products = parseFoExport(wb);
      step = "cluster";
      setProgress(true, `Clustering ${products.length.toLocaleString()} products…`, 25);
      catalog = await clusterProducts(products, (msg, pct) => {
        setProgress(true, msg, 25 + pct * 0.55);
      });
      catalog.semantic = {};
    }

    if (!Object.keys(catalog.by_product || {}).length) {
      throw new Error("No products found in the workbook.");
    }
    if (!catalog.cluster_order?.length) {
      // Catalog may be all unmatched singletons — still a valid job (nothing to duel).
      console.warn("No near-duplicate clusters; catalog kept for unmatched products.");
    }

    step = "create-job";
    setProgress(true, "Creating job…", 82);
    const nProducts = Object.keys(catalog.by_product).length;
    const nUnmatched = Object.values(catalog.by_product).filter(
      (it) => (it.cluster_size || 0) <= 1,
    ).length;
    const created = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        source_kind: kind,
        pass_number: 1,
        n_products: nProducts,
        n_clusters: catalog.cluster_order.length,
      }),
    });
    if (nUnmatched) {
      console.info(
        `Catalog: ${nProducts.toLocaleString()} products · ${catalog.cluster_order.length.toLocaleString()} review clusters · ${nUnmatched.toLocaleString()} unmatched kept`,
      );
    }

    step = "local-cache";
    setProgress(true, "Saving local cache…", 84);
    try {
      await idbSet(created.id, catalog);
    } catch (e) {
      console.warn("IndexedDB cache skipped", e);
    }

    step = "cloud-save";
    try {
      await uploadCatalogToD1(created.id, catalog);
    } catch (err) {
      console.warn("Cloud product sync failed; using local cache", err);
      alert(
        `Cloud sync had a problem (${err.message}).\n\nReview will continue on this browser; decisions still save.`,
      );
    }

    step = "open";
    setProgress(true, "Opening review…", 98);
    await openJob(created.id, catalog);
    if (kind === "foexport") {
      maybeStartRelated(created.id, { quiet: true }).catch((e) =>
        console.warn("Related start", e),
      );
    }
  } catch (err) {
    console.error(`Failed at step=${step}`, err);
    throw new Error(`${err.message || err} (step: ${step})`);
  } finally {
    setProgress(false);
  }
}

async function refreshJobs() {
  const pass = state.pass === 2 ? 2 : 1;
  const { jobs } = await api(`/api/jobs?pass=${pass}`);
  const host = pass === 2 ? $("#pass2JobList") : $("#jobList");
  if (!host) return;
  if (!jobs.length) {
    host.innerHTML =
      pass === 2
        ? `<h2>Pass 2 jobs</h2><p class="hint">None yet — build one from a Pass 1 job above.</p>`
        : "";
    return;
  }
  host.innerHTML = `<h2>${pass === 2 ? "Pass 2 jobs" : "Saved jobs"}</h2>${jobs
    .map(
      (j) => `<div class="job-row">
      <div><strong>${escapeHtml(j.name)}</strong><br/><span class="job-meta">${j.n_clusters} review clusters · ${Number(j.n_products).toLocaleString()} products${j.source_job_id ? ` · from ${escapeHtml(String(j.source_job_id).slice(0, 8))}…` : ""}</span></div>
      <div class="job-actions">
        <button type="button" class="btn primary" data-open-job="${j.id}">Open</button>
        <button type="button" class="btn danger" data-delete-job="${j.id}" data-delete-name="${escapeHtml(j.name)}">Delete</button>
      </div>
    </div>`,
    )
    .join("")}`;
  host.querySelectorAll("[data-open-job]").forEach((btn) => {
    btn.addEventListener("click", () => openJob(btn.getAttribute("data-open-job")));
  });
  host.querySelectorAll("[data-delete-job]").forEach((btn) => {
    btn.addEventListener("click", () => {
      deleteJob(btn.getAttribute("data-delete-job"), btn.getAttribute("data-delete-name") || "");
    });
  });
}

async function refreshPass1Sources() {
  const host = $("#pass1SourceList");
  if (!host) return;
  const { jobs } = await api("/api/jobs?pass=1");
  if (!jobs.length) {
    host.innerHTML = `<h2>Pass 1 sources</h2><p class="hint">No Pass 1 jobs yet — finish Pass 1 first.</p>`;
    return;
  }
  host.innerHTML = `<h2>Build from Pass 1</h2>${jobs
    .map(
      (j) => `<div class="job-row">
      <div><strong>${escapeHtml(j.name)}</strong><br/><span class="job-meta">${j.n_clusters} clusters · ${Number(j.n_products).toLocaleString()} products</span></div>
      <div class="job-actions">
        <button type="button" class="btn primary" data-build-pass2="${j.id}" data-build-name="${escapeHtml(j.name)}">Start Pass 2</button>
      </div>
    </div>`,
    )
    .join("")}`;
  host.querySelectorAll("[data-build-pass2]").forEach((btn) => {
    btn.addEventListener("click", () => {
      startPass2FromJob(
        btn.getAttribute("data-build-pass2"),
        btn.getAttribute("data-build-name") || "",
      ).catch((e) => {
        setProgress(false);
        alert(e.message || String(e));
      });
    });
  });
}

async function startPass2FromJob(sourceJobId, sourceName = "") {
  setProgress(true, "Loading Pass 1 job…", 8);
  const data = await api(`/api/jobs/${sourceJobId}`);
  let catalog = data.catalog;
  if (!catalog?.by_product || !Object.keys(catalog.by_product).length) {
    const cached = await idbGet(sourceJobId);
    if (cached) catalog = applyMoves(cached, data.moves || {});
  } else {
    catalog = applyMoves(catalog, data.moves || {});
  }
  if (!catalog?.by_product || !Object.keys(catalog.by_product).length) {
    throw new Error("Pass 1 catalog missing — reopen the Pass 1 job once, then try again.");
  }
  const decisions = data.decisions || {};

  setProgress(true, "Building Pass 2 clusters…", 20);
  const { catalog: pass2Catalog, autoDecisions } = await buildPass2Catalog(
    catalog,
    decisions,
    (msg, pct) => setProgress(true, msg, 20 + pct * 0.55),
  );

  const nClusters = pass2Catalog.cluster_order.length;
  if (!nClusters) {
    throw new Error("No Pass 2 matches found (no child had a near-duplicate in the catalog).");
  }

  setProgress(true, "Creating Pass 2 job…", 80);
  const created = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      name: `Pass2 ← ${sourceName || sourceJobId}`,
      source_kind: "pass2",
      pass_number: 2,
      source_job_id: sourceJobId,
      n_products: Object.keys(pass2Catalog.by_product).length,
      n_clusters: nClusters,
    }),
  });

  try {
    await idbSet(created.id, pass2Catalog);
  } catch (e) {
    console.warn("IndexedDB cache skipped", e);
  }

  setProgress(true, "Saving Pass 2 catalog…", 86);
  try {
    await uploadCatalogToD1(created.id, pass2Catalog);
  } catch (err) {
    console.warn("Cloud product sync failed; using local cache", err);
    alert(
      `Cloud sync had a problem (${err.message}).\n\nReview will continue on this browser; decisions still save.`,
    );
  }

  const autoItems = Object.entries(autoDecisions).map(([pn, d]) => ({
    product_number: pn,
    status: d.status,
    cluster_id: d.cluster_id,
    note: d.note || "from_pass1",
  }));
  if (autoItems.length) {
    setProgress(true, `Pre-marking ${autoItems.length.toLocaleString()} Pass 1 duplicates…`, 92);
    for (let i = 0; i < autoItems.length; i += 400) {
      await api(`/api/jobs/${created.id}/decisions/batch`, {
        method: "POST",
        body: JSON.stringify({ items: autoItems.slice(i, i + 400) }),
      });
    }
  }

  // Mark fully auto-completed clusters as done
  const completed = [];
  for (const cid of pass2Catalog.cluster_order) {
    const members = pass2Catalog.clusters[cid] || [];
    const root = clusterRoot(members);
    const cands = members.filter((m) => m.product_number !== root?.product_number);
    if (cands.length && cands.every((m) => autoDecisions[m.product_number])) {
      completed.push(cid);
    }
  }
  if (completed.length) {
    await api(`/api/jobs/${created.id}/progress`, {
      method: "PUT",
      body: JSON.stringify({
        cluster_index: 0,
        clusters_completed: completed,
        parent_times: {},
      }),
    });
  }

  state.pass = 2;
  syncPassTabUi();
  setProgress(true, "Opening Pass 2…", 98);
  await openJob(created.id, pass2Catalog);
  await refreshJobs();
  setRelatedBanner(
    `Pass 2 ready · ${nClusters.toLocaleString()} parents · ${autoItems.length.toLocaleString()} duplicates carried from Pass 1`,
  );
}

function syncPassTabUi() {
  document.querySelectorAll("[data-pass-tab]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.getAttribute("data-pass-tab")) === state.pass);
  });
  const p1 = $("#pass1Upload");
  const p2 = $("#pass2Upload");
  if (p1) p1.classList.toggle("hidden", state.pass !== 1);
  if (p2) p2.classList.toggle("hidden", state.pass !== 2);
}

function setPass(pass) {
  state.pass = pass === 2 ? 2 : 1;
  syncPassTabUi();
  pauseParentTimer({ persist: true });
  showScreen("upload");
  updateTop();
  if (state.pass === 1) {
    refreshJobs().catch((e) => console.warn(e));
  } else {
    Promise.all([refreshPass1Sources(), refreshJobs()]).catch((e) => console.warn(e));
  }
}

async function openJob(id, localCatalog = null) {
  setProgress(true, "Loading job…", 20);
  try {
    let data;
    try {
      data = await api(`/api/jobs/${id}`);
    } catch (err) {
      // Fall back to IndexedDB if cloud catalog missing
      const cached = localCatalog || (await idbGet(id));
      if (!cached) throw err;
      console.warn("Using local catalog cache", err);
      data = {
        job: {
          id,
          name: state.jobName || id,
          cluster_index: 0,
        },
        catalog: cached,
        decisions: {},
        moves: {},
        clusters_completed: [],
      };
      // Still try to load decisions/progress alone if job exists
      try {
        const partial = await api(`/api/jobs/${id}`);
        data.job = partial.job;
        data.decisions = partial.decisions || {};
        data.moves = partial.moves || {};
        data.clusters_completed = partial.clusters_completed || [];
        data.parent_times = partial.parent_times || {};
        data.progress_updated_at = partial.progress_updated_at || "";
        data.related_dumps = partial.related_dumps || [];
        if (partial.catalog?.cluster_order?.length) data.catalog = partial.catalog;
      } catch {
        /* keep local */
      }
    }

    setProgress(true, "Preparing review…", 70);
    state.jobId = id;
    state.jobName = data.job.name;
    const jobPass = Number(data.job.pass_number) === 2 ? 2 : 1;
    state.pass = jobPass;
    syncPassTabUi();
    state.catalog = applyMoves(data.catalog, data.moves || {});
    state.decisions = data.decisions || {};
    state.moves = data.moves || {};
    loadRelatedDumps(data.related_dumps);
    state.completed = new Set(
      (data.clusters_completed || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
    );
    state.parentTimes = { ...(data.parent_times || {}) };
    state.progressUpdatedAt = data.progress_updated_at || "";
    state.clusterIndex = Number(data.job.cluster_index) || 0;
    state.timerClusterId = null;
    state.timerStartedAt = null;

    if (
      (!state.catalog.cluster_order || !state.catalog.cluster_order.length) &&
      state.catalog.by_product
    ) {
      const seen = [];
      const clusters = {};
      for (const it of Object.values(state.catalog.by_product)) {
        if (!clusters[it.cluster_id]) clusters[it.cluster_id] = [];
        clusters[it.cluster_id].push(it);
      }
      // Review queue = near-duplicate clusters only (size ≥ 2)
      for (const [cid, members] of Object.entries(clusters)) {
        if (members.length > 1) seen.push(Number(cid));
      }
      state.catalog.cluster_order = sortClusterOrderByName(seen, clusters);
      state.catalog.clusters = clusters;
    } else if (state.catalog.by_product && !state.catalog.clusters) {
      const clusters = {};
      for (const it of Object.values(state.catalog.by_product)) {
        if (!clusters[it.cluster_id]) clusters[it.cluster_id] = [];
        clusters[it.cluster_id].push(it);
      }
      state.catalog.clusters = clusters;
    }

    if (!state.catalog.cluster_order?.length) {
      // last chance: local cache
      const cached = localCatalog || (await idbGet(id));
      if (cached?.cluster_order?.length || Object.keys(cached?.by_product || {}).length) {
        state.catalog = applyMoves(cached, state.moves);
      }
    }

    if (!Object.keys(state.catalog?.by_product || {}).length) {
      throw new Error(
        "This job has no products. Re-upload the sheet.",
      );
    }
    if (!state.catalog.cluster_order) state.catalog.cluster_order = [];
    // Always present review queue A→Z by parent item name
    const previousCid =
      state.catalog.cluster_order[state.clusterIndex] ??
      null;
    if (state.catalog.clusters) {
      state.catalog.cluster_order = sortClusterOrderByName(
        state.catalog.cluster_order.filter(
          (cid) => (state.catalog.clusters[cid]?.length || 0) > 1,
        ),
        state.catalog.clusters,
      );
    }
    if (previousCid != null) {
      const remapped = state.catalog.cluster_order.indexOf(previousCid);
      state.clusterIndex = remapped >= 0 ? remapped : 0;
    }
    if (state.clusterIndex >= state.catalog.cluster_order.length) state.clusterIndex = 0;
    showScreen(state.catalog.cluster_order.length ? "review" : "reports");
    ensureClock();
    if (state.catalog.cluster_order.length) {
      resumeParentTimer();
      renderCluster();
    } else {
      renderReports();
    }
    updateTop();
    const rel = data.related;
    if (rel && (rel.status === "queued" || rel.status === "running")) {
      const pct = Math.round((Number(rel.progress) || 0) * 100);
      const detail = rel.detail ? ` · ${rel.detail}` : "";
      setRelatedBanner(`Related matching: ${rel.status}${pct ? ` ${pct}%` : ""}${detail}`);
      pollRelatedStatus(id);
    } else if (rel?.status === "done" && rel.n_suggestions) {
      setRelatedBanner(
        `Related ready · ${Number(rel.n_suggestions).toLocaleString()} suggestions (G to toggle panel)`,
      );
    } else if (rel?.status === "failed") {
      setRelatedBanner(`Related failed: ${rel.error || "error"}`, { error: true });
    } else {
      setRelatedBanner("");
    }
  } finally {
    setProgress(false);
  }
}

async function persistDecision(pn, status, extra = {}) {
  state.decisions[pn] = {
    status,
    cluster_id: state.catalog.by_product[pn]?.cluster_id,
    note: extra.note || "",
    updated_at: new Date().toISOString(),
  };
  await api(`/api/jobs/${state.jobId}/decisions`, {
    method: "PUT",
    body: JSON.stringify({ product_number: pn, status, ...extra }),
  });
}

async function persistProgress() {
  state.progressUpdatedAt = new Date().toISOString();
  await api(`/api/jobs/${state.jobId}/progress`, {
    method: "PUT",
    body: JSON.stringify({
      cluster_index: state.clusterIndex,
      clusters_completed: [...state.completed],
      parent_times: state.parentTimes,
    }),
  });
}

function updateTop() {
  const order = state.catalog?.cluster_order || [];
  if (!state.jobId || !order.length) {
    $("#topMeta").textContent = state.jobId
      ? `${state.jobName} · no clusters`
      : "Upload a sheet to begin";
    return;
  }
  const cid = order[state.clusterIndex];
  const items = cid == null ? [] : state.catalog.clusters[cid] || [];
  const cands = clusterCandidates(items);
  const marked = cands.filter((i) => state.decisions[i.product_number]).length;
  const parentTime = formatDuration(liveParentSeconds(cid));
  const done = state.completed.has(cid) ? "DONE" : "in progress";
  $("#topMeta").textContent =
    `${state.jobName} · Cluster ${state.clusterIndex + 1}/${order.length} · id ${cid} · ${marked}/${cands.length} marked · ${done} · time ${parentTime} · ${Object.keys(state.decisions).length} decisions`;
}

function renderCluster() {
  const cid = state.catalog.cluster_order[state.clusterIndex];
  if (state.timerClusterId !== cid) resumeParentTimer(cid);
  const items = state.catalog.clusters[cid] || [];
  const root = clusterRoot(items);
  state.reference = root?.product_number || "";
  const cands = items
    .filter((i) => i.product_number !== state.reference)
    .sort((a, b) => scoreVal(b.score_to_parent) - scoreVal(a.score_to_parent));
  state.candidates = cands.map((c) => c.product_number);
  if (!state.selected || !state.candidates.includes(state.selected)) {
    state.selected =
      state.candidates.find((pn) => !state.decisions[pn]) || state.candidates[0] || "";
  }

  const rail = $("#queueRail");
  rail.innerHTML = `<h3>Queue</h3>${state.candidates
    .map((pn) => {
      const st = normalizeStatus(state.decisions[pn]?.status);
      const sel = pn === state.selected ? "sel" : "";
      return `<button type="button" class="q-item ${sel} ${st}" data-pn="${escapeHtml(pn)}"><span class="q-dot" aria-hidden="true"></span><span>${escapeHtml(pn)}</span></button>`;
    })
    .join("") || "<div class='hint'>No candidates — parent only.</div>"}`;
  rail.querySelectorAll("[data-pn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selected = btn.getAttribute("data-pn");
      renderCluster();
    });
  });

  renderHero();
  renderRelated();
  updateTop();
  persistProgress().catch(() => {});
}

function renderHero() {
  const ref = state.catalog.by_product[state.reference];
  const cand = state.catalog.by_product[state.selected];
  const host = $("#hero");
  if (!ref) {
    host.innerHTML = `<div class="hero-diff"><div class="hero-caption">Reference</div><div class="hero-pn">—</div><div class="hero-desc">No cluster loaded.</div></div>`;
    return;
  }
  if (!cand) {
    host.innerHTML = `<div class="hero-diff">
      <div class="hero-caption">Reference</div>
      <div class="hero-pn">${escapeHtml(ref.product_number)}</div>
      <div class="hero-desc">${escapeHtml(ref.description || "(empty)")}</div>
      <div class="hero-rule"></div>
      <div class="hero-caption">Candidate</div>
      <div class="hero-pn cand">—</div>
      <div class="hint">No candidates in this cluster.</div>
    </div>`;
    return;
  }

  const { shared, onlyRef, onlyCand } = tokenDiff(ref.description, cand.description);
  const sharedSet = new Set(shared);
  const onlyCandSet = new Set(onlyCand);
  const onlyRefSet = new Set(onlyRef);
  const chip = (t, cls) => `<span class="chip ${cls || "shared"}">${escapeHtml(t)}</span>`;

  const candChips = [];
  for (const raw of String(cand.description || "").split(/\s+/).filter(Boolean)) {
    const upper = raw.toUpperCase();
    const isDraw = isDrawingNumber(raw) || isDrawingNumber(upper);
    if (isDraw && drawingPartsShared(raw, sharedSet)) {
      candChips.push(chip(raw, "drawing"));
    } else if (sharedSet.has(upper)) {
      candChips.push(chip(raw, isDraw ? "drawing" : "shared"));
    } else if (onlyCandSet.has(upper)) {
      candChips.push(chip(raw, "add"));
    } else {
      candChips.push(chip(raw, "shared"));
    }
  }

  const missChips = [];
  const seenMiss = new Set();
  for (const raw of String(ref.description || "").split(/\s+/).filter(Boolean)) {
    const upper = raw.toUpperCase();
    if (onlyRefSet.has(upper) && !seenMiss.has(upper)) {
      missChips.push(chip(raw, "miss"));
      seenMiss.add(upper);
    }
  }

  const st = normalizeStatus(state.decisions[cand.product_number]?.status);
  const score = Math.max(0, Math.min(1, scoreVal(cand.score_to_parent) < 0 ? 0 : scoreVal(cand.score_to_parent)));
  const pct = Math.round(score * 1000) / 10;

  host.innerHTML = `<div class="hero-diff">
    <div class="hero-caption">Reference</div>
    <div class="hero-pn">${escapeHtml(ref.product_number)}</div>
    <div class="hero-desc">${escapeHtml(ref.description || "(empty)")}</div>
    <div class="hero-legend">shared · drawing match xx-xx-xx (yellow) · added (teal) · missing (red)</div>
    <div class="hero-stream-label">Candidate tokens</div>
    <div class="chips">${candChips.join("") || '<span class="hint">No tokens</span>'}</div>
    <div class="hero-stream-label miss">Only in reference</div>
    <div class="chips">${missChips.join("") || '<span class="hint">—</span>'}</div>
    <div class="hero-rule"></div>
    <div class="hero-caption">Candidate</div>
    <div class="hero-cand-head">
      <div class="hero-pn cand">${escapeHtml(cand.product_number)}</div>
      <div class="status-chip ${st}">${escapeHtml(statusLabel(st))}</div>
    </div>
    <div class="score-row">
      <div class="score-label">Score ${escapeHtml(formatScore(cand.score_to_parent))}</div>
      <div class="score-meter" title="${pct}%"><span style="width:${pct}%"></span></div>
    </div>
  </div>`;
}

function renderRelated() {
  const cid = state.catalog.cluster_order[state.clusterIndex];
  const panel = $("#relatedPanel");
  const semantic = state.catalog.semantic || {};
  const members = state.catalog.clusters[cid] || [];
  const memberPns = new Set(members.map((m) => m.product_number));
  if (state.reference) memberPns.add(state.reference);

  const best = {};
  for (const member of members) {
    for (const sug of semantic[member.product_number] || []) {
      const sp = sug.suggested_product;
      if (!sp) continue;
      // Never suggest something already in this cluster (parent or any child).
      if (memberPns.has(sp)) continue;
      if (state.relatedDumps.has(dumpKey(cid, sp))) continue;
      const other = state.catalog.by_product[sp];
      if (other && other.cluster_id === cid) continue;
      if (Number(sug.suggested_cluster_id) === Number(cid)) continue;
      const cur = best[sp];
      if (!cur || scoreVal(sug.semantic_score) > scoreVal(cur.semantic_score)) best[sp] = sug;
    }
  }
  const items = Object.values(best)
    .sort((a, b) => scoreVal(b.semantic_score) - scoreVal(a.semantic_score))
    .slice(0, 20);

  panel.innerHTML = `<h3>Related</h3><div class="hint">${items.length ? `${items.length} from other clusters` : "No related suggestions for this cluster."}</div>${items
    .map((it) => {
      const desc = String(it.suggested_description || "");
      const short = desc.length > 70 ? `${desc.slice(0, 69)}…` : desc;
      return `<div class="rel-card">
        <div class="pn">${escapeHtml(it.suggested_product)} <span class="score">· ${escapeHtml(formatScore(it.semantic_score))}</span></div>
        <div class="d">${escapeHtml(short || "(no description)")}</div>
        <div class="row">
          <button type="button" class="btn" data-jump="${escapeHtml(it.suggested_product)}" title="Open this product’s current cluster">View cluster</button>
          <button type="button" class="btn primary" data-pull='${escapeHtml(JSON.stringify(it))}' title="Move this product into the cluster you’re reviewing">Move here</button>
          <button type="button" class="btn danger" data-dump="${escapeHtml(it.suggested_product)}" title="Not related — hide this suggestion for this cluster">Dump</button>
        </div>
      </div>`;
    })
    .join("")}`;

  panel.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => jumpToProduct(btn.getAttribute("data-jump")));
  });
  panel.querySelectorAll("[data-pull]").forEach((btn) => {
    btn.addEventListener("click", () => {
      try {
        pullIn(JSON.parse(btn.getAttribute("data-pull")));
      } catch {
        /* ignore */
      }
    });
  });
  panel.querySelectorAll("[data-dump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      dumpRelated(btn.getAttribute("data-dump")).catch((e) => alert(e.message || String(e)));
    });
  });
}

function jumpToProduct(pn) {
  const item = state.catalog.by_product[pn];
  if (!item) return;
  const idx = state.catalog.cluster_order.indexOf(item.cluster_id);
  if (idx < 0) return;
  state.clusterIndex = idx;
  state.selected = pn;
  renderCluster();
}

async function dumpRelated(suggestedProduct) {
  const cid = state.catalog.cluster_order[state.clusterIndex];
  const sp = String(suggestedProduct || "").trim();
  if (!state.jobId || cid == null || !sp) return;
  await api(`/api/jobs/${state.jobId}/related/dump`, {
    method: "POST",
    body: JSON.stringify({ cluster_id: cid, suggested_product: sp }),
  });
  state.relatedDumps.add(dumpKey(cid, sp));
  renderRelated();
}

async function pullIn(sug) {
  const pn = sug.suggested_product;
  const cid = state.catalog.cluster_order[state.clusterIndex];
  const item = state.catalog.by_product[pn];
  if (!item || item.cluster_id === cid) return;
  const move = {
    cluster_id: cid,
    from_cluster_id: item.cluster_id,
    linked_to_product: state.reference,
    semantic_score: sug.semantic_score,
  };
  await api(`/api/jobs/${state.jobId}/pull`, {
    method: "POST",
    body: JSON.stringify({ product_number: pn, ...move }),
  });
  const data = await api(`/api/jobs/${state.jobId}`);
  state.catalog = applyMoves(data.catalog, data.moves || {});
  if (state.catalog?.clusters) {
    state.catalog.cluster_order = sortClusterOrderByName(
      (state.catalog.cluster_order || []).filter(
        (id) => (state.catalog.clusters[id]?.length || 0) > 1,
      ),
      state.catalog.clusters,
    );
  }
  state.decisions = data.decisions || {};
  state.moves = data.moves || {};
  loadRelatedDumps(data.related_dumps);
  state.selected = pn;
  const idx = state.catalog.cluster_order.indexOf(cid);
  if (idx >= 0) state.clusterIndex = idx;
  renderCluster();
}

async function mark(status) {
  if (!state.selected) return;
  await persistDecision(state.selected, status);
  const next =
    state.candidates.find(
      (pn) => pn !== state.selected && !state.decisions[pn],
    ) || state.selected;
  state.selected = next;
  renderCluster();
}

async function clearMark() {
  if (!state.selected) return;
  delete state.decisions[state.selected];
  await api(`/api/jobs/${state.jobId}/decisions`, {
    method: "DELETE",
    body: JSON.stringify({ product_number: state.selected }),
  });
  renderCluster();
}

function moveFocus(delta) {
  if (!state.candidates.length) return;
  let idx = state.candidates.indexOf(state.selected);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(state.candidates.length - 1, idx + delta));
  state.selected = state.candidates[idx];
  renderCluster();
}

async function nextCluster() {
  pauseParentTimer({ persist: false });
  const cid = state.catalog.cluster_order[state.clusterIndex];
  state.completed.add(cid);
  if (state.clusterIndex < state.catalog.cluster_order.length - 1) {
    state.clusterIndex += 1;
    state.selected = "";
  }
  await persistProgress();
  resumeParentTimer();
  renderCluster();
}

async function prevCluster() {
  if (state.clusterIndex <= 0) return;
  pauseParentTimer({ persist: false });
  state.clusterIndex -= 1;
  state.selected = "";
  await persistProgress();
  resumeParentTimer();
  renderCluster();
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isReviewScreen() {
  return !!document.querySelector('[data-screen="review"].active');
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

function isAppFullscreen() {
  return !!document.fullscreenElement;
}

async function lockKeyboard() {
  try {
    if (navigator.keyboard?.lock) {
      // Empty list = lock all keys (Chromium). Lets Ctrl+Tab stay in-app.
      await navigator.keyboard.lock();
    }
  } catch (err) {
    console.warn("Keyboard lock unavailable", err);
  }
}

function unlockKeyboard() {
  try {
    navigator.keyboard?.unlock?.();
  } catch {
    /* ignore */
  }
}

async function enterFocusMode() {
  const root = document.querySelector(".app") || document.documentElement;
  try {
    if (!document.fullscreenElement) {
      await root.requestFullscreen?.({ navigationUI: "hide" });
    }
    await lockKeyboard();
    // Keep focus inside the app so keys hit our handler
    root.setAttribute("tabindex", "-1");
    root.focus({ preventScroll: true });
    const btn = $("#btnFocus");
    if (btn) btn.textContent = "Exit focus";
  } catch (err) {
    alert(
      "Could not enter focus mode. Click the page once, then try again.\n\n" +
        (err?.message || err),
    );
  }
}

async function exitFocusMode() {
  unlockKeyboard();
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch {
      /* ignore */
    }
  }
  const btn = $("#btnFocus");
  if (btn) btn.textContent = "Focus mode";
}

async function toggleFocusMode() {
  if (isAppFullscreen()) await exitFocusMode();
  else await enterFocusMode();
}

/** True if this key combo should be owned by the reviewer (not the browser). */
function isReviewShortcut(e) {
  const key = e.key;
  const code = e.code;

  // Child nav: Alt+↓ / Ctrl+Alt+↓ (no Tab — leaves browser Ctrl+Tab alone)
  if (
    (e.altKey && !e.metaKey) &&
    (key === "ArrowDown" || key === "ArrowUp" || code === "ArrowDown" || code === "ArrowUp")
  ) {
    return true;
  }

  if (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === " " ||
    code === "Space" ||
    key === "PageUp" ||
    key === "PageDown" ||
    key === "Enter"
  ) {
    // Plain arrows / space — but not when Alt is held (handled above as child nav)
    if (e.altKey && (key === "ArrowDown" || key === "ArrowUp")) return true;
    if (!e.altKey) return true;
  }
  if ((key === "g" || key === "G") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    return true;
  }
  if ((key === "t" || key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    return true;
  }
  if (
    (key === "r" || key === "R" || key === "s" || key === "S") &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && (key === "PageUp" || key === "PageDown")) {
    return true;
  }
  return false;
}

function onKey(e) {
  if (!isReviewScreen()) return;
  if (isTypingTarget(e.target)) return;
  if (!isReviewShortcut(e)) return;

  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

  // Alt+↓ = next child · Ctrl+Alt+↓ = previous child
  // Alt+↑ = previous child (extra convenience)
  if (e.altKey && !e.metaKey && (e.key === "ArrowDown" || e.code === "ArrowDown")) {
    moveFocus(e.ctrlKey ? -1 : 1);
    return;
  }
  if (e.altKey && !e.metaKey && (e.key === "ArrowUp" || e.code === "ArrowUp")) {
    moveFocus(-1);
    return;
  }

  if (e.key === "ArrowLeft") {
    mark("duplicate");
  } else if (e.key === "ArrowRight") {
    mark("unique");
  } else if (e.key === "ArrowUp") {
    mark("discard");
  } else if (e.key === "ArrowDown") {
    clearMark();
  } else if (e.key === "PageDown" && (e.ctrlKey || e.metaKey)) {
    nextCluster();
  } else if (e.key === "PageUp" && (e.ctrlKey || e.metaKey)) {
    prevCluster();
  } else if (e.key === " " || e.code === "Space") {
    if (e.ctrlKey || e.metaKey) prevCluster();
    else nextCluster();
  } else if (e.key === "g" || e.key === "G") {
    $("#relatedPanel").classList.toggle("hidden");
  } else if (e.key === "t" || e.key === "T") {
    toggleTheme();
  } else if (e.key === "r" || e.key === "R" || e.key === "s" || e.key === "S") {
    showReportsScreen();
  } else if (e.key === "Enter") {
    // swallow so Enter doesn't click random focused buttons
  }
}

function onKeyUp(e) {
  if (!isReviewScreen()) return;
  if (isTypingTarget(e.target)) return;
  if (!isReviewShortcut(e)) return;
  e.preventDefault();
  e.stopPropagation();
}

function wireUpload() {
  const input = $("#fileInput");
  const drop = $("#dropZone");
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) {
      handleFile(f).catch((err) => {
        setProgress(false);
        console.error(err);
        alert(err.message || String(err));
      });
    }
  });
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
  }
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      handleFile(f).catch((err) => {
        setProgress(false);
        console.error(err);
        alert(err.message || String(err));
      });
    }
  });
}

function wireReview() {
  $("#btnDup").addEventListener("click", () => mark("duplicate"));
  $("#btnUnique").addEventListener("click", () => mark("unique"));
  $("#btnDiscard").addEventListener("click", () => mark("discard"));
  $("#btnClear").addEventListener("click", () => clearMark());
  $("#btnNext").addEventListener("click", () => nextCluster());
  $("#btnPrev").addEventListener("click", () => prevCluster());
  document.querySelectorAll("[data-pass-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setPass(Number(btn.getAttribute("data-pass-tab"))));
  });
  $(".brand")?.addEventListener("click", () => setPass(state.pass));
  $("#btnReports")?.addEventListener("click", () => showReportsScreen());
  $("#btnTimesheet")?.addEventListener("click", () => showTimesheetScreen());
  $("#btnRelatedRun")?.addEventListener("click", () => {
    if (!state.jobId) {
      alert("Open a job first.");
      return;
    }
    maybeStartRelated(state.jobId).catch((e) => alert(e.message || String(e)));
  });
  $("#btnReportsRefresh")?.addEventListener("click", () => renderReports());
  $("#btnReportsExcel")?.addEventListener("click", () => exportManagementExcel());
  $("#btnReportsBack")?.addEventListener("click", () => showReviewFromReports());
  $("#btnTimesheetRefresh")?.addEventListener("click", () => {
    loadTimesheet().catch((e) => alert(e.message || String(e)));
  });
  $("#btnTimesheetCsv")?.addEventListener("click", () => exportTimesheetCsv());
  $("#btnTimesheetBack")?.addEventListener("click", () => {
    if (state.catalog) showReviewFromReports();
    else showScreen("upload");
  });
  $("#btnFocus")?.addEventListener("click", () => {
    toggleFocusMode().catch((e) => console.warn(e));
  });
  $("#btnTheme")?.addEventListener("click", () => toggleTheme());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseParentTimer({ persist: true });
    else if (isReviewScreen()) resumeParentTimer();
  });
  window.addEventListener("beforeunload", () => {
    pauseParentTimer({ persist: false });
    // best-effort sync via fetch keepalive is omitted; last persistProgress covers most cases
  });
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) {
      lockKeyboard().catch(() => {});
      const btn = $("#btnFocus");
      if (btn) btn.textContent = "Exit focus";
    } else {
      unlockKeyboard();
      const btn = $("#btnFocus");
      if (btn) btn.textContent = "Focus mode";
    }
  });
  $("#btnExport").addEventListener("click", async () => {
    if (!state.jobId) return;
    setProgress(true, "Exporting decisions…", 50);
    try {
      const res = await fetch(`/api/jobs/${state.jobId}/export`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        alert("Export failed");
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `review_decisions__${state.jobName || "job"}.json`;
      a.click();
    } finally {
      setProgress(false);
    }
  });
  // Capture phase so we beat browser chrome when Keyboard Lock is active
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("keydown", onKey, true);
  // Dark mode also works on the upload screen (same as desktop T)
  window.addEventListener(
    "keydown",
    (e) => {
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[data-screen="reports"].active')) {
        if (e.key === "Escape" || e.key === "r" || e.key === "R" || e.key === "s" || e.key === "S") {
          e.preventDefault();
          showReviewFromReports();
          return;
        }
        if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          toggleTheme();
        }
        return;
      }
      if (isReviewScreen()) return;
      if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleTheme();
      }
    },
    true,
  );
}

async function boot() {
  initTheme();
  syncPassTabUi();
  wireUpload();
  wireReview();
  showScreen("upload");
  setProgress(true, "Loading saved jobs…", 30);
  try {
    await refreshJobs();
  } catch (e) {
    console.warn(e);
  } finally {
    setProgress(false);
  }
}

boot();
