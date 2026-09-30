#!/usr/bin/env node
/**
 * check-known-bug-markers.mjs: fail when a known-bug marker outlives its issue.
 *
 * A test that encodes a defect (an `it.fails`, a KNOWN_BUG_<n>_OPEN flag, a
 * `knownFailing` row) is supposed to be flipped in the same PR that fixes the
 * defect. When it is not, the suite goes red on master the next time anyone runs
 * it (this has happened twice). This script makes that mechanical: it scans
 * src, test and resources for markers, asks GitHub whether each referenced issue
 * is closed, and exits nonzero naming every marker whose issue is closed.
 *
 * Markers recognised (case-insensitive for the prose forms):
 *   KNOWN_BUG_<n>_OPEN
 *   known bug #<n>, known failing #<n>
 *   knownFailing: '#<n>'  (also the JSON form "knownFailing": "#<n>")
 *   it.fails('... #<n> ...')  (an issue number in the title of an it.fails)
 *
 * Issue state comes from `gh issue view` when gh works, else from the REST API
 * with GITHUB_TOKEN (or GH_TOKEN). When neither is available the check is
 * skipped with a message and exits 0, so a fresh checkout without credentials
 * is not blocked. The same logic is unit-tested in
 * src/core/__tests__/known-bug-markers.test.ts.
 *
 * Exit code: 0 = clean or skipped, 1 = at least one stale marker.
 *
 * Usage: node scripts/check-known-bug-markers.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

export const SCAN_DIRS = ['src', 'test', 'resources']
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '.md'])
const SKIP_DIRS = new Set(['node_modules', 'ngspice', '.corpus-cache', 'out', 'dist'])
const DEFAULT_REPO = 'epim/circsim'

/** Each entry: a regex with one capture group for the issue number, and a label. */
const SIMPLE_PATTERNS = [
  { re: /KNOWN_BUG_(\d+)_OPEN/g, kind: 'KNOWN_BUG_<n>_OPEN' },
  { re: /known[ _-]bug\s+#(\d+)/gi, kind: 'known bug #<n>' },
  { re: /known[ _-]failing\s+#(\d+)/gi, kind: 'known failing #<n>' },
  { re: /knownFailing["']?\s*:\s*["']#(\d+)["']/g, kind: 'knownFailing: "#<n>"' }
]
/** it.fails( <quote> title <quote>: every #<n> in the title counts. */
const IT_FAILS_RE = /it\.fails\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * Find every known-bug marker in `text`. Pure. Returns
 * [{ issue: number, line: number, kind: string, text: string }], one entry per
 * distinct (line, issue) pair.
 */
export function findMarkers(text) {
  const found = new Map()
  const add = (index, issue, kind, matched) => {
    const line = lineOf(text, index)
    const key = `${line}:${issue}`
    if (!found.has(key)) found.set(key, { issue: Number(issue), line, kind, text: matched.replace(/\s+/g, ' ').slice(0, 100) })
  }
  for (const { re, kind } of SIMPLE_PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) add(m.index, m[1], kind, m[0])
  }
  IT_FAILS_RE.lastIndex = 0
  for (let m = IT_FAILS_RE.exec(text); m; m = IT_FAILS_RE.exec(text)) {
    for (const n of m[2].matchAll(/#(\d+)/g)) add(m.index, n[1], 'it.fails title', m[0])
  }
  return [...found.values()].sort((a, b) => a.line - b.line || a.issue - b.issue)
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out)
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
}

/**
 * Scan `dirs` (relative to `root`) and return every marker with its file
 * (forward-slash path relative to root). Pure apart from reading files.
 */
export function scanMarkers(root = PROJECT_ROOT, dirs = SCAN_DIRS) {
  const files = []
  for (const d of dirs) walk(path.join(root, d), files)
  const out = []
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    for (const m of findMarkers(fs.readFileSync(file, 'utf8'))) out.push({ file: rel, ...m })
  }
  return out
}

/**
 * Resolve each distinct issue in `markers` with `getState` (async, returns
 * 'OPEN', 'CLOSED' or null for unknown) and split the markers into stale
 * (issue closed) and unknown (state could not be determined).
 */
export async function findStale(markers, getState) {
  const states = new Map()
  for (const n of new Set(markers.map((m) => m.issue))) states.set(n, await getState(n))
  return {
    stale: markers.filter((m) => states.get(m.issue) === 'CLOSED'),
    unknown: [...new Set(markers.filter((m) => states.get(m.issue) == null).map((m) => m.issue))],
    states
  }
}

function repoSlug(env) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY
  return DEFAULT_REPO
}

function ghState(n, env) {
  const args = ['issue', 'view', String(n), '--json', 'state', '-q', '.state', '--repo', repoSlug(env)]
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, env })
  if (r.error || r.status !== 0) return null
  const s = (r.stdout ?? '').trim().toUpperCase()
  return s === 'OPEN' || s === 'CLOSED' ? s : null
}

async function restState(n, env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN
  if (!token || typeof fetch !== 'function') return null
  try {
    const res = await fetch(`https://api.github.com/repos/${repoSlug(env)}/issues/${n}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    })
    if (!res.ok) return null
    const body = await res.json()
    return body.state === 'closed' ? 'CLOSED' : body.state === 'open' ? 'OPEN' : null
  } catch {
    return null
  }
}

/** Issue-state lookup: gh first, then the REST API with a token, else null. */
export function makeGitHubResolver(env = process.env) {
  return async (n) => ghState(n, env) ?? (await restState(n, env))
}

export async function main(env = process.env) {
  const markers = scanMarkers()
  if (markers.length === 0) {
    console.log('check:markers: no known-bug markers found.')
    return 0
  }
  const { stale, unknown, states } = await findStale(markers, makeGitHubResolver(env))
  if (states.size > 0 && unknown.length === states.size) {
    console.log(
      `check:markers: SKIPPED. ${markers.length} marker(s) found but issue state is unavailable ` +
        '(no working gh CLI and no GITHUB_TOKEN). Run `gh auth login` or set GITHUB_TOKEN.'
    )
    return 0
  }
  for (const n of unknown) console.warn(`check:markers: WARNING: could not read the state of #${n}; its markers were not checked.`)
  if (stale.length === 0) {
    console.log(`check:markers: OK. ${markers.length} marker(s) across ${states.size} issue(s), none closed.`)
    return 0
  }
  console.error('check:markers: FAIL. These known-bug markers reference CLOSED issues; flip them in the PR that closes the issue:')
  for (const m of stale) console.error(`  ${m.file}:${m.line}  #${m.issue} is closed  [${m.kind}]  ${m.text}`)
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code))
}
