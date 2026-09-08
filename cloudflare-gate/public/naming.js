/**
 * MDCOE product-master naming convention — Pass 4 backbone.
 *
 * Computed name = leaf category (L4 else L3) + visible spec fields in list order,
 * joined with appendPmDescriptionPart, then ALL CAPS.
 *   empty prefix → ", "
 *   prefix "-"   → hyphen
 *   prefix "X"   → " x "
 *   other prefix → " PREFIX "
 */
import CONVENTION from "./naming-convention.js?v=2";
import STANDARDS from "./NAMING_STANDARDS.js?v=1";

const P4_NOUNS = new Set([
  "BOLT", "NUT", "WASHER", "SCREW", "HOSE", "PIPE", "TUBE", "BEARING", "FILTER",
  "VALVE", "GASKET", "SEAL", "CLAMP", "SPRING", "BUSH", "FITTING", "COUPLING",
  "NIPPLE", "ELBOW", "PLUG", "CAP", "SHIM", "SHIRT", "PANTS", "JACKET", "GLOVE",
  "GLOVES", "OVERALL", "TAPE", "SWITCH", "SENSOR", "CABLE", "MOTOR", "PUMP",
  "CYLINDER", "INSERT", "RELAY", "ADAPTER", "ADAPTOR", "PIN", "RING", "SPACER",
  "BRACKET", "GUARD", "GAUGE", "DRILL", "BIT", "CUTTER", "OIL", "PAINT", "BOOT",
  "HELMET", "HARNESS", "LAMP", "BULB", "ROD", "PLATE", "SPANNER", "WRENCH",
  "KEY", "FUSE", "SLING", "LUG", "FLANGE", "SHAFT", "CIRCLIP", "CONNECTOR",
  "PISTON", "COVER", "WIRE", "KIT", "BREAKER", "BATTERY", "TRANSFORMER",
  "GREASE", "STICKER", "CONTACTOR", "GEAR", "TIE", "BUSHING", "REDUCER",
  "UNION", "TEE", "SOCKET", "FASTENER", "GUMBOOT", "GUMBOOTS", "BOILERSUIT",
]);
const P4_COMPOUND_KEEP = new Set([
  "CABLE TIE", "CABLE TIES", "CIRCUIT BREAKER", "BALL VALVE", "CHECK VALVE",
  "DRILL ROD", "HEAT SHRINK", "POWER SUPPLY", "DIN RAIL", "SAFETY BOOT",
  "SAFETY BOOTS", "SAFETY GUMBOOT", "SAFETY GUMBOOTS", "SAFETY HARNESS",
  "SAFETY HELMET", "SOCKET HEAD", "GATE VALVE", "FOOT VALVE", "NEEDLE VALVE",
  "GLOBE VALVE", "BALL BEARING", "ROLLER BEARING",
]);
const P4_ADJ = new Set([
  "HEX", "SOCKET", "SPHERICAL", "HYDRAULIC", "ELECTRIC", "WELDING", "PRESSURE",
  "WATER", "FOAM", "PACKAGING", "MASKING", "HALOGEN", "RADIAL", "PARALLEL",
  "FLANGE", "PLANET", "NYLON", "STAINLESS", "GALVANISED", "GALVANIZED",
  "METRIC", "HEAVY", "LIGHT", "DOUBLE", "SINGLE", "MALE", "FEMALE", "FLAT",
  "LOCK", "NYLOC", "WING",
]);
const P4_FLIPS = [
  [/^HEX BOLT\b/, "BOLT, HEX"],
  [/^HEX NUT\b/, "NUT, HEX"],
  [/^HEX HEAD BOLT\b/, "BOLT, HEX HEAD"],
  [/^SOCKET HEAD (?:CAP )?BOLT\b/, "BOLT, SOCKET HEAD"],
  [/^SOCKET BOLT\b/, "BOLT, SOCKET"],
  [/^SPHERICAL ROLLER BEARING\b/, "BEARING, SPHERICAL ROLLER"],
  [/^SPHERICAL RLR BEARING\b/, "BEARING, SPHERICAL ROLLER"],
  [/^SPHERICAL WASHER\b/, "WASHER, SPHERICAL"],
  [/^HEAT SHRINK CAP\b/, "CAP, HEAT SHRINK"],
  [/^FOAM TAPE\b/, "TAPE, FOAM"],
  [/^PACKAGING TAPE\b/, "TAPE, PACKAGING"],
  [/^MASKING TAPE\b/, "TAPE, MASKING"],
  [/^HALOGEN BULB\b/, "BULB, HALOGEN"],
  [/^HYDRAULIC HOSE\b/, "HOSE, HYDRAULIC"],
  [/^ELECTRIC MOTOR\b/, "MOTOR, ELECTRIC"],
];

const SIZE_RE = /\bM\d|\d+\s*(?:MM|IN|INCH|")|\d+\s*X\s*\d|\d+\/\d/i;
const MATERIAL_RE = /\b(?:STAINLESS|SS316|SS304|CARBON STEEL|\bCS\b|BRASS|NYLON|PVC|ALUMINIUM|ALUMINUM|STEEL|GALVANISED|GALVANIZED)\b/i;

function normKey(name) {
  return String(name || "")
    .replace(/\u00A0/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[_/]+/g, " ")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function overlayField(item, i) {
  if (typeof item === "string") {
    return {
      id: `std-${i}`,
      name: item.trim(),
      required: true,
      prefix: " ",
      sortOrder: i,
      categoryId: "overlay",
      dependentOnOptionId: "",
      options: [],
    };
  }
  const name = String(item?.name || item?.field || "").trim();
  const opts = (item?.options || item?.values || []).map((value, j) => {
    const v = String(value?.value || value || "").trim();
    return { id: `opt-${i}-${j}`, value: v, aliases: value?.aliases || [v.toUpperCase()] };
  });
  return {
    id: String(item?.id || `std-${i}-${name}`),
    name,
    required: item?.required !== false && item?.optional !== true,
    prefix: item?.prefix == null ? " " : String(item.prefix),
    sortOrder: Number(item?.sortOrder != null ? item.sortOrder : i),
    categoryId: "overlay",
    dependentOnOptionId: item?.dependentOnOptionId ? String(item.dependentOnOptionId) : "",
    options: opts,
  };
}

function specToFields(spec) {
  if (Array.isArray(spec)) return spec.map((item, i) => overlayField(item, i)).filter((f) => f.name);
  if (!spec || typeof spec !== "object") return [];
  if (Array.isArray(spec.fields)) return spec.fields.map((item, i) => overlayField(item, i)).filter((f) => f.name);
  const req = spec.required || spec.need || [];
  const opt = spec.optional || spec.nice || [];
  return [
    ...req.map((n, i) => overlayField(typeof n === "string" ? { name: n, required: true } : n, i)),
    ...opt.map((n, i) => overlayField(typeof n === "string" ? { name: n, required: false } : { ...n, required: false }, i + req.length)),
  ].filter((f) => f.name);
}

function overlayMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (raw.categories && typeof raw.categories === "object" && !Array.isArray(raw.categories) && !raw.fields && !raw.required) {
    return raw.categories;
  }
  return raw;
}

function applyStandardsOverlay(base) {
  const list = (base || []).map((c) => ({ ...c, fields: Array.isArray(c.fields) ? c.fields.slice() : [] }));
  const byKey = new Map();
  const remember = (cat) => {
    for (const k of cat.keys || []) if (k) byKey.set(k, cat);
    if (cat.nameUpper) byKey.set(cat.nameUpper, cat);
  };
  for (const c of list) remember(c);

  const entries = Object.entries(overlayMap(STANDARDS)).filter(([k]) => k && !k.startsWith("_"));
  for (const [name, spec] of entries) {
    const fields = specToFields(spec);
    if (!fields.length) continue;
    const aliases = [
      name,
      ...(Array.isArray(spec?.aliases) ? spec.aliases : []),
    ].map(normKey).filter(Boolean);
    const matches = list.filter((c) => {
      const keys = new Set([c.nameUpper, ...(c.keys || [])]);
      return aliases.some((a) => keys.has(a));
    });
    if (!matches.length) {
      const nameUpper = normKey(name);
      const cat = {
        id: `overlay-${nameUpper.replace(/\s+/g, "-")}`,
        name: String(name).trim(),
        nameUpper,
        keys: [...new Set(aliases)],
        parentId: null,
        startsWith: "",
        path: ["NAMING_STANDARDS"],
        leaf: true,
        fields,
        overlay: true,
      };
      list.push(cat);
      remember(cat);
      continue;
    }
    for (const cat of matches) {
      cat.fields = fields;
      cat.overlay = true;
    }
  }
  return list;
}

let _categories;
function categories() {
  if (!_categories) {
    _categories = applyStandardsOverlay(Array.isArray(CONVENTION?.categories) ? CONVENTION.categories : []);
  }
  return _categories;
}

export function namingMeta() {
  const cats = categories();
  const nOverlay = cats.filter((c) => c.overlay && c.fields?.length).length;
  return {
    source: CONVENTION?.source || "",
    generatedAt: CONVENTION?.generatedAt || "",
    nCategories: cats.length,
    nWithFields: cats.filter((c) => c.fields?.length).length,
    nOverlay,
    nSpecLists: Number(CONVENTION?.nSpecLists) || 0,
    nSpecOptions: Number(CONVENTION?.nSpecOptions) || 0,
  };
}

export function appendPmDescriptionPart(current, prefix, value) {
  const base = String(current || "").trim();
  const part = String(value || "").trim();
  if (!part) return base;
  if (!base) return part;
  const normalizedPrefix = String(prefix || "").trim().toUpperCase();
  if (normalizedPrefix === "-") return `${base}-${part}`;
  if (normalizedPrefix === "X") return `${base} x ${part}`;
  if (normalizedPrefix) return `${base} ${normalizedPrefix} ${part}`;
  return `${base}, ${part}`;
}

export function p4Mech(text) {
  let s = String(text || "")
    .replace(/\u00A0/g, " ")
    .replace(/[Øø]/g, "O")
    .trim();
  s = s.replace(/\s+/g, " ").toUpperCase();
  s = s.replace(/,([^\s])/g, ", $1");
  s = s.replace(/\s+,/g, ",");
  s = s.replace(/,\s+/g, ", ");
  return s.replace(/^[,\s]+|[,\s]+$/g, "");
}

function p4FirstSeg(text) {
  return String(text || "").split(",")[0].trim();
}

function p4IsNoun(tok) {
  const t = String(tok || "");
  return P4_NOUNS.has(t) || P4_NOUNS.has(t.replace(/S$/, ""));
}

function p4Propose(text) {
  let p = p4Mech(text);
  for (const [re, repl] of P4_FLIPS) {
    if (re.test(p)) {
      p = p.replace(re, repl);
      break;
    }
  }
  return p;
}

function p4AdjFirst(seg) {
  const parts = String(seg || "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const key = `${parts[0]} ${parts[1]}`;
  if (P4_COMPOUND_KEEP.has(key)) return false;
  return P4_ADJ.has(parts[0]) && p4IsNoun(parts[1]);
}

function p4HouseOk(text) {
  const s = String(text || "");
  if (!s || !s.includes(",")) return false;
  if (/,[^\s]/.test(s)) return false;
  if (/^\d/.test(s)) return false;
  if (/[a-z]/.test(s)) return false;
  if (p4AdjFirst(p4FirstSeg(s))) return false;
  return true;
}

function normHay(text) {
  return String(text || "")
    .replace(/\u00A0/g, " ")
    .replace(/&/g, " AND ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bounded(hay, needle) {
  const n = String(needle || "").trim();
  if (!n || !hay) return false;
  const re = new RegExp(`(^|[^A-Z0-9])${escapeRe(n)}([^A-Z0-9]|$)`);
  return re.test(hay);
}

function scoreNameMatch(hay, firstSeg, cat) {
  const keys = (cat.keys && cat.keys.length ? cat.keys : [cat.nameUpper]).filter(Boolean);
  const firstWord = firstSeg.split(/\s+/)[0] || "";
  let best = 0;
  for (const key of keys) {
    if (!key) continue;
    const toks = key.split(" ").filter((t) => t && t !== "AND");
    if (firstSeg === key) best = Math.max(best, 1000 + key.length);
    else if (hay.startsWith(`${key},`) || hay.startsWith(`${key} `) || hay === key) {
      best = Math.max(best, 800 + key.length);
    } else if (toks.length === 1 && key.length <= 8) {
      if (firstWord === key) best = Math.max(best, 700 + key.length);
    } else if (bounded(hay, key)) best = Math.max(best, 500 + key.length);
    else if (toks.length >= 2 && toks.every((t) => bounded(hay, t))) {
      best = Math.max(best, 200 + key.length);
    }
  }
  return best;
}

function fieldedCategories() {
  return categories().filter((c) => Array.isArray(c.fields) && c.fields.length);
}

function optionPresent(hay, usedSpans, opt) {
  const aliases = [...(opt.aliases || []), opt.value].filter(Boolean)
    .map((a) => String(a).toUpperCase().trim())
    .filter(Boolean);
  const variants = new Set();
  for (const a of aliases) {
    variants.add(a);
    variants.add(a.replace(/\s+/g, ", "));
    variants.add(a.replace(/,\s*/g, " "));
  }
  const sorted = [...variants].sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    if (alias.length < 2) continue;
    const re = new RegExp(`(^|[^A-Z0-9])(${escapeRe(alias)})([^A-Z0-9]|$)`);
    const m = hay.match(re);
    if (!m) continue;
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    const overlap = usedSpans.some((sp) => start < sp.end && end > sp.start);
    if (overlap) continue;
    return { value: opt.value, alias: m[2], start, end, optionId: String(opt.id || "") };
  }
  return null;
}

function heuristicFieldHit(field, hay, usedSpans = []) {
  const n = String(field.name || "").toUpperCase();
  let re = null;
  if (/SIZE|DIAMETER|DIA|LENGTH|THREAD|PITCH/.test(n)) re = new RegExp(SIZE_RE.source, "gi");
  else if (/MATERIAL/.test(n)) re = new RegExp(MATERIAL_RE.source, "gi");
  else if (/GRADE/.test(n)) re = /\b\d+\.\d+\b|\b(?:8\.8|10\.9|12\.9|A2|A4)\b/gi;
  if (!re) return null;
  let m;
  while ((m = re.exec(hay))) {
    const start = m.index;
    const end = start + m[0].length;
    if (usedSpans.some((sp) => start < sp.end && end > sp.start)) continue;
    return { value: m[0].toUpperCase(), alias: m[0].toUpperCase(), start, end, optionId: "" };
  }
  return null;
}

function matchFields(cat, description) {
  const hay = normHay(description);
  const used = [];
  const hits = [];
  const matchedOptionIds = new Set();
  const fields = cat.fields || [];

  for (const field of fields) {
    const dep = String(field.dependentOnOptionId || "");
    const visible = !dep || matchedOptionIds.has(dep);
    let hit = null;
    if (visible) {
      const opts = [...(field.options || [])].sort((a, b) => {
        const la = Math.max(0, ...(a.aliases || []).map((x) => x.length), String(a.value || "").length);
        const lb = Math.max(0, ...(b.aliases || []).map((x) => x.length), String(b.value || "").length);
        return lb - la;
      });
      for (const opt of opts) {
        hit = optionPresent(hay, used, opt);
        if (hit) break;
      }
      if (!hit && !(field.options || []).length && !cat.overlay && field.categoryId !== "overlay") {
        hit = heuristicFieldHit(field, hay, used);
      }
    }
    if (hit) {
      used.push({ start: hit.start, end: hit.end });
      if (hit.optionId) matchedOptionIds.add(hit.optionId);
    }
    const required = Boolean(field.required) && visible;
    hits.push({
      id: field.id,
      name: field.name,
      required,
      visible,
      prefix: field.prefix,
      present: Boolean(hit),
      matched: hit ? String(hit.value || hit.alias || "") : "",
      options: (field.options || []).map((o) => o.value),
    });
  }
  fillPositionalFields(cat, description, hits);
  return hits;
}

function fillPositionalFields(cat, description, hits) {
  const open = hits.filter((h) => h.visible && !h.present && !(h.options || []).length);
  if (!open.length) return;
  const mech = p4Mech(description);
  let segs = mech.split(",").map((s) => s.trim()).filter(Boolean);
  const fam = String(cat.nameUpper || "");
  const famKeys = new Set([fam, ...(cat.keys || [])].map(normKey));
  if (segs.length && famKeys.has(normKey(segs[0]))) segs = segs.slice(1);
  const taken = new Set(hits.filter((h) => h.present).map((h) => normKey(h.matched)));
  const leftover = segs.filter((s) => !taken.has(normKey(s)));
  let i = 0;
  for (const h of open) {
    if (i >= leftover.length) break;
    h.present = true;
    h.matched = leftover[i];
    i += 1;
  }
}

function assembleFromHits(cat, hits) {
  let name = String(cat.nameUpper || cat.name || "").trim();
  for (const h of hits) {
    if (!h.visible || !h.present || !h.matched) continue;
    name = appendPmDescriptionPart(name, h.prefix, h.matched);
  }
  return String(name).toUpperCase();
}

function optionHitScore(cat, description) {
  const hits = matchFields(cat, description);
  const req = hits.filter((h) => h.required);
  const reqHit = req.filter((h) => h.present).length;
  const optHit = hits.filter((h) => !h.required && h.present).length;
  return { hits, score: reqHit * 10 + optHit, reqHit, reqNeed: req.length };
}

export function matchNamingCategory(description) {
  const hay = normHay(description);
  const firstSeg = p4FirstSeg(hay);
  let best = null;
  let bestScore = 0;
  for (const cat of categories()) {
    if (!cat.nameUpper || cat.nameUpper.length < 3) continue;
    const s = scoreNameMatch(hay, firstSeg, cat);
    if (s > bestScore || (s === bestScore && cat.overlay && !best?.overlay)) {
      bestScore = s;
      best = cat;
    }
  }

  let fieldBest = null;
  let fieldScore = 0;
  for (const cat of fieldedCategories()) {
    const { score, reqHit, reqNeed } = optionHitScore(cat, description);
    if (reqNeed && reqHit === 0) continue;
    if (score > fieldScore) {
      fieldScore = score;
      fieldBest = cat;
    }
  }

  if (fieldBest && fieldScore >= 20 && (!best || !best.fields?.length || best.id === fieldBest.id)) {
    return { category: fieldBest, via: best?.id === fieldBest.id ? "name" : "fields", nameScore: bestScore, fieldScore };
  }
  if (best) return { category: best, via: "name", nameScore: bestScore, fieldScore };
  if (fieldBest && fieldScore >= 10) {
    return { category: fieldBest, via: "fields", nameScore: bestScore, fieldScore };
  }
  return { category: null, via: "", nameScore: 0, fieldScore: 0 };
}

function formatReasons(orig, mech) {
  const reasons = [];
  if (!orig) reasons.push("empty name");
  if (/[a-z]/.test(orig) && orig !== orig.toUpperCase()) reasons.push("not ALL CAPS");
  if (!orig.includes(",")) reasons.push("no comma facets");
  if (/,[^\s]/.test(orig)) reasons.push("comma without space");
  if (/^\d/.test(orig)) reasons.push("starts with a digit");
  if (p4AdjFirst(p4FirstSeg(mech))) reasons.push("adjective before type");
  return reasons;
}

function result(partial) {
  return {
    verdict: "review",
    status: "",
    note: "",
    proposal: "",
    family: "",
    reasons: [],
    reason: "",
    category: null,
    fields: [],
    missingRequired: [],
    templateMissing: false,
    ...partial,
  };
}

function scoreFormatFallback(pn, orig, opts = {}) {
  const mech = p4Mech(orig);
  const skipFlips = Boolean(opts.skipFlips);
  const categoryName = String(opts.categoryName || "").trim();
  const proposal = skipFlips ? mech : p4Propose(orig);
  const flipped = proposal !== mech;
  const reasons = formatReasons(orig, mech);
  if (flipped) reasons.push("type should lead (proposal flips adjective/type)");
  const family = categoryName || p4FirstSeg(proposal) || "";
  if (categoryName) {
    const head = p4FirstSeg(mech);
    if (head !== categoryName && !head.startsWith(`${categoryName} `) && !mech.startsWith(`${categoryName},`)) {
      reasons.push(`should start with ${categoryName}`);
    }
  }
  if (!orig) {
    return result({
      verdict: "review",
      proposal,
      family,
      reasons,
      reason: "Empty description",
    });
  }
  if (!skipFlips && flipped) {
    return result({
      verdict: "rewrite",
      status: "rewritten",
      note: `std:${proposal}`,
      proposal,
      family,
      reasons,
      reason: "Known type-first rewrite",
    });
  }
  const startsWithCat = !categoryName
    || p4FirstSeg(mech) === categoryName
    || p4FirstSeg(mech).startsWith(`${categoryName} `)
    || mech.startsWith(`${categoryName},`);
  if (p4HouseOk(mech) && startsWithCat) {
    if (mech !== orig) {
      return result({
        verdict: "rewrite",
        status: "rewritten",
        note: `std:${mech}`,
        proposal: mech,
        family,
        reasons,
        reason: "Caps / comma spacing",
      });
    }
    return result({
      verdict: "standard",
      status: "standard",
      note: "auto: house_style",
      proposal: orig,
      family,
      reasons: [],
      reason: categoryName ? `Starts with ${categoryName}, comma facets, ALL CAPS` : "Already house style",
    });
  }
  return result({
    verdict: "review",
    proposal,
    family,
    reasons,
    reason: reasons.join(" · ") || "Needs a human look",
  });
}

/**
 * Pass 4: standardisation against the MDCOE naming backbone.
 * verdict standard | rewrite | review.
 */
export function scorePass4Product(pn, description) {
  const orig = String(description || "").trim();
  const mech = p4Mech(orig);
  const { category, via } = matchNamingCategory(orig);
  if (!category) {
    const fb = scoreFormatFallback(pn, orig);
    fb.reason = fb.reason ? `${fb.reason} (no category template)` : "No category template";
    return fb;
  }

  const family = category.nameUpper || category.name || "";
  const hasFields = Array.isArray(category.fields) && category.fields.length;
  if (!hasFields) {
    const fb = scoreFormatFallback(pn, orig, { skipFlips: true, categoryName: family });
    return result({
      ...fb,
      family,
      category: { id: category.id, name: category.name, path: category.path || [] },
      templateMissing: true,
      reason: fb.verdict === "review"
        ? `${family}: no field list in this dump · ${fb.reason}`
        : fb.reason,
    });
  }

  const fields = matchFields(category, orig);
  const missingRequired = fields.filter((f) => f.required && !f.present).map((f) => f.name);
  const assembled = assembleFromHits(category, fields);
  const reasons = formatReasons(orig, mech);
  if (missingRequired.length) reasons.push(`missing ${missingRequired.join(", ")}`);
  const firstOk = p4FirstSeg(mech) === family || p4FirstSeg(mech).startsWith(family);
  if (!firstOk) reasons.push(`should start with ${family}`);

  const catInfo = { id: category.id, name: category.name, path: category.path || [], via };
  if (missingRequired.length) {
    return result({
      verdict: "review",
      proposal: assembled || mech || orig,
      family,
      reasons,
      reason: `${family} needs ${missingRequired.join(", ")}`,
      category: catInfo,
      fields,
      missingRequired,
    });
  }

  const origNorm = p4Mech(orig).replace(/ X /g, " x ");
  const asmNorm = p4Mech(assembled).replace(/ X /g, " x ");
  if (origNorm === asmNorm) {
    if (orig === assembled) {
      return result({
        verdict: "standard",
        status: "standard",
        note: "auto: naming_template",
        proposal: orig,
        family,
        reasons: [],
        reason: `Matches ${family} field list`,
        category: catInfo,
        fields,
        missingRequired: [],
      });
    }
    return result({
      verdict: "rewrite",
      status: "rewritten",
      note: `std:${assembled}`,
      proposal: assembled,
      family,
      reasons,
      reason: "Caps / comma spacing to template",
      category: catInfo,
      fields,
      missingRequired: [],
    });
  }

  return result({
    verdict: "rewrite",
    status: "rewritten",
    note: `std:${assembled}`,
    proposal: assembled,
    family,
    reasons,
    reason: `Rewrite to ${family} field order`,
    category: catInfo,
    fields,
    missingRequired: [],
  });
}
