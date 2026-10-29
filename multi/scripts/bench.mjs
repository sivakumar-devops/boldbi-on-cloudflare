#!/usr/bin/env node
// Benchmark helper (read-only GETs). Usage:
//   BASE=https://<worker> ADMIN_TOKEN=... node scripts/bench.mjs public  /bi/api/health-check 50 5
//   BASE=... ADMIN_TOKEN=... node scripts/bench.mjs internal bi-web bi-api /bi/api/health-check 50
// "public": client -> Worker -> container (N requests, C concurrency), after a warm-up pass.
// "internal": runs curl inside container <from> against http://<to><path> via /_internal/diag/curl.
const [mode, ...a] = process.argv.slice(2);
const BASE = process.env.BASE, TOKEN = process.env.ADMIN_TOKEN;
if (!BASE) throw new Error("BASE is required");

const pct = (s, p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
const stats = (v) => { const s = [...v].sort((x, y) => x - y); return { n: s.length, avg: Math.round(s.reduce((x, y) => x + y, 0) / (s.length || 1)), p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99) }; };

if (mode === "public") {
  const [path, n = "50", c = "5"] = a;
  const hit = async () => { const t = performance.now(); try { const r = await fetch(BASE + path); await r.arrayBuffer(); return { ms: performance.now() - t, err: r.status >= 400 }; } catch { return { ms: performance.now() - t, err: true }; } };
  for (let i = 0; i < 3; i++) await hit(); // warm-up
  const res = []; let next = 0;
  await Promise.all(Array.from({ length: +c }, async () => { while (next++ < +n) res.push(await hit()); }));
  console.log(JSON.stringify({ mode, path, ms: stats(res.map((r) => r.ms)), errorRate: res.filter((r) => r.err).length / res.length }, null, 2));
} else if (mode === "internal") {
  const [from, to, path, n = "50"] = a;
  const q = new URLSearchParams({ from, to, path, n });
  await fetch(`${BASE}/_internal/diag/curl?${q}&n=3`, { headers: { "X-Admin-Token": TOKEN } }); // warm-up
  const r = await fetch(`${BASE}/_internal/diag/curl?${q}`, { headers: { "X-Admin-Token": TOKEN } });
  console.log(JSON.stringify(await r.json(), null, 2));
} else {
  console.error("mode must be public|internal");
  process.exit(1);
}
