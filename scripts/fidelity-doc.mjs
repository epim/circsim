// Render website/docs/concepts/fidelity.md to the standalone HTML page the app opens
// from the About dialog and the fidelity banner (issue #61).
//
// The website page is the single hand-edited source. This script turns the small
// markdown subset it uses (headings, paragraphs, bullet lists, bold, italic, inline
// code, links, and VitePress tip/warning/info containers) into one self-contained
// HTML file with inline styles and no scripts. Anything outside that subset throws,
// so a future edit to the page fails the test instead of showing raw markdown.
//
//   node scripts/fidelity-doc.mjs          write docs/what-circsim-can-tell-you.html
//   node scripts/fidelity-doc.mjs --check  exit 1 when the committed file is stale

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE_PATH = 'website/docs/concepts/fidelity.md'
export const OUTPUT_PATH = 'docs/what-circsim-can-tell-you.html'
export const SITE_BASE = 'https://epim.github.io/circsim'
const PAGE_URL = `${SITE_BASE}/concepts/fidelity`

const CONTAINERS = new Set(['tip', 'warning', 'info'])

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function resolveLink(url) {
  if (/^(https?:|mailto:|#)/.test(url)) return url
  return new URL(url, PAGE_URL).toString()
}

function inline(text) {
  const codes = []
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${resolveLink(url)}">${label}</a>`)
  s = s.replace(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

function assertSupported(line, n) {
  const at = `${SOURCE_PATH}:${n}`
  if (/^\s*\|/.test(line)) throw new Error(`fidelity-doc: table at ${at} is not supported`)
  if (/^\s*```/.test(line)) throw new Error(`fidelity-doc: code fence at ${at} is not supported`)
  if (/!\[[^\]]*\]\(/.test(line)) throw new Error(`fidelity-doc: image at ${at} is not supported`)
  if (/^\s*>/.test(line)) throw new Error(`fidelity-doc: blockquote at ${at} is not supported`)
  if (/^\s*\d+[.)]\s/.test(line)) throw new Error(`fidelity-doc: ordered list at ${at} is not supported`)
  if (/^\s{2,}[-*]\s/.test(line)) throw new Error(`fidelity-doc: nested list at ${at} is not supported`)
  if (/^\s*<[a-zA-Z/!]/.test(line)) throw new Error(`fidelity-doc: raw HTML at ${at} is not supported`)
  if (/^---\s*$/.test(line)) throw new Error(`fidelity-doc: frontmatter or rule at ${at} is not supported`)
}

/** Render a list of numbered source lines to HTML blocks. */
function renderBlocks(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const { text, n } = lines[i]
    if (text.trim() === '') {
      i++
      continue
    }
    const open = /^:::\s*(\S+)\s*(.*)$/.exec(text)
    if (open) {
      const [, kind, title] = open
      if (!CONTAINERS.has(kind)) throw new Error(`fidelity-doc: container "${kind}" at ${SOURCE_PATH}:${n} is not supported`)
      const inner = []
      i++
      while (i < lines.length && lines[i].text.trim() !== ':::') inner.push(lines[i++])
      if (i >= lines.length) throw new Error(`fidelity-doc: container opened at ${SOURCE_PATH}:${n} is never closed`)
      i++
      const heading = title.trim() === '' ? '' : `<p class="box-title">${inline(title.trim())}</p>`
      out.push(`<div class="box ${kind}">${heading}${renderBlocks(inner)}</div>`)
      continue
    }
    assertSupported(text, n)
    const h = /^(#{1,6})\s+(.*)$/.exec(text)
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`)
      i++
      continue
    }
    if (/^-\s+/.test(text)) {
      const items = []
      while (i < lines.length && /^-\s+/.test(lines[i].text)) {
        let item = lines[i].text.replace(/^-\s+/, '').trim()
        i++
        while (i < lines.length && /^\s{2}\S/.test(lines[i].text)) {
          assertSupported(lines[i].text, lines[i].n)
          item += ' ' + lines[i].text.trim()
          i++
        }
        items.push(`<li>${inline(item)}</li>`)
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    const para = []
    while (
      i < lines.length &&
      lines[i].text.trim() !== '' &&
      !/^(#{1,6}\s|-\s|:::)/.test(lines[i].text)
    ) {
      assertSupported(lines[i].text, lines[i].n)
      para.push(lines[i].text.trim())
      i++
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --line: #d1d9e0; --code: #eff1f3;
  --tip: #1a7f37; --warning: #9a6700; --info: #0969da; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --bg: #0d1117; --muted: #9198a1; --line: #3d444d; --code: #1c2128;
  --tip: #3fb950; --warning: #d29922; --info: #58a6ff; --link: #58a6ff; } }
body { background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.8rem; line-height: 1.25; }
h2 { font-size: 1.35rem; margin-top: 2.2rem; padding-top: 1.2rem; border-top: 1px solid var(--line); }
h3 { font-size: 1.1rem; margin-top: 1.6rem; }
a { color: var(--link); }
code { background: var(--code); border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.9em; }
.box { border-left: 4px solid var(--line); background: var(--code); border-radius: 6px; padding: 0.2rem 1rem; margin: 1.2rem 0; }
.box.tip { border-left-color: var(--tip); }
.box.warning { border-left-color: var(--warning); }
.box.info { border-left-color: var(--info); }
.box-title { font-weight: 600; margin-bottom: 0; }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.9rem; }
`.trim()

/** Render the fidelity page markdown to a standalone HTML document. */
export function renderFidelityHtml(markdown) {
  const lines = markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((text, i) => ({ text, n: i + 1 }))
  const body = renderBlocks(lines)
  const title = /<h1>(.*?)<\/h1>/.exec(body)
  const plainTitle = title ? title[1].replace(/<[^>]+>/g, '') : 'circsim fidelity'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${plainTitle}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${body}
<footer>
<p>This page is generated from <code>${SOURCE_PATH}</code> and ships inside the app, so it opens offline. The latest version is on the <a href="${PAGE_URL}">documentation site</a>.</p>
</footer>
</main>
</body>
</html>
`
}

export function main(argv = process.argv.slice(2)) {
  const html = renderFidelityHtml(readFileSync(path.join(ROOT, SOURCE_PATH), 'utf8'))
  const target = path.join(ROOT, OUTPUT_PATH)
  if (argv.includes('--check')) {
    let current = ''
    try {
      current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      // missing counts as stale
    }
    if (current !== html) {
      console.error(`docs:fidelity: ${OUTPUT_PATH} is stale. Run \`npm run docs:fidelity\` and commit the result.`)
      return 1
    }
    console.log(`docs:fidelity: ${OUTPUT_PATH} matches ${SOURCE_PATH}.`)
    return 0
  }
  writeFileSync(target, html)
  console.log(`docs:fidelity: wrote ${OUTPUT_PATH} (${html.length} bytes) from ${SOURCE_PATH}.`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
