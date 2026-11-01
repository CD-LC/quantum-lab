'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import DeviceTutorPanel from '@/components/tutor/DeviceTutorPanel'
import { type DeviceEngine, streamDeviceReply } from '@/lib/llm/webllm'
import { isDeviceTutorEnabled } from '@/lib/security/headers'
import { authFetch } from '@/lib/authFetch'
import { track } from '@/lib/analytics/track'
import { buildSessionPlan, type SessionPlan } from '@/lib/coach/sessionPlan'
import { listAttempts } from '@/lib/exams/attempts'
import { loadProgress } from '@/lib/lessons/progress'
import MessageBubble from './MessageBubble'
import { SignInLink } from '@/components/auth/SignInLink'

export type TutorLevel = 'beginner' | 'intermediate' | 'advanced'

type TutorSource = 'agent' | 'direct' | 'offline' | 'device'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  offline?: boolean
  toolsUsed?: string[]
  source?: TutorSource
}

export interface ChatPanelProps {
  circuitQasm?: string
  initialInput?: string
  level?: TutorLevel
  className?: string
}

/** Shape of the JSON returned by /api/agent. */
interface AgentResponse {
  reply?: string
  offline?: boolean
  error?: boolean | string
  toolsUsed?: string[]
  source?: TutorSource
}

/** Shape of the JSON returned by GET /api/agent — which tier is live right now. */
interface AgentStatus {
  agent?: boolean
  direct?: boolean
  source?: TutorSource
  /** Set by the server from the caller's verified tier — see lib/llm/resolve.ts. */
  tier?: 'anonymous' | 'free' | 'trial' | 'paid'
  access?: 'live' | 'offline' | 'off'
  provider?: string | null
  messagesPerDay?: number | null
}

/** One short clause after the status copy: which model, and today's allowance. */
function tierDetail(info: AgentStatus | null): string {
  if (!info || info.access !== 'live') return ''
  const parts: string[] = []
  if (info.provider) parts.push(`via ${info.provider}`)
  if (typeof info.messagesPerDay === 'number') {
    parts.push(
      info.tier === 'anonymous'
        ? `${info.messagesPerDay} messages a day signed out`
        : `${info.messagesPerDay} messages a day on your plan`,
    )
  }
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

const STATUS_COPY: Record<TutorSource, string> = {
  agent: 'Full tutor — can run circuits to check its answers',
  direct: 'Direct model — no circuit execution',
  offline: 'Offline answers — core topics only',
  // Says "on this device" rather than naming the model: the point the learner
  // cares about is where the question went, not which weights answered it.
  device: 'On this device — private, no message limit, smaller model',
}

/**
 * PRIVACY (roadmap A4): whether the tutor gets the learner's skill map.
 *
 * The plan itself is computed HERE, in the browser, from localStorage — the
 * server never sees raw progress, only the compact derived plan (see
 * lib/coach/sessionPlan.ts), and only while this switch is on. It defaults ON
 * because a tutor that knows where you are wobbly teaches better, and the
 * disclosure line next to the switch says exactly what is shared; turning it
 * off is one tap and remembered.
 */
const SHARE_PLAN_KEY = 'quantum-lab.tutor.share-plan'

function loadSharePlan(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(SHARE_PLAN_KEY) !== '0'
  } catch {
    return true
  }
}

function saveSharePlan(on: boolean): void {
  try {
    // Stored only when OFF-by-choice matters; '1' keeps the intent explicit.
    window.localStorage.setItem(SHARE_PLAN_KEY, on ? '1' : '0')
  } catch {
    // Private browsing or full storage — the in-memory choice still holds
    // for this session.
  }
}

/** The plan for THIS moment, or undefined if anything about reading it fails. */
function currentPlan(): SessionPlan | undefined {
  try {
    return buildSessionPlan(loadProgress(), listAttempts())
  } catch {
    return undefined
  }
}

const SUGGESTIONS = [
  "Explain superposition like I'm new to this",
  'What makes a Bell state special?',
  'Why does measuring destroy interference?',
  "Walk me through Grover's algorithm",
]

export default function ChatPanel({ circuitQasm, initialInput, level, className }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // Seeded once from the prop; the page remounts the panel (via key) to change it.
  const [input, setInput] = useState<string>(initialInput ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<TutorSource | null>(null)
  const [statusInfo, setStatusInfo] = useState<AgentStatus | null>(null)
  // Starts true (the default) and reads the stored choice AFTER mount, like
  // every other localStorage read in the app — reading it during render would
  // make server and client markup disagree.
  const [sharePlan, setSharePlan] = useState(true)
  /**
   * Set once the learner has downloaded a model and switched the on-device
   * tutor on. While it is non-null every send() is answered locally and the
   * network is not touched at all — see the branch at the top of send().
   */
  const deviceEngineRef = useRef<DeviceEngine | null>(null)
  const [deviceOn, setDeviceOn] = useState(false)
  const handleDeviceReady = useCallback((engine: DeviceEngine | null) => {
    deviceEngineRef.current = engine
    setDeviceOn(Boolean(engine))
  }, [])

  const listRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<ChatMessage[]>(messages)
  messagesRef.current = messages

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  useEffect(() => {
    setSharePlan(loadSharePlan())
  }, [])

  // Ask once, on mount, which tier would answer — so the status line is honest
  // without the learner having to spend a message to find out.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await authFetch('/api/agent', { method: 'GET' })
        if (!res.ok) return
        const data = (await res.json()) as AgentStatus
        if (cancelled) return
        setStatusInfo(data)
        if (data.source === 'agent' || data.source === 'direct' || data.source === 'offline') {
          setStatus(data.source)
        }
      } catch {
        // A failed probe just means no status line; the chat itself still works.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const userMsg: ChatMessage = { role: 'user', content: trimmed }
    const history = messagesRef.current
    const next = [...history, userMsg]

    setMessages(next)
    setInput('')
    setError(null)
    setLoading(true)

    // Fired before the request so an abandoned or failed answer still counts —
    // that is the number worth having. Length and turn index only: the question
    // itself is user-typed free text and must never leave the device.
    track('tutor.asked', {
      level: level ?? 'beginner',
      turn: next.length,
      length: trimmed.length,
      hasCircuit: Boolean(circuitQasm),
    })

    /*
     * ON-DEVICE BRANCH — taken before any network call, and it returns.
     *
     * When the learner has loaded a local model the answer is generated here,
     * in this tab, on the GPU. Nothing is sent anywhere: no request, no
     * question text, no learner context. That is the whole promise of the
     * feature, so it is a hard early return rather than a fallback inside the
     * fetch path, where a future edit could accidentally let a request slip
     * out before the branch is checked.
     *
     * The assistant bubble is appended EMPTY and then rewritten on every
     * token, so the learner watches the answer being written. A local model
     * emits maybe 10-20 tokens a second and the wait is otherwise silent.
     */
    const deviceEngine = deviceEngineRef.current
    if (deviceEngine) {
      const index = next.length
      setMessages([...next, { role: 'assistant', content: '', source: 'device' }])
      setStatus('device')
      try {
        await streamDeviceReply(
          deviceEngine,
          next.map((m) => ({ role: m.role, content: m.content })),
          (full) =>
            setMessages((prev) => {
              const copy = [...prev]
              copy[index] = { role: 'assistant', content: full, source: 'device' }
              return copy
            }),
        )
      } catch {
        setMessages((prev) => prev.slice(0, index))
        setError('The on-device model stopped before it finished. Switch it off to use the hosted tutor.')
      } finally {
        setLoading(false)
      }
      return
    }

    try {
      const res = await authFetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          circuitQasm,
          level,
          // Computed fresh per send so a lesson finished in another tab counts.
          // Absent entirely when the learner has switched sharing off — the
          // server cannot tell "off" from "new learner", which is the point.
          ...(sharePlan ? { learnerContext: { plan: currentPlan() } } : {}),
        }),
      })

      const data = (await res.json()) as AgentResponse
      const reply =
        typeof data.reply === 'string' && data.reply.trim().length > 0
          ? data.reply
          : 'I did not get an answer back that time. Try asking again.'

      const source: TutorSource | undefined =
        data.source === 'agent' || data.source === 'direct' || data.source === 'offline'
          ? data.source
          : undefined
      if (source) setStatus(source)

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: reply,
          offline: data.offline === true,
          toolsUsed: Array.isArray(data.toolsUsed)
            ? data.toolsUsed.filter((t): t is string => typeof t === 'string')
            : undefined,
          source,
        },
      ])
    } catch {
      setError('Could not reach the tutor. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void send(input)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  const isEmpty = messages.length === 0

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      {/* A11Y: the tutor's reply appeared with no announcement at all — a
          screen-reader user pressed Send and heard nothing, ever. role="log"
          with aria-live="polite" announces each new bubble as it is appended.
          The region is present from first render, which is what makes later
          insertions announce (a live region added at the same time as its
          content is routinely missed). It is also scrollable, so tabIndex={0}
          lets a keyboard user scroll back through the transcript. */}
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation with the tutor"
        tabIndex={0}
        className="focus-ring min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
      >
        {isEmpty ? (
          <div className="flex h-full flex-col justify-center">
            <h2 className="text-lg font-bold text-ink">What would you like to understand?</h2>
            <p className="mt-1 text-sm text-ink-secondary">
              Ask in your own words — I&apos;ll match the depth to your level. Pick a starting point:
            </p>
            <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="card card-hover focus-ring px-3.5 py-3 text-left text-sm text-ink-secondary hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <MessageBubble
              key={i}
              role={m.role}
              content={m.content}
              offline={m.offline}
              toolsUsed={m.toolsUsed}
              source={m.source}
            />
          ))
        )}

        {loading ? (
          <div className="flex items-center gap-3" aria-live="polite">
            <div
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-q-violet/20 text-[15px] text-q-violet-text"
            >
              ⚛
            </div>
            <div className="flex items-center gap-1.5 rounded-2xl border border-line bg-surface px-4 py-3.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-q-violet-text [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-q-violet-text [animation-delay:180ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-q-violet-text [animation-delay:360ms]" />
              <span className="sr-only">Thinking…</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-line p-4">
        {status ? (
          <p className="mb-2 flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                status === 'agent'
                  ? 'bg-q-teal'
                  : status === 'direct'
                    ? 'bg-q-violet'
                    : 'bg-q-amber'
              }`}
            />
            {STATUS_COPY[status]}
            {tierDetail(statusInfo)}
            {statusInfo?.access === 'live' && statusInfo.tier === 'anonymous' ? (
              <>
                {' — '}
                <SignInLink>sign in for more</SignInLink>
              </>
            ) : null}
          </p>
        ) : null}

        {/* PRIVACY DISCLOSURE: honest about what leaves the device. The plan
            is derived on this device from local progress; the raw progress
            never goes anywhere. The switch defaults ON and the choice is
            remembered (see SHARE_PLAN_KEY). */}
        <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
          <span>
            {sharePlan
              ? 'The tutor can see your skill map — a compact study plan computed on this device. Your raw progress never leaves your browser.'
              : 'The tutor cannot see your skill map — answers are not personalised to your progress.'}
          </span>
          <button
            type="button"
            onClick={() => {
              const next = !sharePlan
              setSharePlan(next)
              saveSharePlan(next)
            }}
            aria-pressed={sharePlan}
            className="focus-ring shrink-0 rounded px-1 font-semibold underline underline-offset-2 hover:text-ink"
          >
            {sharePlan ? 'Turn off' : 'Turn on'}
          </button>
        </p>

        {error ? (
          // A11Y: a failed request was shown in rose text only. role="alert"
          // makes it interrupt, which is the right priority for "your question
          // did not go anywhere".
          <div role="alert" className="mb-2 flex items-start gap-2 text-xs text-q-rose-text">
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              className="focus-ring shrink-0 rounded px-1 leading-none hover:text-ink"
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* Below the privacy note and above the composer on purpose: it is a
            statement about where answers come from, which is what the note
            immediately above it is also about. */}
        <DeviceTutorPanel
          enabled={isDeviceTutorEnabled}
          onReady={handleDeviceReady}
          className="mb-3"
        />

        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Ask about superposition, entanglement, a gate, your circuit…"
            aria-label="Message the tutor"
            // RESPONSIVE: `min-w-0` is load-bearing. A flex item's default
            // `min-width: auto` resolves to the item's min-content width, and a
            // <textarea>'s min-content width is its `cols` default (~180px), so
            // `flex-1` could not shrink it. At 390px the composer measured
            // wider than the card and the Send button was clipped by the card's
            // edge — the tutor could be typed into but not submitted by tap.
            //
            // `text-base sm:text-sm`: iOS Safari zooms the whole page in when a
            // focused field's font-size is below 16px, and does not zoom back
            // out on blur. 16px on phones, the original 14px from `sm` up.
            className="focus-ring max-h-28 min-h-[2.75rem] min-w-0 flex-1 resize-y rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-base text-ink placeholder:text-ink-muted sm:text-sm"
          />
          <button
            type="submit"
            disabled={loading || input.trim().length === 0}
            className="btn-primary focus-ring shrink-0"
          >
            Send
          </button>
        </form>
        <p className="mt-2 text-[11px] text-ink-muted">Enter to send · Shift+Enter for a new line</p>
      </div>
    </div>
  )
}
