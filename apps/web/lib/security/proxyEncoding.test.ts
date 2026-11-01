/**
 * proxy.ts — a pathname with malformed percent-encoding is answered 404 by the
 * proxy itself, carrying the same security headers as every other response,
 * instead of reaching Next's param decoder (which answers a bare 500).
 */
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { hasMalformedEncoding, proxy } from '@/proxy'
import { securityHeaders } from '@/lib/security/headers'

function run(path: string) {
  return proxy(new NextRequest(`http://localhost${path}`))
}

describe('hasMalformedEncoding', () => {
  it.each(['/verify/%E0%A4%A', '/runs/%', '/learn/%E0', '/glossary/ok/%zz', '/api/exams/verify/%E0%A4%A'])(
    'flags %s',
    (p) => expect(hasMalformedEncoding(p)).toBe(true)
  )
  it.each(['/', '/learn/intro', '/verify/%E0%A4%A4', '/a%20b', '/x/%2F', '/api/certificates/%25E0/badge'])(
    'accepts %s',
    (p) => expect(hasMalformedEncoding(p)).toBe(false)
  )
})

describe('proxy with malformed percent-encoding', () => {
  it.each(['/verify/%E0%A4%A', '/runs/%E0%A4%A', '/learn/%E0%A4%A', '/certify/%E0%A4%A', '/glossary/%E0%A4%A', '/api/exams/verify/%E0%A4%A'])(
    '%s is a 404 with the security headers',
    (p) => {
      const res = run(p)
      expect(res.status).toBe(404)
      for (const [name, value] of Object.entries(securityHeaders({ isSecure: false, embed: false }))) {
        expect(res.headers.get(name), name).toBe(value)
      }
    }
  )

  it('applies the same headers as a normal response on a secure origin', () => {
    const req = () =>
      new NextRequest('http://localhost/learn/%E0%A4%A', { headers: { 'x-forwarded-proto': 'https' } })
    const res = proxy(req())
    expect(res.status).toBe(404)
    for (const [name, value] of Object.entries(securityHeaders({ isSecure: true, embed: false }))) {
      expect(res.headers.get(name), name).toBe(value)
    }
  })

  it('passes a well-formed encoded path through with headers', () => {
    const res = run('/verify/%E0%A4%A4')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('content-security-policy')).toBeTruthy()
  })
})
