/**
 * src/cli/index.ts
 *
 * The `circsim` bin entry (issue #28). Built to out/cli/index.js by
 * `npm run build:cli`, with the shebang added by vite.cli.config.ts. All logic
 * lives in ./main so tests can drive it without a process.
 */

import { runCli } from './main'

runCli(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
  env: process.env,
  cwd: process.cwd(),
}).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`circsim: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 3
  },
)
