#!/usr/bin/env node
/**
 * Build public/naming-convention.js from MDCOE procurement spec lists.
 *
 * Default source (first that exists):
 *   1. cloudflare-gate/data/procurement-naming-dump.json  (drop a dump from the other machine)
 *   2. ../MDCOE_Hub/apps/procurement-test/src/config/procurement_config.json
 *
 * Dump on the other machine (Master Drilling Cloudflare account):
 *   wrangler d1 execute procurement-config-db --remote --json --file=scripts/dump-procurement-naming.sql
 * then save the JSON as data/procurement-naming-dump.json and re-run this script.
 *
 *   node scripts/build-naming-backbone.mjs
 *   node scripts/build-naming-backbone.mjs --from /path/to/dump.json
 *   node scripts/build-naming-backbone.mjs --overlay-only
 *     (copies ../NAMING_STANDARDS.js into public/ so Pass 4 picks it up)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gateRoot = join(here, "..");
const defaultDump = join(gateRoot, "data", "procurement-naming-dump.json");
const defaultHub = resolve(
  gateRoot,
  "..",
  "..",
  "MDCOE_Hub",
  "apps",
  "procurement-test",
  "src",
  "config",
  "procurement_config.json",
);
const outPath = join(gateRoot, "public", "naming-convention.js");
const overlayCandidates = [
  join(gateRoot, "..", "NAMING_STANDARDS.js"),
  join(gateRoot, "NAMING_STANDARDS.js"),
];
const overlayDest = join(gateRoot, "public", "NAMING_STANDARDS.js");

function copyNamingStandardsSlot() {
  const src = overlayCandidates.find((p) => existsSync(p));
  if (!src) {
    console.warn(`No NAMING_STANDARDS.js found (looked at repo root and ${gateRoot})`);
    return null;
  }
  mkdirSync(dirname(overlayDest), { recursive: true });
  writeFileSync(overlayDest, readFileSync(src));
  console.log(`Copied naming slot ${src} → ${overlayDest}`);
  return src;
}

copyNamingStandardsSlot();
if (process.argv.includes("--overlay-only")) process.exit(0);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return "";
}

function unwrapWranglerJson(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (Array.isArray(raw.categories) || Array.isArray(raw.specLists) || Array.isArray(raw.lists)) return raw;
  const results = Array.isArray(raw) ? raw : raw.results;
  if (!Array.isArray(results)) return raw;
  const tables = {};
  for (const block of results) {
    const rows = block?.results || block?.rows || [];
    if (!rows.length) continue;
    const keys = Object.keys(rows[0] || {});
    const blob = JSON.stringify(keys).toLowerCase();
    if (blob.includes("parentid") || blob.includes("parent_id") || blob.includes("startswith")) {
      tables.categories = rows;
    } else if (blob.includes("isrequired") || blob.includes("is_required") || blob.includes("prefix")) {
      tables.specLists = rows;
    } else if (blob.includes("listid") || blob.includes("list_id")) {
      tables.specOptions = rows;
    }
  }
  return { ...tables, generatedFrom: "wrangler-d1-json" };
}

function camel(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[nk] = v;
  }
  return out;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function normName(name) {
  return String(name || "")
    .replace(/\u00A0/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function nameKeys(name) {
  const u = normName(name);
  const keys = new Set();
  const add = (s) => {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    if (v) keys.add(v);
  };
  add(u);
  add(u.replace(/\s*\([^)]*\)\s*/g, " "));
  for (const key of [...keys]) {
    const parts = key.split(" ").filter(Boolean);
    if (!parts.length) continue;
    const last = parts[parts.length - 1];
    if (last.length > 3 && /S$/.test(last) && last !== "BRASS" && last !== "GLASS" && last !== "PRESS") {
      add([...parts.slice(0, -1), last.replace(/S$/, "")].join(" "));
    }
  }
  return [...keys].filter(Boolean);
}

function optionAliases(value) {
  const raw = String(value || "").trim();
  const upper = raw.toUpperCase();
  const aliases = new Set();
  if (!upper) return [];
  aliases.add(upper);
  const stripped = upper.replace(/["'“”]/g, "");
  if (stripped !== upper) aliases.add(stripped);
  const m = upper.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (m) {
    aliases.add(m[1].trim());
    aliases.add(m[2].trim());
    aliases.add(m[1].replace(/["']/g, "").trim());
    aliases.add(m[2].replace(/["']/g, "").trim());
  }
  aliases.add(upper.replace(/\s+/g, ", "));
  aliases.add(stripped.replace(/\s+/g, ", "));
  return [...aliases].filter((a) => a && a !== "(" && a !== ")");
}

function loadSource() {
  const fromArg = argValue("--from");
  const candidates = [fromArg, defaultDump, defaultHub].filter(Boolean);
  for (const p of candidates) {
    const abs = resolve(p);
    if (!existsSync(abs)) continue;
    const parsed = JSON.parse(readFileSync(abs, "utf8"));
    const data = unwrapWranglerJson(parsed);
    return { path: abs, data };
  }
  throw new Error(
    `No naming dump found. Put one at ${defaultDump} or pass --from /path/to.json`,
  );
}

const { path: sourcePath, data } = loadSource();
const categories = asArray(data.categories).map(camel);
const specLists = asArray(data.specLists || data.lists).map(camel);
const specOptions = asArray(data.specOptions || data.options).map(camel);

const parentById = new Map();
const childrenById = new Map();
for (const c of categories) {
  const id = String(c.id);
  parentById.set(id, c.parentId == null || c.parentId === "" ? null : String(c.parentId));
  childrenById.set(id, childrenById.get(id) || []);
}
for (const c of categories) {
  const pid = parentById.get(String(c.id));
  if (pid) {
    if (!childrenById.has(pid)) childrenById.set(pid, []);
    childrenById.get(pid).push(String(c.id));
  }
}

function ancestorIds(id) {
  const chain = [];
  const seen = new Set();
  let cur = String(id);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentById.get(cur);
  }
  return chain.reverse();
}

function pathNames(id) {
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  return ancestorIds(id)
    .map((cid) => byId.get(cid)?.name)
    .filter(Boolean);
}

const listsByCat = new Map();
for (const l of specLists) {
  const cid = String(l.categoryId ?? l.category_id ?? "");
  if (!cid) continue;
  if (!listsByCat.has(cid)) listsByCat.set(cid, []);
  listsByCat.get(cid).push(l);
}
for (const arr of listsByCat.values()) {
  arr.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.id) - Number(b.id));
}

const optsByList = new Map();
for (const o of specOptions) {
  const lid = String(o.listId ?? o.list_id ?? "");
  if (!lid) continue;
  if (!optsByList.has(lid)) optsByList.set(lid, []);
  optsByList.get(lid).push(o);
}
for (const arr of optsByList.values()) {
  arr.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.id) - Number(b.id));
}

function fieldsFor(categoryId) {
  const out = [];
  for (const cid of ancestorIds(categoryId)) {
    for (const list of listsByCat.get(cid) || []) {
      const opts = (optsByList.get(String(list.id)) || []).map((o) => ({
        id: String(o.id),
        value: String(o.value || "").trim(),
        aliases: optionAliases(o.value),
      }));
      out.push({
        id: String(list.id),
        name: String(list.name || "").trim(),
        required: Boolean(list.isRequired === true || list.isRequired === 1 || list.isRequired === "1"),
        prefix: list.prefix == null ? " " : String(list.prefix),
        sortOrder: Number(list.sortOrder || 0),
        categoryId: String(list.categoryId ?? cid),
        dependentOnOptionId: list.dependentOnOptionId ? String(list.dependentOnOptionId) : "",
        options: opts,
      });
    }
  }
  return out;
}

const isLeaf = (id) => !(childrenById.get(String(id)) || []).length;

const built = [];
for (const c of categories) {
  const id = String(c.id);
  const fields = fieldsFor(id);
  const leaf = isLeaf(id);
  if (!leaf && !fields.length) continue;
  built.push({
    id,
    name: String(c.name || "").trim(),
    nameUpper: normName(c.name),
    keys: nameKeys(c.name),
    parentId: parentById.get(id),
    startsWith: c.startsWith == null ? "" : String(c.startsWith),
    path: pathNames(id),
    leaf,
    fields,
  });
}

built.sort((a, b) => a.nameUpper.localeCompare(b.nameUpper) || a.id.localeCompare(b.id, undefined, { numeric: true }));

const nWithFields = built.filter((c) => c.fields.length).length;
const nRequired = built.reduce(
  (n, c) => n + c.fields.filter((f) => f.required).length,
  0,
);

const payload = {
  source: sourcePath,
  generatedFrom: data.generatedFrom || data.version || "",
  generatedAt: new Date().toISOString(),
  assembler: {
    emptyPrefix: ", ",
    hyphenPrefix: "-",
    timesPrefix: " x ",
    otherPrefix: " PREFIX ",
    uppercase: true,
    typeFirst: "leaf category L4 or else L3",
  },
  nCategories: built.length,
  nWithFields,
  nRequiredFieldSlots: nRequired,
  nSpecLists: specLists.length,
  nSpecOptions: specOptions.length,
  categories: built,
};

mkdirSync(dirname(outPath), { recursive: true });
const body = `/** Generated by scripts/build-naming-backbone.mjs — do not edit by hand. */\nexport default ${JSON.stringify(payload)};\n`;
writeFileSync(outPath, body);
console.log(
  `Wrote ${outPath}\n  source: ${sourcePath}\n  categories: ${built.length} (${nWithFields} with fields, ${specLists.length} lists, ${specOptions.length} options)`,
);
if (nWithFields < 20) {
  console.log(
    "  Note: this dump has almost no field lists (Cap Screw etc. are empty). Drop a live D1 dump from the other machine and rebuild.",
  );
}
