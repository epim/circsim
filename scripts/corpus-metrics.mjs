#!/usr/bin/env node
/**
 * corpus-metrics.mjs - merge the per-board metrics the corpus suite writes and
 * report drift against the committed baseline.
 *
 * The corpus suite (npm run test:corpus) writes one JSON file per board into
 * test-results/corpus/metrics/. This script merges them into
 * test-results/corpus/metrics.json (the CI artifact) and prints every
 * deterministic figure that differs from test/corpus/baseline.json: parts,
 * resolved percent per tier, islands, outline warnings, deck size, op supply
 * voltage. Timings are recorded but never compared.
 *
 * Drift is a review item, not a failure: a change that improves resolution or
 * moves a tier should show up in the PR as a baseline diff a reviewer can read.
 *
 * Usage:
 *   node scripts/corpus-metrics.mjs             merge, print drift, exit 0
 *   node scripts/corpus-metrics.mjs --check     exit 1 when any drift is found
 *   node scripts/corpus-metrics.mjs --update    rewrite test/corpus/baseline.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const METRICS_DIR = path.join(ROOT, 'test-results', 'corpus', 'metrics')
const MERGED = path.join(ROOT, 'test-results', 'corpus', 'metrics.json')
const BASELINE = path.join(ROOT, 'test', 'corpus', 'baseline.json')

/** Fields compared against the baseline (everything else is timing or noise). */
const STABLE_FIELDS = [
  'footprints',
  'footprintsBackSide',
  'footprintsRotated',
  'nets',
  'tracks',
  'vias',
  'zones',
  'tiers',
  'stubbedPct',
  'islands',
  'deckLines',
  'outlineWarnings',
  'supplyNode',
  'supplyVolts'
]

function round2(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v
}

function loadMetrics() {
  if (!fs.existsSync(METRICS_DIR)) return {}
  const boards = {}
  for (const f of fs.readdirSync(METRICS_DIR).sort()) {
    if (!f.endsWith('.json')) continue
    const data = JSON.parse(fs.readFileSync(path.join(METRICS_DIR, f), 'utf8'))
    if (f.endsWith('.op.json')) {
      const id = f.slice(0, -'.op.json'.length)
      boards[id] = { ...(boards[id] ?? {}), opMs: data.opMs, supplyNode: data.supplyNode, supplyVolts: round2(data.supplyVolts) }
    } else {
      const id = f.slice(0, -'.json'.length)
      boards[id] = { ...(boards[id] ?? {}), ...data }
    }
  }
  return boards
}

function stable(rec) {
  const out = {}
  for (const k of STABLE_FIELDS) if (k in rec) out[k] = rec[k]
  return out
}

const args = process.argv.slice(2)
const boards = loadMetrics()
if (Object.keys(boards).length === 0) {
  console.error('[corpus-metrics] no metrics found in test-results/corpus/metrics (run npm run test:corpus first)')
  process.exit(args.includes('--check') ? 1 : 0)
}

fs.mkdirSync(path.dirname(MERGED), { recursive: true })
fs.writeFileSync(MERGED, JSON.stringify({ boards }, null, 2) + '\n')

if (args.includes('--update')) {
  const baseline = {}
  for (const [id, rec] of Object.entries(boards)) baseline[id] = stable(rec)
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`[corpus-metrics] baseline updated: ${Object.keys(baseline).length} boards`)
  process.exit(0)
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {}
const drift = []
for (const [id, rec] of Object.entries(boards)) {
  const now = stable(rec)
  const was = baseline[id]
  if (!was) {
    drift.push(`${id}: not in baseline`)
    continue
  }
  for (const k of STABLE_FIELDS) {
    if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) {
      drift.push(`${id}: ${k} ${JSON.stringify(was[k])} -> ${JSON.stringify(now[k])}`)
    }
  }
}
for (const id of Object.keys(baseline)) {
  if (!(id in boards)) drift.push(`${id}: in baseline but no metrics this run`)
}

console.log(`[corpus-metrics] ${Object.keys(boards).length} boards merged into test-results/corpus/metrics.json`)
if (drift.length === 0) {
  console.log('[corpus-metrics] no drift against test/corpus/baseline.json')
} else {
  console.log(`[corpus-metrics] DRIFT against test/corpus/baseline.json (${drift.length} figures); review, then run with --update if intended:`)
  for (const d of drift) console.log(`  ${d}`)
  if (args.includes('--check')) process.exit(1)
}
