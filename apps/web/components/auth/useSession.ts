'use client'

/**
 * useSession — auth state that is happy to have no backend.
 *
 * When Supabase is not configured this hook does no network work at all: it
 * reports `configured: false`, a null user, and sign-in/sign-out functions that
 * resolve instantly with an explanatory message.
 *
 * ONE STORE, MANY READERS. The session lives in a module-level store that every
 * `useSession()` call subscribes to via `useSyncExternalStore`. It used to be
 * per-instance state: each of the ~10 call sites ran its own `getSession()`,
 * started at `loading: true` (a "Checking your session…" / free-tier flash per
 * component), and only the FIRST instance to mount could read an auth error out
 * of the URL — so adding the hook to the nav would have silently stolen the
 * error from the sign-in panel. Now there is one read, one subscription, and
 * one answer.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isSupabaseConfigured } from '@/lib/supabase-config'
import { authErrorMessage } from './authError'

/**
 * The client, fetched on demand. This hook is in the header of every page, so
 * a static import of '@/lib/supabase' puts @supabase/supabase-js (~26 kB gzip)
 * in every route's first load — which is what it did, and what the bundle
 * budgets caught. Loaded this way it arrives after hydration, and only when
 * accounts are configured at all.
 */
function loadSupabase(): Promise<SupabaseClient | null> {
  if (!isSupabaseConfigured) return Promise.resolve(null)
  return import('@/lib/supabase').then((m) => m.getSupabase()).catch(() => null)
}

export interface SessionUser {
  id: string
  email: string | null
}

export interface UseSessionResult {
  user: SessionUser | null
  loading: boolean
  configured: boolean
  /**
   * Email a magic link (and, when the project's email template includes
   * `{{ .Token }}`, a one-time code). `next` is a same-origin path to return
   * to once signed in; anything else is ignored.
   */
  signIn: (email: string, next?: string | null) => Promise<{ error?: string }>
  /** Sign in with the one-time code from the email — works in any browser. */
  verifyCode: (email: string, code: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
  /**
   * A failure Supabase reported by REDIRECTING back to us with
   * `error`/`error_description` in the URL (expired or reused link, redirect
   * URL not on the project's allow-list, …). Before this was read, a failed
   * magic link landed the visitor on a page that looked exactly like a
   * successful one minus the sign-in — "nothing happened".
   */
  authError: string | null
  clearAuthError: () => void
}

/**
 * A path that is safe to navigate to after sign-in, or null. Only same-origin
 * absolute paths: `/foo` yes, `//evil.com` / `/\evil.com` / `https://…` no —
 * otherwise `?next=` is an open redirect riding on our sign-in email.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  if (/[\u0000-\u001f]/.test(value)) return null
  if (value === '/account' || value.startsWith('/account?') || value.startsWith('/account#')) {
    return null
  }
  return value
}

/**
 * Read (and then remove) an auth error Supabase put in the URL. Both the hash
 * (implicit flow) and the query string (PKCE) are checked; the message is
 * made human before it is shown.
 *
 * Only Supabase's shape counts — `error_description` or `error_code`. A bare
 * `?error=` on some unrelated page is that page's business, not a sign-in
 * failure, and must not be deleted from its URL.
 */
function takeAuthErrorFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const fromQuery = new URLSearchParams(window.location.search)
  const code = fromHash.get('error_code') ?? fromQuery.get('error_code')
  const description = fromHash.get('error_description') ?? fromQuery.get('error_description')
  const error = fromHash.get('error') ?? fromQuery.get('error')
  if (!description && !code) return null

  // Clean the URL so a reload does not re-announce the same failure.
  try {
    const clean = new URL(window.location.href)
    for (const k of ['error', 'error_code', 'error_description']) {
      clean.searchParams.delete(k)
    }
    clean.hash = ''
    window.history.replaceState(window.history.state, '', clean.toString())
  } catch {
    // ignore
  }

  // Never echo the URL's own words: they only select a fixed message.
  return authErrorMessage({ code, error, description })
}

const NOT_CONFIGURED_MESSAGE =
  'Accounts are not configured for this deployment — your circuits are saved in this browser.'

// ── the store ────────────────────────────────────────────────────────────────

interface SessionState {
  user: SessionUser | null
  loading: boolean
  authError: string | null
}

/** What the server renders, and what the client hydrates against. */
const INITIAL: SessionState = { user: null, loading: isSupabaseConfigured, authError: null }

let state: SessionState = INITIAL
const listeners = new Set<() => void>()
let started = false

function setState(patch: Partial<SessionState>): void {
  const next = { ...state, ...patch }
  if (
    next.user?.id === state.user?.id &&
    next.user?.email === state.user?.email &&
    next.loading === state.loading &&
    next.authError === state.authError
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

function toUser(u: { id: string; email?: string | null } | null | undefined): SessionUser | null {
  return u ? { id: u.id, email: u.email ?? null } : null
}

/**
 * Once a user is known in this browser, move any circuits saved before they
 * signed in into their account, and merge course progress with the account's.
 * Loaded lazily so the nav (which reads the session on every page) does not
 * pull the simulator into every bundle.
 */
function syncLocalData(userId: string): void {
  void import('@/lib/circuit-store')
    .then((m) => m.migrateLocalCircuits(userId))
    .catch(() => undefined)
  void import('@/lib/lessons/progressSync')
    .then((m) => m.startProgressSync(userId))
    .catch(() => undefined)
}

function stopSync(): void {
  void import('@/lib/lessons/progressSync')
    .then((m) => m.stopProgressSync())
    .catch(() => undefined)
}

/** Start the single session read + subscription. Idempotent; browser only. */
function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  if (!isSupabaseConfigured) return

  // Before the client is created: it would otherwise consume the hash.
  const urlError = takeAuthErrorFromUrl()
  if (urlError) setState({ authError: urlError })

  void loadSupabase().then((supabase) => {
    if (!supabase) {
      setState({ loading: false })
      return
    }

    supabase.auth
      .getSession()
      .then(({ data }) => {
        const user = toUser(data.session?.user)
        setState({ user, loading: false })
        if (user) syncLocalData(user.id)
      })
      .catch(() => setState({ user: null, loading: false }))

    // Lives as long as the page: the store is module-level, so is the listener.
    supabase.auth.onAuthStateChange((event, session) => {
      const user = toUser(session?.user)
      setState({ user, loading: false, ...(user ? { authError: null } : {}) })
      if (user && event === 'SIGNED_IN') syncLocalData(user.id)
      if (!user) stopSync()
    })
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): SessionState => state
const getServerSnapshot = (): SessionState => INITIAL

// ── the hook ─────────────────────────────────────────────────────────────────

export function useSession(): UseSessionResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const signIn = useCallback(
    async (email: string, next?: string | null): Promise<{ error?: string }> => {
      const supabase = await loadSupabase()
      if (!supabase) return { error: NOT_CONFIGURED_MESSAGE }
      const trimmed = email.trim()
      if (!trimmed) return { error: 'Enter an email address first.' }
      setState({ authError: null })
      // Land on /account, not the home page: that is where the signed-in
      // state, the plan and the launch trial are visible, and where `next`
      // is honoured. The origin must be on the Supabase project's redirect
      // allow-list as `<origin>/**` (see docs/OPERATIONS.md) or Supabase
      // falls back to its Site URL instead.
      let redirect: string | undefined
      if (typeof window !== 'undefined') {
        const target = new URL('/account', window.location.origin)
        const safe = safeNextPath(next)
        if (safe) target.searchParams.set('next', safe)
        redirect = target.toString()
      }
      try {
        const { error } = await supabase.auth.signInWithOtp({
          email: trimmed,
          options: { emailRedirectTo: redirect },
        })
        if (error) return { error: error.message }
        return {}
      } catch {
        return { error: 'Could not reach the auth service. Try again in a moment.' }
      }
    },
    []
  )

  const verifyCode = useCallback(async (email: string, code: string): Promise<{ error?: string }> => {
    const supabase = await loadSupabase()
    if (!supabase) return { error: NOT_CONFIGURED_MESSAGE }
    const token = code.replace(/\s+/g, '')
    if (!/^\d{6,10}$/.test(token)) return { error: 'Enter the numeric code from the email.' }
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' })
      if (error) {
        return {
          error: /expired|invalid/i.test(error.message)
            ? 'That code is wrong or has expired. Check the latest email, or send a new one.'
            : error.message,
        }
      }
      return {}
    } catch {
      return { error: 'Could not reach the auth service. Try again in a moment.' }
    }
  }, [])

  const signOut = useCallback(async (): Promise<void> => {
    const supabase = await loadSupabase()
    if (!supabase) return
    try {
      // `signOut()` reports a network/5xx failure as `{ error }` WITHOUT
      // clearing the stored session — the UI said "signed out" while every
      // request still carried the old token and a reload signed them back in.
      // Falling back to a local sign-out always removes the session here.
      const { error } = await supabase.auth.signOut()
      if (error) await supabase.auth.signOut({ scope: 'local' })
    } catch {
      try {
        await supabase.auth.signOut({ scope: 'local' })
      } catch {
        // ignore — the state below is cleared regardless
      }
    }
    setState({ user: null, loading: false })
  }, [])

  const clearAuthError = useCallback(() => setState({ authError: null }), [])

  return {
    user: snapshot.user,
    loading: snapshot.loading,
    configured: isSupabaseConfigured,
    signIn,
    verifyCode,
    signOut,
    authError: snapshot.authError,
    clearAuthError,
  }
}

export default useSession
