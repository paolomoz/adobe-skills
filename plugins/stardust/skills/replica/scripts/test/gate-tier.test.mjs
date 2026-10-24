#!/usr/bin/env node
// skills/replica/scripts/test/gate-tier.test.mjs — gate-tier.mjs (#141), pure, no browser: the archetype of a sibling
// from _meta.json, a variance probe JSON or the state template group (variant first); the delivered document's block
// skeleton (sections, collapsed repeats, sorted variants, metadata skipped); the skeleton fit (omission ok, a new
// block / variant is a token to cover, another order does not fit); the seeded sample (the fewest siblings covering
// every new token, one per variant, n more, the same seed the same pick); the content-count evidence; the plan.
// Run: node <this file>.
import assert from 'node:assert/strict';
import { compareSkeleton, contentCountOk, hash32, indexImportCheck, parseSkeleton, pickSample, planTiers, resolveRoles } from '../gate-tier.mjs';

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); } };
const page = (slug, template, variant, proto = false) => ({ slug, url: `https://www.example.com/${slug.replace(/-/g, '/')}`, template, variant, prototypePath: proto ? `p/${slug}.html` : null });

const pages = [
  page('post-a', '/post', '/post#1', true), page('post-b', '/post', '/post#1'), page('post-c', '/post', '/post#2'),
  page('cmp-a', '/cmp', '/cmp#1', true), page('cmp-z', '/cmp', '/cmp#2', true), page('cmp-b', '/cmp', '/cmp#2'),
  page('about', '/about', '/about#1', true), page('terms', '/terms', '/terms#1'), page('privacy', '/privacy', '/privacy#1', true),
];

check('resolveRoles: template group (variant first), variance JSON, _meta.json, unique', () => {
  const r = resolveRoles(pages, { metas: { 'post-c': { fidelityTier: 'sibling', archetypeSource: 'post-a' } }, variance: [{ archetype: 'https://www.example.com/privacy/', siblings: [{ url: 'https://www.example.com/terms' }] }] });
  assert.deepEqual([r['post-b'].role, r['post-b'].archetype, r['post-b'].why], ['sibling', 'post-a', 'template /post']);
  assert.equal(r['post-c'].why, '_meta.json');
  assert.equal(r['cmp-b'].archetype, 'cmp-z', 'the archetype of the same variant');
  assert.deepEqual([r.terms.role, r.terms.archetype, r.terms.why], ['sibling', 'privacy', 'variance probe']);
  assert.equal(r['post-a'].role, 'archetype'); assert.equal(r.privacy.role, 'archetype');
  assert.equal(r.about.role, 'unique'); assert.equal(r['cmp-a'].role, 'unique', 'an archetype nobody points at reads unique');
  assert.equal(resolveRoles([page('lone', '/lone', '/lone#1')]).lone.why, 'no archetype');
});

const doc = (...secs) => secs.map((blocks) => `<div>${blocks.map((b) => (b ? `<div class="${b}"><div><div><p>x</p></div></div></div>` : '<p>text</p>')).join('')}</div>`).join('\n');
check('parseSkeleton: sections, blocks in order, variants sorted, repeats collapsed, metadata skipped, nested divs ignored', () => {
  const s = parseSkeleton(doc(['hero dark', null], ['cards', 'cards', 'columns wide center'], ['section-metadata', 'metadata']));
  assert.equal(s.sections, 3);
  assert.deepEqual(s.tokens, ['hero(dark)', 'cards', 'columns(center,wide)', 'section-metadata']);
  assert.deepEqual(parseSkeleton('').tokens, []);
});
check('compareSkeleton: omissions fit; a new block / variant is a token to cover; another order of the archetype\'s blocks does not fit', () => {
  const arch = parseSkeleton(doc(['hero'], ['cards', 'accordion'], ['related']));
  assert.deepEqual(compareSkeleton(parseSkeleton(doc(['hero'], ['cards'], ['related'])), arch), { ok: true, newTokens: [], orderOk: true, missing: ['accordion'], reason: null });
  const v = compareSkeleton(parseSkeleton(doc(['hero dark'], ['cards', 'widget'])), arch);
  assert.deepEqual([v.ok, v.orderOk, v.newTokens], [false, true, ['hero(dark)', 'widget']]); assert.match(v.reason, /new block\/variant hero\(dark\), widget/);
  const o = compareSkeleton(parseSkeleton(doc(['cards'], ['hero'])), arch);
  assert.equal(o.orderOk, false); assert.match(o.reason, /block order cards > hero/);
  assert.equal(compareSkeleton(null, arch).ok, null);
});
check('pickSample: the fewest siblings covering every new token, one per variant, n more; deterministic per seed', () => {
  const sibs = Array.from({ length: 10 }, (_, i) => ({ slug: `s${i}`, archetype: 'a', stratum: i === 7 ? '#2' : '#1', newTokens: i === 3 ? ['x', 'y'] : i === 4 ? ['y'] : i === 5 ? ['z'] : [] }));
  const p1 = pickSample(sibs, { n: 2, seed: '1440' });
  assert.equal(p1.get('s3'), 'sample: covers x, y'); assert.equal(p1.get('s5'), 'sample: covers z'); assert.equal(p1.has('s4'), false, 'y is covered by s3');
  assert.equal(p1.get('s7'), 'sample: variant #2');
  assert.equal([...p1.values()].filter((v) => v === 'sample: random').length, 2);
  assert.equal(p1.size, 5);
  assert.deepEqual([...pickSample(sibs, { n: 2, seed: '1440' })], [...p1]);
  assert.equal(pickSample(sibs.slice(0, 2), { n: 5 }).size, 2, 'a small group is all sampled');
  assert.equal(hash32('x'), hash32('x'));
});
check('contentCountOk: _meta.json gatesPassed or an ok import-run row without missing items', () => {
  const importCheck = indexImportCheck([[{ slug: 'a', ok: true, missing: [] }, { slug: 'b', ok: false }], [{ slug: 'c', ok: true, missing: [{ kind: 'heading' }] }]]);
  assert.equal(contentCountOk('a', { importCheck }), true); assert.equal(contentCountOk('b', { importCheck }), false);
  assert.equal(contentCountOk('c', { importCheck }), false); assert.equal(contentCountOk('d', { metas: { d: { gatesPassed: ['content-count'] } } }), true);
});
check('planTiers: structural only with a gated archetype, a content count and the archetype\'s order; new tokens are covered by the sample', () => {
  const ps = [page('a', '/t', '/t#1', true), ...Array.from({ length: 7 }, (_, i) => page(`s${i}`, '/t', '/t#1'))];
  const roles = resolveRoles(ps);
  const sk = parseSkeleton(doc(['hero'], ['cards']));
  const skeletons = Object.fromEntries(ps.map((p) => [p.slug, sk])); skeletons.s5 = parseSkeleton(doc(['hero dark'], ['cards'])); skeletons.s6 = parseSkeleton(doc(['cards'], ['hero']));
  const ccOk = Object.fromEntries(ps.map((p) => [p.slug, p.slug !== 's4']));
  const plan = planTiers(ps, { roles, skeletons, archetypeGated: { a: true }, ccOk, sample: 1, seed: 'x' });
  assert.equal(plan.a.gateTier, 'full'); assert.equal(plan.a.reason, 'archetype');
  assert.match(plan.s4.reason, /no import-time content count/); assert.match(plan.s6.reason, /skeleton: block order/);
  assert.equal(plan.s5.reason, 'sample: covers hero(dark)');
  const structural = ps.filter((p) => plan[p.slug].gateTier === 'structural');
  assert.equal(ps.filter((p) => plan[p.slug].reason === 'sample: random').length, 1); assert.equal(structural.length, 3);
  assert.ok(structural.every((p) => plan[p.slug].archetype === 'a' && plan[p.slug].stratum === '/t#1'));
  const notGated = planTiers(ps, { roles, skeletons, archetypeGated: { a: false }, ccOk, sample: 1 });
  assert.ok(ps.slice(1).every((p) => notGated[p.slug].gateTier === 'full' && /not gated|content count|skeleton/.test(notGated[p.slug].reason)));
  assert.ok(Object.values(planTiers(ps, { roles, skeletons, ccOk, full: true })).every((x) => x.gateTier === 'full'));
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
