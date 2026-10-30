import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../../infra/azure/email-cron/dispatch.sh')

/** Run dispatch.sh with a fake `curl` that writes `body` to -o's file and prints `status`. */
function run(status: string, body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-'))
  const fake = path.join(dir, 'curl')
  writeFileSync(
    fake,
    `#!/bin/sh
out=""
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
printf '%s' '${body}' > "$out"
printf '%s' '${status}'
`,
  )
  chmodSync(fake, 0o755)
  return spawnSync('sh', [SCRIPT], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, EMAIL_DISPATCH_SECRET: 's', DISPATCH_URL: 'http://x' },
    encoding: 'utf8',
  })
}

describe('infra/azure/email-cron/dispatch.sh exit status', () => {
  it('succeeds on 200 with an empty failures array', () => {
    expect(run('200', '{"ok":true,"sent":3,"failures":[]}').status).toBe(0)
  })
  it('fails on 200 when the report lists failures', () => {
    const r = run('200', '{"ok":true,"sent":1,"failures":[{"subscriptionId":"a","day":1,"reason":"x"}]}')
    expect(r.status).toBe(1)
  })
  it('fails on a non-2xx status', () => {
    expect(run('500', '{}').status).toBe(1)
  })
})
