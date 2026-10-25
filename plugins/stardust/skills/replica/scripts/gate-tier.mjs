/* eslint-disable no-restricted-syntax, no-continue, max-len, no-plusplus, no-bitwise, object-curly-newline */
/**
 * skills/replica/scripts/gate-tier.mjs — library (no CLI): the tiered sibling gate of gate-all.mjs (#141).
 * The rule's one home is source-fidelity-gate.md § The all-pages published-origin gate; this file holds its pure parts.
 *
 *   resolveRoles(pages, { metas, variance })  → slug → { role: archetype|unique|sibling, archetype, why }
 *   parseSkeleton(plainHtml)                   → { sections, tokens[] } — blocks in order, `name(variant,…)`
 *   compareSkeleton(sibling, archetype)        → { ok, newTokens[], orderOk, missing[], reason }
 *   pickSample(siblings, { n, seed })          → slug → 'sample: covers <tokens>' | 'sample: variant <v>' | 'sample: random'
 *   planTiers(…)                               → slug → { gateTier: full|structural, reason, stratum, archetype, skeleton }
 *   contentCountOk(slug, { metas, importCheck }) — the import-time content count (#140) passed
 *
 * A sibling earns the STRUCTURAL row only when its archetype's own row passed at this width, its import-time content
 * count passed and its blocks keep the archetype's order (an omitted block is fine); every block or variant the
 * archetype does not carry is covered by a sampled sibling's FULL row in the same run (the stratified sample: the
 * fewest siblings covering every new token, one per state variant, then n more by the seeded order).
 */

const normUrl = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname.replace(/\/+$/, '') || '/'}`; } catch { return String(u || '').replace(/\/+$/, ''); } };

/**
 * Who is whose archetype. Sources, first match wins: the page's `_meta.json` (`fidelityTier: "sibling"` +
 * `archetypeSource` | `template`), a sibling-variance JSON that lists the page's URL under `siblings[]` (its
 * `archetype` URL names the archetype), the state row's `representative` (`state.mjs add`, #146), the state `template` group (pages with a `prototypePath` are its archetypes;
 * a sibling takes the one with its `variant`, else the first). A page named by no rule is `unique`.
 * pages: [{ slug, url, template, variant, prototypePath, representative }]; metas: slug → _meta.json; variance: [{ archetype, siblings: [{ url } | url] }].
 */
export function resolveRoles(pages, { metas = {}, variance = [] } = {}) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const byUrl = new Map(pages.map((p) => [normUrl(p.url), p.slug]));
  const varianceOf = new Map();
  for (const v of variance) {
    const arch = byUrl.get(normUrl(v.archetype));
    if (!arch) continue;
    for (const s of v.siblings || []) { const slug = byUrl.get(normUrl(typeof s === 'string' ? s : s.url)); if (slug && slug !== arch && !varianceOf.has(slug)) varianceOf.set(slug, arch); }
  }
  const groups = new Map();
  for (const p of pages) if (p.template && p.prototypePath) groups.set(p.template, [...(groups.get(p.template) || []), p]);
  const out = {};
  for (const p of pages) {
    const m = metas[p.slug] || {};
    const metaArch = m.fidelityTier === 'sibling' ? (m.archetypeSource || m.template || null) : null;
    if (metaArch && metaArch !== p.slug) { out[p.slug] = { role: 'sibling', archetype: metaArch, why: '_meta.json' }; continue; }
    if (m.fidelityTier && m.fidelityTier !== 'sibling') { out[p.slug] = { role: 'unique', archetype: null, why: `_meta.json ${m.fidelityTier}` }; continue; }
    if (varianceOf.has(p.slug)) { out[p.slug] = { role: 'sibling', archetype: varianceOf.get(p.slug), why: 'variance probe' }; continue; }
    if (p.representative && p.representative !== p.slug) { out[p.slug] = { role: 'sibling', archetype: p.representative, why: 'state representative' }; continue; }
    const arcs = (!p.prototypePath && groups.get(p.template)) || [];
    if (arcs.length) { const a = arcs.find((x) => x.variant && x.variant === p.variant) || arcs[0]; out[p.slug] = { role: 'sibling', archetype: a.slug, why: `template ${p.template}` }; continue; }
    out[p.slug] = { role: 'unique', archetype: null, why: p.prototypePath ? 'prototyped' : 'no archetype' };
  }
  for (const r of Object.values(out)) if (r.role === 'sibling' && out[r.archetype] && out[r.archetype].role === 'unique') out[r.archetype].role = 'archetype';
  for (const r of Object.values(out)) if (r.role === 'sibling' && !bySlug.has(r.archetype)) r.why += ` (archetype ${r.archetype} not in state)`;
  return out;
}

/**
 * The block skeleton of a delivered document (`<path>.plain.html`): top-level divs are sections, their classed child
 * divs are blocks. Token = block name + sorted variant classes; consecutive repeats collapse; `metadata` is skipped.
 */
export function parseSkeleton(html) {
  const tokens = []; let depth = 0; let sections = 0;
  for (const m of String(html || '').matchAll(/<(\/?)div\b([^>]*)>/gi)) {
    if (m[1]) { depth = Math.max(0, depth - 1); continue; }
    depth += 1;
    if (depth === 1) { sections += 1; continue; }
    if (depth !== 2) continue;
    const cls = (m[2].match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!cls) continue;
    const [name, ...variants] = cls.trim().split(/\s+/);
    if (!name || name === 'metadata') continue;
    const t = variants.length ? `${name}(${[...new Set(variants)].sort().join(',')})` : name;
    if (tokens[tokens.length - 1] !== t) tokens.push(t);
  }
  return { sections, tokens };
}

const isSubsequence = (a, b) => { let i = 0; for (const t of b) if (i < a.length && a[i] === t) i += 1; return i === a.length; };
const nameOf = (t) => t.replace(/\(.*$/, '');

/**
 * Sibling vs archetype skeleton. `newTokens` = blocks / variants the archetype does not carry (the sample must cover
 * them); `orderOk` = the sibling's blocks that the archetype has keep its order (omissions fit); ok = no new token
 * and in order.
 */
export function compareSkeleton(sib, arch) {
  if (!sib || !arch) return { ok: null, newTokens: [], orderOk: null, missing: [], reason: `skeleton n/a (${!sib ? 'page' : 'archetype'} not read)` };
  const known = new Set(arch.tokens); const archNames = arch.tokens.map(nameOf); const names = new Set(archNames);
  const newTokens = [...new Set(sib.tokens.filter((t) => !known.has(t)))];
  const missing = [...new Set(arch.tokens.filter((t) => !sib.tokens.includes(t)))];
  const seq = sib.tokens.map(nameOf).filter((n) => names.has(n)).filter((n, i, a) => a[i - 1] !== n);
  const orderOk = isSubsequence(seq, archNames.filter((n, i, a) => a[i - 1] !== n));
  const ok = !newTokens.length && orderOk;
  const reason = !orderOk ? `block order ${seq.join(' > ')} vs archetype ${archNames.join(' > ')}` : newTokens.length ? `new block/variant ${newTokens.join(', ')}` : null;
  return { ok, newTokens, orderOk, missing, reason };
}

/** FNV-1a 32 — a deterministic, seedable order (the same seed picks the same sample on a rerun). */
export function hash32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

/**
 * Stratified sample per archetype → Map slug → reason. siblings: [{ slug, archetype, stratum (state variant),
 * newTokens[] }]. First the fewest siblings whose full rows cover every token the archetype lacks (greedy: the most
 * uncovered tokens, ties by the seeded order), then one per stratum not yet drawn, then `n` more by the seeded order.
 */
export function pickSample(siblings, { n = 2, seed = '' } = {}) {
  const picked = new Map(); const byArch = new Map();
  for (const s of siblings) byArch.set(s.archetype, [...(byArch.get(s.archetype) || []), s]);
  for (const group of byArch.values()) {
    const order = [...group].sort((a, b) => hash32(`${seed}|${a.slug}`) - hash32(`${seed}|${b.slug}`) || (a.slug < b.slug ? -1 : 1));
    const uncovered = new Set(order.flatMap((s) => s.newTokens || []));
    while (uncovered.size) {
      let best = null; let gain = 0;
      for (const s of order) { if (picked.has(s.slug)) continue; const g = (s.newTokens || []).filter((t) => uncovered.has(t)).length; if (g > gain) { best = s; gain = g; } }
      if (!best) break;
      const covers = best.newTokens.filter((t) => uncovered.has(t)); covers.forEach((t) => uncovered.delete(t));
      picked.set(best.slug, `sample: covers ${covers.join(', ')}`);
    }
    for (const st of [...new Set(order.map((s) => s.stratum))].sort()) if (!order.some((s) => s.stratum === st && picked.has(s.slug))) { const s = order.find((x) => x.stratum === st); picked.set(s.slug, `sample: variant ${st}`); }
    let k = 0;
    for (const s of order) { if (k >= n) break; if (!picked.has(s.slug)) { picked.set(s.slug, 'sample: random'); k += 1; } }
  }
  return picked;
}

/** The import-time content count (#140) passed: `_meta.json` gatesPassed has it, or an import-run --json row is ok. */
export function contentCountOk(slug, { metas = {}, importCheck = {} } = {}) {
  const m = metas[slug];
  if (m && Array.isArray(m.gatesPassed) && m.gatesPassed.includes('content-count')) return true;
  const r = importCheck[slug];
  return !!(r && r.ok === true && !(r.missing || []).length);
}

/** Rows of import-run `--json` files → slug → row (the last file wins). */
export function indexImportCheck(lists) {
  const out = {};
  for (const list of lists) for (const r of Array.isArray(list) ? list : []) if (r && r.slug) out[r.slug] = r;
  return out;
}

/**
 * The plan. roles (resolveRoles), skeletons: slug → parseSkeleton | null, archetypeGated: slug → true|false|null
 * (null = not measured yet), ccOk: slug → bool; opts { sample, seed, full }. A sibling's stratum is its state variant;
 * the sample is drawn among the siblings that would go structural.
 */
export function planTiers(pages, { roles, skeletons = {}, archetypeGated = {}, ccOk = {}, sample = 2, seed = '', full = false } = {}) {
  const plan = {}; const eligible = [];
  for (const p of pages) {
    const r = roles[p.slug] || { role: 'unique' };
    if (r.role !== 'sibling') { plan[p.slug] = { gateTier: 'full', reason: r.role, stratum: null }; continue; }
    const cmp = compareSkeleton(skeletons[p.slug] || null, skeletons[r.archetype] || null);
    const stratum = p.variant || '-';
    const why = full ? 'all full (--sample all)'
      : archetypeGated[r.archetype] === false ? `archetype ${r.archetype} not gated at this width`
        : !ccOk[p.slug] ? 'no import-time content count'
          : cmp.orderOk !== true ? `skeleton: ${cmp.reason}` : null;
    plan[p.slug] = { gateTier: why ? 'full' : 'structural', reason: why || 'sibling', stratum, archetype: r.archetype, skeleton: cmp };
    if (!why) eligible.push({ slug: p.slug, archetype: r.archetype, stratum, newTokens: cmp.newTokens });
  }
  for (const [slug, reason] of pickSample(eligible, { n: sample, seed })) plan[slug] = { ...plan[slug], gateTier: 'full', reason };
  return plan;
}
