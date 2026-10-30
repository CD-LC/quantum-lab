/**
 * next.config.mjs derives ONE stamp for the Next build id and the service-worker
 * cache name. An empty NEXT_PUBLIC_BUILD_STAMP (what a Docker build without the
 * build-arg exports) must count as unset, never as an empty id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const VARS = ['NEXT_PUBLIC_BUILD_STAMP', 'VERCEL_GIT_COMMIT_SHA', 'GITHUB_SHA', 'NEXT_PUBLIC_SENTRY_DSN'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
  vi.resetModules()
})

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
})

async function load(): Promise<{ id: string; stamp: string | undefined }> {
  const mod = (await import('../next.config.mjs')) as {
    default: { generateBuildId: () => string; env: { NEXT_PUBLIC_BUILD_STAMP?: string } }
  }
  return { id: mod.default.generateBuildId(), stamp: mod.default.env.NEXT_PUBLIC_BUILD_STAMP }
}

describe('next.config.mjs build stamp', () => {
  it('uses an empty NEXT_PUBLIC_BUILD_STAMP as unset and yields a non-empty id', async () => {
    process.env.NEXT_PUBLIC_BUILD_STAMP = ''
    const { id, stamp } = await load()
    expect(id).toMatch(/^[0-9]+$/)
    expect(stamp).toBe(id)
  })

  it('falls through blank values to the first real candidate', async () => {
    process.env.NEXT_PUBLIC_BUILD_STAMP = '  '
    process.env.VERCEL_GIT_COMMIT_SHA = ''
    process.env.GITHUB_SHA = 'abc123def'
    const { id, stamp } = await load()
    expect(id).toBe('abc123def')
    expect(stamp).toBe('abc123def')
  })

  it('prefers NEXT_PUBLIC_BUILD_STAMP and sanitises and truncates it', async () => {
    process.env.NEXT_PUBLIC_BUILD_STAMP = `a/b?c${'x'.repeat(60)}`
    process.env.GITHUB_SHA = 'ignored'
    const { id } = await load()
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/)
    expect(id.startsWith('abcx')).toBe(true)
  })

  it('falls back to the timestamp when a value sanitises to nothing', async () => {
    process.env.NEXT_PUBLIC_BUILD_STAMP = '///'
    const { id } = await load()
    expect(id).toMatch(/^[0-9]+$/)
  })
})
