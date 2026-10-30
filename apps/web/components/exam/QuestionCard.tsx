'use client'

/**
 * QuestionCard — one exam question, in either answering or review mode.
 *
 * The same component does both jobs so that the review screen cannot drift out
 * of sync with what the candidate actually saw. In review mode every control is
 * disabled and recoloured; the colour language matches the lesson quiz (teal +
 * ✓ for correct, rose + ✗ for wrong, correct answer always revealed).
 *
 * ── Where the answer key comes from, and where it does not ──────────────────
 *
 * `question` is a `PaperQuestion`. That type CANNOT carry `correctIds`,
 * `correctNumber`, `tolerance` or `explanation` — the fields do not exist on
 * it. This component used to read `question.correctIds` while answering, which
 * only worked because the whole bank was in the browser.
 *
 * Everything the review needs arrives in `graded`, a `ReviewQuestion` the
 * server sends AFTER it has closed the attempt, for the questions on this
 * candidate's paper only. No `graded` prop, no key on screen and none in
 * memory. Do not add an `answers` prop to make some future screen easier.
 */

import Link from 'next/link'
import type { AnswerState, PaperQuestion, ReviewQuestion } from '@/lib/exams/types'

interface QuestionCardProps {
  question: PaperQuestion
  index: number
  total: number
  answer: AnswerState | undefined
  onChange: (next: AnswerState) => void
  reviewMode?: boolean
  /** The server's verdict and key. Present only after submission. */
  graded?: ReviewQuestion
}

function emptyAnswer(questionId: string): AnswerState {
  return { questionId, selectedIds: [], flagged: false }
}

const KIND_LABEL: Record<PaperQuestion['kind'], string> = {
  single: 'Single answer',
  multi: 'Select all that apply',
  numeric: 'Numeric answer',
  'circuit-outcome': 'Circuit outcome',
}

export function QuestionCard({
  question,
  index,
  total,
  answer,
  onChange,
  reviewMode = false,
  graded,
}: QuestionCardProps) {
  const current = answer ?? emptyAnswer(question.id)
  const isMulti = question.kind === 'multi' || question.kind === 'circuit-outcome'
  // Server-supplied, and empty until the attempt is graded.
  const correctIds = graded?.correctIds ?? []

  function toggleOption(optionId: string) {
    if (reviewMode) return
    if (isMulti) {
      const next = current.selectedIds.includes(optionId)
        ? current.selectedIds.filter((id) => id !== optionId)
        : [...current.selectedIds, optionId]
      onChange({ ...current, selectedIds: next })
      return
    }
    onChange({ ...current, selectedIds: [optionId] })
  }

  function setNumber(raw: string) {
    if (reviewMode) return
    const trimmed = raw.trim()
    if (trimmed === '') {
      const { numberValue: _dropped, ...rest } = current
      void _dropped
      onChange({ ...rest, selectedIds: [] })
      return
    }
    const value = Number(trimmed)
    if (!Number.isFinite(value)) return
    onChange({ ...current, numberValue: value })
  }

  function toggleFlag() {
    if (reviewMode) return
    onChange({ ...current, flagged: !current.flagged })
  }

  return (
    <section className="card p-5 md:p-6" aria-label={`Question ${index + 1} of ${total}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="section-label">
            Question {index + 1} of {total}
          </span>
          <span className="pill border-line text-ink-muted">{KIND_LABEL[question.kind]}</span>
          <span className="pill border-line text-ink-muted">
            {question.points} {question.points === 1 ? 'point' : 'points'}
          </span>
          {reviewMode && graded ? (
            <span
              className={
                graded.correct
                  ? 'pill border-q-teal/60 text-q-teal-text'
                  : 'pill border-q-rose/60 text-q-rose-text'
              }
            >
              {graded.correct ? '✓ Correct' : '✗ Incorrect'}
            </span>
          ) : null}
        </div>

        {reviewMode ? null : (
          <button
            type="button"
            onClick={toggleFlag}
            aria-pressed={current.flagged}
            className={`focus-ring rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors duration-150 ${
              current.flagged
                ? 'border-q-amber/60 bg-q-amber/10 text-q-amber-text'
                : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink-secondary'
            }`}
          >
            {current.flagged ? '⚑ Flagged' : '⚑ Flag for review'}
          </button>
        )}
      </div>

      {/* A11Y: the prompt is now an addressable label for the answer group below. */}
      <p
        id={`prompt-${question.id}`}
        className="mt-4 text-[15px] font-semibold leading-relaxed text-ink"
      >
        {question.prompt}
      </p>

      {question.qasm ? (
        <pre className="code-block mt-4 overflow-x-auto text-[12px] leading-relaxed">
          <code>{question.qasm}</code>
        </pre>
      ) : null}

      {isMulti ? (
        <p id={`multi-${question.id}`} className="mt-3 text-[12px] text-ink-muted">
          Select all that apply.
        </p>
      ) : null}

      {question.kind === 'numeric' ? (
        <div className="mt-4">
          <label
            htmlFor={`num-${question.id}`}
            className="block text-[12px] font-semibold text-ink-secondary"
          >
            Your answer
          </label>
          <input
            id={`num-${question.id}`}
            type="number"
            step="any"
            inputMode="decimal"
            // A11Y (2.1.1, audit finding 18): `disabled` here took the numeric
            // answer out of the tab order too, so a keyboard user could not
            // read back what they had typed. readOnly keeps it focusable and
            // announced; setNumber() already no-ops in review mode.
            readOnly={reviewMode}
            aria-disabled={reviewMode || undefined}
            value={current.numberValue === undefined ? '' : String(current.numberValue)}
            onChange={(event) => setNumber(event.target.value)}
            // A11Y: in review mode right/wrong is carried by border colour
            // alone on this control (1.4.1 Use of Colour). State it in text.
            aria-describedby={reviewMode && graded ? `numeric-verdict-${question.id}` : undefined}
            className={`focus-ring mt-1.5 w-full max-w-[220px] rounded-lg border bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-muted disabled:cursor-default ${
              reviewMode && graded
                ? graded.correct
                  ? 'border-q-teal/60 text-q-teal-text'
                  : 'border-q-rose/60 text-q-rose-text'
                : 'border-line'
            }`}
            placeholder="e.g. 0.5"
          />
          {reviewMode && graded ? (
            <span id={`numeric-verdict-${question.id}`} className="sr-only">
              {graded.correct ? 'Your answer was correct.' : 'Your answer was incorrect.'}
            </span>
          ) : null}
          {reviewMode && graded && !graded.correct ? (
            <p className="mt-2 text-[13px] text-q-teal-text">
              <span aria-hidden="true" className="mr-1.5 font-bold">
                ✓
              </span>
              Correct answer: {graded.correctNumber}
              {graded.tolerance ? ` (± ${graded.tolerance})` : ''}
            </p>
          ) : null}
        </div>
      ) : (
        // A11Y: the radiogroup/group had no accessible name, so a screen reader
        // announced "radio, not checked, 1 of 4" with no idea what was being
        // asked — the question text was a separate, unassociated paragraph.
        <div
          className="mt-4 space-y-2"
          role={isMulti ? 'group' : 'radiogroup'}
          aria-labelledby={`prompt-${question.id}`}
          aria-describedby={isMulti ? `multi-${question.id}` : undefined}
        >
          {(question.options ?? []).map((option) => {
            const picked = current.selectedIds.includes(option.id)
            const isCorrect = correctIds.includes(option.id)
            const showChosenCorrect = reviewMode && picked && isCorrect
            const showChosenWrong = reviewMode && picked && !isCorrect
            const showMissedCorrect = reviewMode && !picked && isCorrect

            const tone = showChosenCorrect
              ? 'border-q-teal/60 bg-q-teal/10 text-q-teal-text'
              : showChosenWrong
                ? 'border-q-rose/60 bg-q-rose/10 text-q-rose-text'
                : showMissedCorrect
                  ? 'border-q-teal/60 bg-transparent text-q-teal-text'
                  : reviewMode
                    ? 'border-line bg-surface-2 text-ink-muted'
                    : picked
                      ? 'border-q-violet/60 bg-q-violet/10 text-ink'
                      : 'border-line bg-surface-2 text-ink-secondary hover:border-line-strong hover:text-ink'

            const marker = showChosenCorrect || showMissedCorrect ? '✓' : showChosenWrong ? '✗' : ''

            // A11Y (1.4.1 Use of Colour): in review mode the verdict on each
            // option is carried by border/text hue plus a ✓/✗ glyph that is
            // aria-hidden. Say it. `null` outside review mode, so nothing extra
            // is read while the candidate is still answering.
            const verdict = !reviewMode
              ? null
              : showChosenCorrect
                ? 'Your answer. Correct.'
                : showChosenWrong
                  ? 'Your answer. Incorrect.'
                  : showMissedCorrect
                    ? 'You did not choose this. This was a correct answer.'
                    : 'You did not choose this. It was not a correct answer.'

            return (
              <button
                key={option.id}
                type="button"
                role={isMulti ? 'checkbox' : 'radio'}
                aria-checked={picked}
                // A11Y (2.1.1 Keyboard, audit finding 18): `disabled` removed
                // these from the tab order, so a keyboard-only candidate could
                // not read back their own answers on the review screen.
                // aria-disabled keeps them focusable and announced as
                // unavailable; toggleOption() already no-ops in review mode, so
                // the graded state cannot change.
                aria-disabled={reviewMode || undefined}
                onClick={() => toggleOption(option.id)}
                className={`focus-ring flex w-full items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors duration-150 ${
                  reviewMode ? 'cursor-default' : ''
                } ${tone}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center border text-[11px] font-bold ${
                    isMulti ? 'rounded-[4px]' : 'rounded-full'
                  } ${picked || showMissedCorrect ? 'border-current' : 'border-line-strong'}`}
                >
                  {marker !== '' ? marker : picked ? '•' : ''}
                </span>
                <span>{option.text}</span>
                {verdict === null ? null : <span className="sr-only"> {verdict}</span>}
              </button>
            )
          })}
        </div>
      )}

      {reviewMode && graded ? (
        <div className="card mt-4 bg-surface-2 p-4">
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            {graded.explanation ? (
              <>
                <span className="mr-2 text-[11px] font-bold uppercase tracking-[0.09em] text-q-violet">
                  Why
                </span>
                {graded.explanation}
              </>
            ) : (
              'You left this one blank, so the answer and explanation are not shown. Answer every question to see the full review.'
            )}
          </p>
          <Link
            href={`/learn/${question.lessonSlug}`}
            className="focus-ring mt-3 inline-block text-[12px] font-semibold text-q-violet-text hover:underline"
          >
            Revise this lesson →
          </Link>
        </div>
      ) : null}
    </section>
  )
}

export default QuestionCard
