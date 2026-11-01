'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MODEL_IDS, type ComparisonConfig, type ModelId, type ModelReport } from '@/lib/workbench/qml'
import { runQmlSession, type SessionMessage } from '@/lib/workbench/qmlSession'
import type { WorkerRequest } from '@/lib/workbench/qml.worker'

/**
 * useQmlSession — owns one training session for /workbench/qml-check.
 *
 * The session runs in a Web Worker so the page stays responsive while a
 * 4-qubit circuit is being differentiated a few hundred thousand times. If a
 * worker cannot be built (an old browser, a CSP that forbids it, a bundler
 * that could not split the chunk), the SAME driver runs on the main thread
 * with requestAnimationFrame as its yield — slower to paint, still bounded,
 * still stoppable, never a frozen tab.
 */

export type SessionStatus = 'idle' | 'running' | 'finished' | 'stopped' | 'error'

export interface SessionState {
  status: SessionStatus
  reports: Partial<Record<ModelId, ModelReport>>
  grids: Partial<Record<ModelId, Float32Array>>
  /** Which model is training right now. */
  active: ModelId | null
  elapsedMs: number
  cutOff: boolean
  error: string | null
  /** Whether the session ran in a worker (true) or fell back to the main thread. */
  inWorker: boolean | null
}

const INITIAL: SessionState = {
  status: 'idle',
  reports: {},
  grids: {},
  active: null,
  elapsedMs: 0,
  cutOff: false,
  error: null,
  inWorker: null,
}

function buildWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('../../lib/workbench/qml.worker.ts', import.meta.url))
  } catch {
    return null
  }
}

export function useQmlSession() {
  const [state, setState] = useState<SessionState>(INITIAL)
  const workerRef = useRef<Worker | null>(null)
  const stopFlag = useRef(false)
  const mainThreadRunning = useRef(false)
  // False before mount and after unmount, so nothing starts a worker or a
  // main-thread session (and nothing sets state) for a page that is gone.
  const mounted = useRef(false)

  const applyMessage = useCallback((m: SessionMessage) => {
    if (!mounted.current) return
    setState((s) => {
      switch (m.type) {
        case 'started':
          return { ...s, status: 'running', reports: {}, grids: {}, active: MODEL_IDS[0], elapsedMs: 0, cutOff: false, error: null }
        case 'progress':
          return {
            ...s,
            active: m.model,
            elapsedMs: m.elapsedMs,
            reports: { ...s.reports, [m.model]: m.report },
            grids: m.grid ? { ...s.grids, [m.model]: m.grid } : s.grids,
          }
        case 'finished':
          return {
            ...s,
            status: m.cutOff ? 'stopped' : 'finished',
            active: null,
            elapsedMs: m.elapsedMs,
            reports: m.reports,
            grids: m.grids,
            cutOff: m.cutOff,
          }
        case 'error':
          return { ...s, status: 'error', active: null, error: m.message }
      }
    })
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      workerRef.current?.terminate()
      workerRef.current = null
      stopFlag.current = true
    }
  }, [])

  const start = useCallback(
    (config: ComparisonConfig, budgetMs: number) => {
      if (!mounted.current) return
      if (!workerRef.current) workerRef.current = buildWorker()
      const worker = workerRef.current
      if (worker) {
        worker.onmessage = (e: MessageEvent<SessionMessage>) => applyMessage(e.data)
        worker.onerror = () => {
          // The chunk failed to load or threw at top level: drop to the main thread.
          worker.terminate()
          workerRef.current = null
          if (!mounted.current) return
          setState((s) => ({ ...s, inWorker: false }))
          startOnMainThread(config, budgetMs)
        }
        setState((s) => ({ ...s, inWorker: true }))
        const req: WorkerRequest = { type: 'start', config, budgetMs }
        worker.postMessage(req)
        return
      }
      setState((s) => ({ ...s, inWorker: false }))
      startOnMainThread(config, budgetMs)

      function startOnMainThread(cfg: ComparisonConfig, budget: number) {
        stopFlag.current = true
        const begin = () => {
          if (!mounted.current) return
          stopFlag.current = false
          mainThreadRunning.current = true
          void runQmlSession(cfg, applyMessage, {
            shouldStop: () => stopFlag.current,
            yieldNow: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
            now: () => performance.now(),
            // Shorter slices than the worker: this thread also has to paint.
            sliceMs: 12,
            budgetMs: budget,
          }).finally(() => {
            mainThreadRunning.current = false
          })
        }
        if (mainThreadRunning.current) {
          // Let the previous session notice the stop flag on its next yield.
          const wait = () => {
            if (!mounted.current) return
            if (mainThreadRunning.current) requestAnimationFrame(wait)
            else begin()
          }
          requestAnimationFrame(wait)
        } else {
          begin()
        }
      }
    },
    [applyMessage],
  )

  const stop = useCallback(() => {
    stopFlag.current = true
    const req: WorkerRequest = { type: 'stop' }
    workerRef.current?.postMessage(req)
  }, [])

  return { state, start, stop }
}
