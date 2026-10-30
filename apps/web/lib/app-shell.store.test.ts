import { describe, it, expect } from 'vitest'
import { STORE_APP_ATTR, STORE_APP_SCRIPT } from './app-shell'

/** Run the inline detection script against a fake browser; report whether it marked <html>. */
function detect(opts: {
  ua?: string
  referrer?: string
  search?: string
  stored?: string | null
  displayMode?: string
}) {
  const attrs: Record<string, string> = {}
  const store: Record<string, string> = opts.stored ? { 'qubit16.storeApp': opts.stored } : {}
  const document = {
    referrer: opts.referrer ?? '',
    documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v } },
  }
  const sessionStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
  }
  const matchMedia = (q: string) => ({ matches: q === `(display-mode: ${opts.displayMode ?? 'browser'})` })
  new Function('navigator', 'document', 'location', 'sessionStorage', 'matchMedia', STORE_APP_SCRIPT)(
    { userAgent: opts.ua ?? 'Mozilla/5.0 Chrome/154.0' },
    document,
    { search: opts.search ?? '' },
    sessionStorage,
    matchMedia,
  )
  return { marked: attrs[STORE_APP_ATTR] === '1', remembered: store['qubit16.storeApp'] === '1' }
}

describe('store-app detection (purchase entry points are hidden when it fires)', () => {
  it('fires in the iOS app (user-agent token)', () => {
    expect(detect({ ua: 'Mozilla/5.0 (iPhone) AppleWebKit Qubit16App/ios' }).marked).toBe(true)
  })

  it('fires in the Android TWA (android-app:// referrer) and remembers it for the session', () => {
    expect(detect({ referrer: 'android-app://ai.qubit16.app/' })).toEqual({ marked: true, remembered: true })
  })

  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/154.0 Mobile Safari/537.36'

  it('fires on the ?app=android launch marker inside the installed Android app', () => {
    expect(detect({ search: '?app=android', ua: ANDROID_UA, displayMode: 'standalone' })).toEqual({
      marked: true,
      remembered: true,
    })
  })

  it('ignores a shared ?app=android link opened in an ordinary browser tab', () => {
    expect(detect({ search: '?app=android' })).toEqual({ marked: false, remembered: false })
    expect(detect({ search: '/pricing?app=android', ua: ANDROID_UA })).toEqual({ marked: false, remembered: false })
    expect(detect({ search: '?app=android', displayMode: 'standalone' }).marked).toBe(false) // desktop UA
  })

  it('does not honour ?app=ios on its own', () => {
    expect(detect({ search: '?app=ios', displayMode: 'standalone' }).marked).toBe(false)
  })

  it('keeps firing on later pages of the same app session', () => {
    expect(detect({ stored: '1' }).marked).toBe(true)
  })

  it('does NOT fire in an ordinary browser, or for look-alike params and referrers', () => {
    expect(detect({}).marked).toBe(false)
    expect(detect({ referrer: 'https://www.google.com/' }).marked).toBe(false)
    expect(detect({ referrer: 'android-app://com.google.android.gm/' }).marked).toBe(false)
    expect(detect({ search: '?app=androidish' }).marked).toBe(false)
  })
})
