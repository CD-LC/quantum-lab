/**
 * headers.test.ts — pins the embed frame-ancestors exception.
 *
 * The global policy predates these tests and is documented at length in
 * headers.ts itself; what is asserted here is the NEW surface added for the
 * embeddable widget (docs/EMBED.md), because it is exactly the kind of change
 * that could quietly widen: an env-driven allowlist appended to the one
 * directive that decides who may frame this app. The tests fix three facts —
 *
 *  1. unset env  = the policy is byte-for-byte what it was ('self' only),
 *  2. the allowlist reaches frame-ancestors ONLY on the embed policy and
 *     changes NO other directive,
 *  3. malformed entries are dropped (stricter), never emitted (malformed CSP).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { cspDirectives, embedFrameAncestors, securityHeaders } from '@/lib/security/headers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('embedFrameAncestors', () => {
  it('is empty when NEXT_PUBLIC_EMBED_ANCESTORS is unset or blank', () => {
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', '')
    expect(embedFrameAncestors()).toEqual([])
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', '   ')
    expect(embedFrameAncestors()).toEqual([])
  })

  it('normalises entries to origins and accepts space or comma separators', () => {
    vi.stubEnv(
      'NEXT_PUBLIC_EMBED_ANCESTORS',
      'https://vegaduta.ai/some/path, https://www.vegaduta.ai',
    )
    expect(embedFrameAncestors()).toEqual(['https://vegaduta.ai', 'https://www.vegaduta.ai'])
  })

  it('drops malformed entries instead of emitting them', () => {
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', 'not-a-url https://vegaduta.ai *')
    expect(embedFrameAncestors()).toEqual(['https://vegaduta.ai'])
  })

  it('drops non-web schemes whose origin is the opaque "null"', () => {
    vi.stubEnv(
      'NEXT_PUBLIC_EMBED_ANCESTORS',
      'javascript:alert(1) data:text/html,x ftp://example.com https://vegaduta.ai',
    )
    expect(embedFrameAncestors()).toEqual(['https://vegaduta.ai'])
  })
})

describe('cspDirectives embed option', () => {
  it("keeps frame-ancestors at 'self' everywhere when the allowlist is unset", () => {
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', '')
    expect(cspDirectives()['frame-ancestors']).toEqual(["'self'"])
    expect(cspDirectives({ embed: true })['frame-ancestors']).toEqual(["'self'"])
  })

  it('appends the allowlist on the embed policy and ONLY on the embed policy', () => {
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', 'https://vegaduta.ai')
    expect(cspDirectives()['frame-ancestors']).toEqual(["'self'"])
    expect(cspDirectives({ embed: true })['frame-ancestors']).toEqual([
      "'self'",
      'https://vegaduta.ai',
    ])
  })

  it('changes no directive other than frame-ancestors', () => {
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', 'https://vegaduta.ai')
    const base = cspDirectives()
    const embed = cspDirectives({ embed: true })
    expect(Object.keys(embed)).toEqual(Object.keys(base))
    for (const name of Object.keys(base)) {
      if (name === 'frame-ancestors') continue
      expect(embed[name]).toEqual(base[name])
    }
  })
})

describe('securityHeaders embed option', () => {
  it('leaves X-Frame-Options at SAMEORIGIN even for the embed policy', () => {
    // Deliberate: vercel.json re-applies SAMEORIGIN after middleware and the
    // two must not diverge (see headers.ts). Modern browsers ignore XFO when
    // frame-ancestors is present, which is what makes this safe AND correct.
    vi.stubEnv('NEXT_PUBLIC_EMBED_ANCESTORS', 'https://vegaduta.ai')
    const headers = securityHeaders({ embed: true })
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN')
    expect(headers['Content-Security-Policy']).toContain(
      "frame-ancestors 'self' https://vegaduta.ai",
    )
  })
})

/**
 * The on-device tutor's CSP is CONDITIONAL, and both halves matter.
 *
 * Off (the default) the policy must be exactly what it was before the feature
 * existed — a security control that quietly loosens for deployments that never
 * asked for it is a regression. On, three things must hold or WebLLM fails
 * with a console violation and no user-visible error: the weight host, its CDN
 * (huggingface.co redirects there, and CSP re-checks the post-redirect URL),
 * and wasm-unsafe-eval for the WebGPU module compile.
 *
 * isDeviceTutorEnabled is read once at module load, so these assert the
 * DEFAULT (unset) build — which is the half that protects every existing
 * deployment, and the half a careless edit would break.
 */
describe('on-device tutor CSP', () => {
  it('adds no model-host origins when the flag is unset', () => {
    const connect = cspDirectives()['connect-src'] ?? []
    expect(connect).not.toContain('https://huggingface.co')
    expect(connect).not.toContain('https://*.hf.co')
    expect(connect).not.toContain('https://raw.githubusercontent.com')
  })

  it('does not add wasm-unsafe-eval when the flag is unset', () => {
    expect(cspDirectives()['script-src'] ?? []).not.toContain("'wasm-unsafe-eval'")
  })

  it("never grants the broad 'unsafe-eval' outside development", () => {
    // wasm-unsafe-eval permits WebAssembly compilation and nothing else; the
    // broad token would re-open eval() and Function() and must stay out.
    if (process.env.NODE_ENV !== 'development') {
      expect(cspDirectives()['script-src'] ?? []).not.toContain("'unsafe-eval'")
    }
  })
})
