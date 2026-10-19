import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

test('rebuilds the reviewed vendor archives byte-for-byte even when Git requests CRLF output', () => {
  const result = spawnSync(process.execPath, ['scripts/release/verify-vendor-patches.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'core.eol',
      GIT_CONFIG_VALUE_1: 'crlf',
    },
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('prime-agent-0.7.0-gooeypi.2.tgz: content verified;')
  expect(result.stdout).toContain('prime-agent-ai-0.7.0-gooeypi.1.tgz: content verified;')
}, 30_000)
