import { describe, expect, it } from 'vitest'
import { buildCorpus } from './corpus'
import { resolveSeeLink } from '@/lib/glossary/links'
import { GLOSSARY } from '@/lib/glossary/terms'

describe('link safety', () => {
  it('every search result href is an in-site path (no scheme, no protocol-relative)', () => {
    for (const doc of buildCorpus()) {
      expect(doc.href, doc.id).toMatch(/^\/(?!\/)[^\s\\]*$/)
      expect(doc.href.toLowerCase(), doc.id).not.toContain('javascript:')
    }
  })

  it('glossary see-links only resolve to in-site paths, and unknown ones are dropped', () => {
    expect(resolveSeeLink('javascript:alert(1)')).toBeNull()
    expect(resolveSeeLink('//evil.example/x')).toBeNull()
    expect(resolveSeeLink('https://evil.example')).toBeNull()
    for (const term of GLOSSARY) {
      for (const link of term.see.map(resolveSeeLink)) {
        if (link) expect(link.href).toMatch(/^\/(?!\/)/)
      }
    }
  })
})
