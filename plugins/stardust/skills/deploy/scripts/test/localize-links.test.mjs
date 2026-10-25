#!/usr/bin/env node
// skills/deploy/scripts/test/localize-links.test.mjs — the redirects reader (TSV, JSON, DA sheet, JSON Lines), served URLs, and the repoint ledger (#145): reasons, relocalized targets, the changed-documents list.
// Run: node plugins/stardust/skills/deploy/scripts/test/localize-links.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localizeHref, redirectPairs, nextLedger, rosterKeys } from "../localize-links.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${e.message.split("\n").join("\n  ")}`); } };
check("TSV with comments and blank lines", () => assert.deepEqual(redirectPairs("# renames\n/a/B_c\t/a/b-c\n\n/x  /y\n", "redirects.tsv"), [["/a/B_c", "/a/b-c"], ["/x", "/y"]]));
check("JSON array and map", () => {
  assert.deepEqual(redirectPairs(JSON.stringify([{ source: "/a", destination: "/b" }, { source: "/c" }]), "r.json"), [["/a", "/b"]]);
  assert.deepEqual(redirectPairs(JSON.stringify({ "/a": "/b" }), "r.json"), [["/a", "/b"]]);
});
check("the published DA sheet shape", () => assert.deepEqual(redirectPairs(JSON.stringify({ total: 1, data: [{ Source: "/a.html", Destination: "/a" }] }), "redirects.json"), [["/a.html", "/a"]]));
check("JSON Lines: spec knowledge rows (src/target); a null target is skipped", () => assert.deepEqual(redirectPairs('{"src":"/en/a.html","target":"/en/a","kind":"migration"}\n{"src":"https://example.com/old","target":null}\n', "redirects.jsonl"), [["/en/a.html", "/en/a"]]));
check("a redirect rewrites links only to a page of the content tree", () => {
  const root = mkdtempSync(join(tmpdir(), "localize-r-")); const c = join(root, "content", "en"); mkdirSync(c, { recursive: true });
  writeFileSync(join(c, "a.html"), '<a href="https://example.com/en/old-a">a</a> <a href="https://example.com/en/old-b">b</a>');
  writeFileSync(join(root, "r.tsv"), "/en/old-a\t/en/a\n/en/old-b\t/en/b\n");
  const r = spawnSync(process.execPath, [join(HERE, "..", "localize-links.mjs"), "--source-host", "example.com", "--content", join(root, "content"), "--redirects", join(root, "r.tsv")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 redirect\(s\) to pages not in this tree/);
  assert.equal(readFileSync(join(c, "a.html"), "utf8"), '<a href="/en/a">a</a> <a href="https://example.com/en/old-b">b</a>');
  rmSync(root, { recursive: true });
});
check("hrefs get the served URL: a folder index with its slash, a leaf without; .html and stray slashes fixed", () => {
  const map = new Map([["/en/news", "/en/news/"], ["/en/news/story", "/en/news/story"]]);
  const ctx = { map, hosts: ["example.com"] };
  assert.equal(localizeHref("https://www.example.com/en/news/index.html", ctx).href, "/en/news/");
  assert.equal(localizeHref("/en/news", ctx).href, "/en/news/");
  assert.equal(localizeHref("/en/news/story/?a=1#b", ctx).href, "/en/news/story?a=1#b");
  assert.equal(localizeHref("/en/news/", ctx).action, "already");
});
check("a content tree: links to a folder index get /x/, links to a leaf lose .html and the slash", () => {
  const root = mkdtempSync(join(tmpdir(), "localize-")); const c = join(root, "content", "en", "news"); mkdirSync(c, { recursive: true });
  writeFileSync(join(c, "index.html"), '<a href="https://example.com/en/news/story.html">s</a>');
  writeFileSync(join(c, "story.html"), '<a href="/en/news">n</a> <a href="https://www.example.com/en/news/">n2</a>');
  const r = spawnSync(process.execPath, [join(HERE, "..", "localize-links.mjs"), "--source-host", "example.com", "--content", join(root, "content")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(c, "index.html"), "utf8"), '<a href="/en/news/story">s</a>');
  assert.equal(readFileSync(join(c, "story.html"), "utf8"), '<a href="/en/news/">n</a> <a href="/en/news/">n2</a>');
  rmSync(root, { recursive: true });
});
check("ledger reasons: a roster page is pending-wave, a held reason persists, a new target takes --reason", () => {
  const prev = { links: [{ page: "/a", href: "https://example.com/x", target: "/x", reason: "scope-extension" }, { page: "/a", href: "https://example.com/gone", target: "/gone", reason: "pending-wave" }] };
  const kept = [{ page: "/a", href: "https://example.com/x", target: "/x" }, { page: "/b", href: "https://example.com/y", target: "/y" }, { page: "/b", href: "https://example.com/z", target: "/z" }];
  const { ledger, relocalized } = nextLedger(prev, kept, { roster: rosterKeys({ pages: [{ path: "/Y/" }] }), reason: "capture-gap", hosts: ["example.com"], at: "t" });
  assert.deepEqual(ledger.links.map((l) => l.reason), ["scope-extension", "pending-wave", "capture-gap"]);
  assert.deepEqual(ledger.counts, { links: 3, targets: 3, byReason: { "scope-extension": 1, "pending-wave": 1, "capture-gap": 1 } });
  assert.deepEqual(relocalized, ["/gone"]);
  assert.equal(nextLedger(null, [kept[2]]).ledger.links[0].reason, "unclassified");
});
check("a wave close: the shipped target is relocalized, the ledger shrinks, only the rewritten document is listed", () => {
  const root = mkdtempSync(join(tmpdir(), "localize-w-")); const c = join(root, "content"); mkdirSync(join(c, "blog"), { recursive: true });
  writeFileSync(join(c, "a.html"), '<a href="https://example.com/blog/b">b</a> <a href="https://example.com/c">c</a>');
  writeFileSync(join(c, "z.html"), '<a href="https://example.com/c">c</a>');
  mkdirSync(join(root, "rollout", "coverage"), { recursive: true });
  writeFileSync(join(root, "rollout", "coverage", "pages.json"), JSON.stringify({ pages: [{ path: "/a" }, { path: "/blog/b" }] }));
  const run = () => spawnSync(process.execPath, [join(HERE, "..", "localize-links.mjs"), "--source-host", "example.com", "--content", c, "--ledger", join(root, "rollout", "repointed.json"), "--reason", "scope-extension", "--changed", join(root, "w.paths")], { encoding: "utf8" });
  let r = run(); assert.equal(r.status, 0, r.stderr);
  let l = JSON.parse(readFileSync(join(root, "rollout", "repointed.json"), "utf8"));
  assert.deepEqual(l.counts.byReason, { "pending-wave": 1, "scope-extension": 2 });
  assert.equal(readFileSync(join(root, "w.paths"), "utf8"), "");
  writeFileSync(join(c, "blog", "b.html"), "<p>b</p>");
  r = run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /relocalized 1 target/);
  l = JSON.parse(readFileSync(join(root, "rollout", "repointed.json"), "utf8"));
  assert.deepEqual(l.counts, { links: 2, targets: 1, byReason: { "scope-extension": 2 } });
  assert.equal(readFileSync(join(root, "w.paths"), "utf8"), "/a\n");
  assert.match(readFileSync(join(c, "a.html"), "utf8"), /href="\/blog\/b"/);
  rmSync(root, { recursive: true });
});
check("--help prints usage", () => { const r = spawnSync(process.execPath, [join(HERE, "..", "localize-links.mjs"), "--help"], { encoding: "utf8" }); assert.equal(r.status, 0); assert.match(r.stdout + r.stderr, /localize-links/); });
process.exit(failed ? 1 : 0);
