'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import ChallengeCard from '@/components/challenge/ChallengeCard'
import { Segmented } from '@/components/ui/Controls'
import { CHALLENGES } from '@/lib/challenges/catalogue'
import { readProgress, type ProgressMap } from '@/lib/challenges/types'
import { mulberry32 } from '@/lib/quantum'

type Filter = 'All' | 'Beginner' | 'Intermediate' | 'Advanced'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'All', label: 'All' },
  { value: 'Beginner', label: 'Beginner' },
  { value: 'Intermediate', label: 'Intermediate' },
  { value: 'Advanced', label: 'Advanced' },
]

/**
 * Pick the day's challenge from the UTC date alone.
 *
 * Everyone in the world sees the same puzzle on the same calendar day, and it
 * costs zero infrastructure: no server, no database, no clock skew to reconcile.
 * The date string is hashed to a 32-bit seed and fed to the same deterministic
 * PRNG the simulator uses, so the sequence looks scattered rather than marching
 * through the catalogue in order — and it is reproducible for any date, which
 * makes it testable.
 *
 * UTC specifically: a local-date pick would hand two people in different
 * timezones different "daily" challenges, which breaks the shared-puzzle idea.
 */
function dailyIndex(date: Date, count: number): number {
  const key = date.toISOString().slice(0, 10) // YYYY-MM-DD, UTC
  let hash = 2166136261 // FNV-1a offset basis
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.floor(mulberry32(hash >>> 0)() * count) % count
}

export default function ChallengesPage() {
  const [progress, setProgress] = useState<ProgressMap>({})
  const [filter, setFilter] = useState<Filter>('All')

  // localStorage is browser-only: read after mount so the server-rendered
  // markup and the first client render match.
  useEffect(() => {
    setProgress(readProgress())
  }, [])

  // The pick depends on the clock, and this page is prerendered at build time:
  // computing it during render made the server's HTML (the build day's puzzle)
  // disagree with the browser's (today's) after the next UTC midnight, which
  // React reports as hydration error #418. Choose after mount instead, like
  // the localStorage read above; until then a neutral placeholder is rendered
  // by both sides.
  const [daily, setDaily] = useState<(typeof CHALLENGES)[number] | null>(null)
  useEffect(() => {
    setDaily(CHALLENGES[dailyIndex(new Date(), CHALLENGES.length)])
  }, [])

  const solvedCount = CHALLENGES.filter((ch) => progress[ch.id]?.solved).length
  const total = CHALLENGES.length
  const shown = CHALLENGES.filter((ch) => filter === 'All' || ch.level === filter)

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <header>
        <span className="section-label">Challenges</span>
        <h1 className="section-title mt-2">Build the circuit</h1>
        <p className="section-desc mt-3 max-w-2xl">
          Each challenge gives you a target — a state, a distribution, or a broken circuit — and
          your job is to build or repair the circuit that produces it. Grading runs entirely in
          your browser against the same simulator the rest of the site uses, so the verdict is
          exact and instant.
        </p>
      </header>

      {/* ── Progress ── */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-semibold text-ink-secondary">
            Solved {solvedCount} of {total}
          </span>
          <span className="font-mono text-xs text-ink-muted">
            {total > 0 ? Math.round((solvedCount / total) * 100) : 0}%
          </span>
        </div>
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-valuenow={solvedCount}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Challenges solved"
        >
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${total > 0 ? (solvedCount / total) * 100 : 0}%`,
              background: '#4edbca',
            }}
          />
        </div>
      </section>

      {/* ── Daily ── */}
      <section className="card mt-8 flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="min-w-[16rem] flex-1">
          {/*
            `text-q-amber-text`, not an inline hex. This carried
            style={{ color: '#fac294' }} — the DARK theme's --q-amber-text
            value, hardcoded — so on the light theme it rendered a pale peach
            on white at 1.58:1 for bold 11px text, against the 4.5:1 it needs.
            The token resolves per theme and is legible in both.
          */}
          <span className="section-label text-q-amber-text">
            Daily challenge
          </span>
          <h2 className="mt-2 text-lg font-bold text-ink">{daily ? daily.title : 'Today\u2019s puzzle'}</h2>
          <p className="mt-1.5 max-w-2xl text-[13px] text-ink-secondary">
            {daily ? daily.brief : 'Picking today\u2019s puzzle\u2026'}
          </p>
          <p className="mt-2 text-[11px] text-ink-muted">
            Picked from today&rsquo;s UTC date, so everyone gets the same puzzle today.
          </p>
        </div>
        <Link
          href={daily ? `/challenges/${daily.id}` : '/challenges'}
          aria-disabled={daily ? undefined : true}
          className="btn-primary focus-ring shrink-0"
        >
          {daily && progress[daily.id]?.solved ? 'Solve it again' : 'Take it on'}
        </Link>
      </section>

      {/* ── Filter + grid ── */}
      <section className="mt-8">
        <div className="max-w-md">
          <Segmented label="Level" value={filter} options={FILTERS} onChange={setFilter} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((ch) => (
            <ChallengeCard
              key={ch.id}
              challenge={ch}
              solved={progress[ch.id]?.solved ?? false}
              bestGates={progress[ch.id]?.bestGates}
            />
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="mt-6 text-sm text-ink-muted">No challenges at that level yet.</p>
        ) : null}
      </section>
    </div>
  )
}
