import { describe, expect, it } from 'vitest'
import { normaliseAddress } from '@/lib/rateLimit'
import { clientKey } from '@/lib/security/ratelimit'

describe('normaliseAddress', () => {
  it('returns the dotted IPv4 for an IPv4-mapped IPv6 address', () => {
    expect(normaliseAddress('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(normaliseAddress('::FFFF:5.6.7.8')).toBe('5.6.7.8')
    expect(normaliseAddress('0:0:0:0:0:ffff:9.9.9.9')).toBe('9.9.9.9')
    expect(normaliseAddress('[::ffff:10.0.0.1]:443')).toBe('10.0.0.1')
  })

  it('keeps distinct mapped clients in distinct buckets', () => {
    expect(normaliseAddress('::ffff:1.2.3.4')).not.toBe(normaliseAddress('::ffff:5.6.7.8'))
  })

  it('leaves plain IPv4 unchanged', () => {
    expect(normaliseAddress('203.0.113.7')).toBe('203.0.113.7')
  })

  it('strips a %zone before expanding', () => {
    expect(normaliseAddress('fe80::1%eth0')).toBe(normaliseAddress('fe80::1'))
    expect(normaliseAddress('fe80::1%eth0')).toBe(normaliseAddress('fe80::2%eth1'))
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64')
  })

  it('still reduces ordinary IPv6 to its /64', () => {
    expect(normaliseAddress('2001:db8::1')).toBe('2001:0db8:0000:0000::/64')
    expect(normaliseAddress('2001:0db8::ffff')).toBe('2001:0db8:0000:0000::/64')
    expect(normaliseAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002::/64')
  })

  it('returns junk and out-of-range embedded octets unchanged', () => {
    expect(normaliseAddress('not-an-ip')).toBe('not-an-ip')
    expect(normaliseAddress('::ffff:999.1.1.1')).toBe('::ffff:999.1.1.1')
    expect(normaliseAddress('a:b:c')).toBe('a:b:c')
  })
})

describe('clientKey with mapped addresses', () => {
  it('does not collapse different IPv4-mapped clients', () => {
    const k = (ip: string) => clientKey(new Headers({ 'x-forwarded-for': ip }), 'p')
    expect(k('::ffff:1.2.3.4')).not.toBe(k('::ffff:5.6.7.8'))
  })
})
