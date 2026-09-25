// load_chunks.mjs - one-time Layer 2 load. Node 18+, no dependencies.
// Usage (PowerShell):
//   $env:SUPABASE_ANON_KEY="<legacy anon key>"; node load_chunks.mjs chunks.jsonl
// Usage (bash):
//   SUPABASE_ANON_KEY="<legacy anon key>" node load_chunks.mjs chunks.jsonl
import { readFileSync } from "node:fs";

const FN_URL = "https://absylmqaiibsjemqecyy.supabase.co/functions/v1/layer2";
const KEY = process.env.SUPABASE_ANON_KEY;
if (!KEY) { console.error("Set SUPABASE_ANON_KEY first."); process.exit(1); }

const file = process.argv[2] ?? "chunks.jsonl";
const chunks = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const BATCH = 1; // free-tier edge functions get ~2s CPU per request: one embedding per call

async function call(body) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}, non-JSON response` }));
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let done = 0;
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  for (let attempt = 1; ; attempt++) {
    try { await call({ action: "ingest", chunks: batch }); break; }
    catch (err) {
      if (attempt >= 5) { console.error(`Batch at ${i} failed:`, err.message); process.exit(1); }
      console.warn(`Batch at ${i} retry ${attempt}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  done += batch.length;
  console.log(`Loaded ${done}/${chunks.length}`);
}

// Smoke test with a made-up edge case
const test = "Water leaking from ceiling in a leased office building off campus";
const { chunks: hits } = await call({ action: "search", query: test, k: 3 });
console.log(`\nTest query: "${test}"`);
for (const h of hits) console.log(`  ${h.similarity.toFixed(3)}  [${h.sheet}]`);
