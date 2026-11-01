/**
 * infraHardening.test.ts — pins the build/deploy/service-worker hardening that
 * lives outside the app's TypeScript: the web image's Node version and release
 * identifier, the deploy planner, poweredByHeader, and the service worker's
 * refusal to cache entitlement-gated content.
 *
 * The deploy planner is tested by running the real script from deploy.yml
 * against a throwaway git repository with a stub `az`. Docker and Azure
 * themselves are not exercised.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

describe('web image', () => {
  const dockerfile = read('apps/web/Dockerfile')

  it('runs on Node 22 LTS in every stage', () => {
    const froms = dockerfile.match(/^FROM node:[^\s]+ AS \w+$/gm) ?? []
    expect(froms).toHaveLength(3)
    for (const f of froms) expect(f).toContain('node:22-alpine')
    expect(dockerfile).not.toMatch(/node:(18|20)/)
  })

  it('declares the release build args that deploy.yml passes', () => {
    for (const name of ['NEXT_PUBLIC_SENTRY_RELEASE', 'NEXT_PUBLIC_BUILD_STAMP']) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${name}=""$`, 'm'))
      expect(dockerfile).toContain(`${name}=$${name}`)
    }
    const deploy = read('.github/workflows/deploy.yml')
    expect(deploy).toContain('NEXT_PUBLIC_SENTRY_RELEASE=$SHA')
    expect(deploy).toContain('NEXT_PUBLIC_BUILD_STAMP=${SHA::12}')
  })

  it('declares an ARG for every NEXT_PUBLIC build arg the workflow passes', () => {
    const deploy = read('.github/workflows/deploy.yml')
    const passed = [...deploy.matchAll(/--build-arg "(NEXT_PUBLIC_\w+)=/g)].map((m) => m[1])
    expect(passed.length).toBeGreaterThan(5)
    for (const name of passed) expect(dockerfile).toMatch(new RegExp(`^ARG ${name}=`, 'm'))
  })
})

describe('CI', () => {
  it('uses Node 22 everywhere', () => {
    for (const f of ['ci.yml', 'pages.yml']) {
      const text = read(`.github/workflows/${f}`)
      expect(text).not.toMatch(/node-version: '(18|20)'/)
      expect(text).toMatch(/node-version: '22'/)
    }
  })

  it('gives ios.yml a least-privilege permissions block', () => {
    expect(read('.github/workflows/ios.yml')).toMatch(/^permissions:\n {2}contents: read$/m)
  })
})

describe('next.config.mjs', () => {
  it('turns the x-powered-by header off', () => {
    expect(read('apps/web/next.config.mjs')).toMatch(/poweredByHeader:\s*false/)
  })
})

describe('deploy.yml planner', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function planScript(): string {
    const yml = read('.github/workflows/deploy.yml')
    const start = yml.indexOf('      - name: Decide what to deploy')
    const runAt = yml.indexOf('        run: |\n', start)
    const end = yml.indexOf('\n      - name:', runAt)
    return yml
      .slice(runAt + '        run: |\n'.length, end)
      .split('\n')
      .map((l) => l.replace(/^ {10}/, ''))
      .join('\n')
  }

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim()

  /** Make a repo whose commits touch the given files; returns the SHAs. */
  function repo(commits: string[][]): { dir: string; shas: string[] } {
    const dir = mkdtempSync(path.join(tmpdir(), 'plan-'))
    dirs.push(dir)
    git(dir, 'init', '-q')
    const shas: string[] = []
    commits.forEach((files, i) => {
      for (const f of files) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
        writeFileSync(path.join(dir, f), `${i}`)
      }
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', `c${i}`)
      shas.push(git(dir, 'rev-parse', 'HEAD'))
    })
    return { dir, shas }
  }

  /** `live` maps service -> image tag string ('' = az fails). */
  function plan(dir: string, head: string, live: Record<string, string>, requested = ''): string {
    const bin = path.join(dir, '.stubbin')
    mkdirSync(bin)
    const az = path.join(bin, 'az')
    writeFileSync(
      az,
      `#!/bin/bash
case "$*" in
${Object.entries(live)
  .map(([svc, image]) =>
    image === ''
      ? `  *"quantum-lab-${svc} "*) exit 1 ;;`
      : `  *"quantum-lab-${svc} "*) echo "${image}" ;;`
  )
  .join('\n')}
esac
`
    )
    chmodSync(az, 0o755)
    const out = path.join(dir, '.out')
    writeFileSync(out, '')
    const script = path.join(dir, '.plan.sh')
    writeFileSync(script, planScript())
    const res = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        HEAD_SHA: head,
        REQUESTED: requested,
        RESOURCE_GROUP: 'rg',
      },
    })
    expect(res.status, res.stderr + res.stdout).toBe(0)
    const line = readFileSync(out, 'utf8').split('\n').find((l) => l.startsWith('services='))
    return (line ?? '').slice('services='.length)
  }

  const img = (sha: string) => `reg.azurecr.io/quantum-lab/x:gh-${sha.slice(0, 12)}`

  it('sees changes from EARLIER commits of a multi-commit push', () => {
    // c0 live; c1 touches web, c2 touches only docs. HEAD~1..HEAD would see nothing.
    const { dir, shas } = repo([['README.md'], ['apps/web/a.ts'], ['docs/x.md']])
    const live = { web: img(shas[0]), api: img(shas[0]), agent: img(shas[0]) }
    expect(plan(dir, shas[2], live)).toBe('web')
  })

  it('picks each service by its own live commit', () => {
    const { dir, shas } = repo([['README.md'], ['services/api/a.py'], ['services/agent/b.py']])
    // api already has c1; agent and web are at c0.
    const live = { web: img(shas[0]), api: img(shas[1]), agent: img(shas[0]) }
    expect(plan(dir, shas[2], live)).toBe('agent')
  })

  it('deploys nothing when the live commit is HEAD', () => {
    const { dir, shas } = repo([['apps/web/a.ts']])
    const live = { web: img(shas[0]), api: img(shas[0]), agent: img(shas[0]) }
    expect(plan(dir, shas[0], live)).toBe('')
  })

  it('does not roll a service back to an older commit', () => {
    const { dir, shas } = repo([['apps/web/a.ts'], ['apps/web/b.ts']])
    const live = { web: img(shas[1]), api: img(shas[1]), agent: img(shas[1]) }
    expect(plan(dir, shas[0], live)).toBe('')
  })

  it('falls back to deploying a service whose live commit cannot be established', () => {
    const { dir, shas } = repo([['README.md'], ['docs/x.md']])
    const live = {
      web: '', // az fails
      api: 'reg.azurecr.io/quantum-lab/api:20261010120000', // timestamp tag from deploy.sh
      agent: img('f'.repeat(40)), // commit not in this clone
    }
    expect(plan(dir, shas[1], live)).toBe('web api agent')
  })

  it('honours an explicit request without consulting Azure', () => {
    const { dir, shas } = repo([['README.md']])
    expect(plan(dir, shas[0], {}, 'api web')).toBe('api web')
  })
})

describe('public/sw.js', () => {
  type Listener = (event: unknown) => void

  function load() {
    const listeners: Record<string, Listener> = {}
    const fetched: string[] = []
    const cachePuts: string[] = []
    const cache = {
      match: async () => undefined,
      put: async (req: { url: string }) => {
        cachePuts.push(req.url)
      },
      addAll: async () => {},
    }
    const self = {
      location: new URL('https://qubit16.ai/sw.js?v=test'),
      addEventListener: (name: string, fn: Listener) => {
        listeners[name] = fn
      },
      clients: { claim: async () => {} },
      skipWaiting: () => {},
    }
    const sandbox: Record<string, unknown> = {
      self,
      URL,
      Response,
      AbortController,
      setTimeout,
      clearTimeout,
      Promise,
      caches: { open: async () => cache, keys: async () => [], delete: async () => true },
      fetch: async (req: { url: string }) => {
        fetched.push(req.url)
        // A real same-origin fetch() yields type 'basic'; `new Response` does not.
        const res = new Response('paid', { status: 200 })
        Object.defineProperty(res, 'type', { value: 'basic' })
        return res
      },
    }
    vm.runInNewContext(read('apps/web/public/sw.js'), sandbox)
    /** Dispatch a GET fetch event; returns whether the worker took it over. */
    const dispatch = async (pathname: string, mode = 'cors') => {
      let responded: Promise<Response> | undefined
      const request = { method: 'GET', url: `https://qubit16.ai${pathname}`, mode }
      listeners.fetch({
        request,
        respondWith: (p: Promise<Response>) => {
          responded = p
        },
      })
      if (responded) await responded
      // let any fire-and-forget cache.put settle
      await new Promise((r) => setTimeout(r, 0))
      return Boolean(responded)
    }
    return { dispatch, cachePuts, fetched }
  }

  it.each([
    '/learn/intro-to-qubits/content',
    '/learn/intro-to-qubits/content/',
    '/api/health',
    '/api/learn/anything',
  ])('never stores %s in Cache Storage', async (pathname) => {
    const sw = load()
    await sw.dispatch(pathname)
    expect(sw.fetched).toContain(`https://qubit16.ai${pathname}`)
    expect(sw.cachePuts).toEqual([])
  })

  it('still caches ordinary same-origin assets (control)', async () => {
    const sw = load()
    await sw.dispatch('/icons/icon.svg')
    expect(sw.cachePuts).toEqual(['https://qubit16.ai/icons/icon.svg'])
  })

  it('does not treat the lesson page itself as the gated path', async () => {
    const sw = load()
    await sw.dispatch('/learn/intro-to-qubits/content-notes.png')
    expect(sw.cachePuts).toHaveLength(1)
  })
})
