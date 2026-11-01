/**
 * A blank numeric answer in review: the server withholds the key, so the card
 * must not print a dangling "Correct answer:" line.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuestionCard } from '@/components/exam/QuestionCard'
import type { PaperQuestion, ReviewQuestion } from '@/lib/exams/types'

const question: PaperQuestion = {
  id: 'q1',
  kind: 'numeric',
  prompt: 'What is the probability?',
  lessonSlug: 'superposition',
  points: 1,
}

function render(graded: ReviewQuestion): string {
  return renderToStaticMarkup(
    createElement(QuestionCard, {
      question,
      index: 0,
      total: 1,
      answer: undefined,
      onChange: () => undefined,
      reviewMode: true,
      graded,
    })
  )
}

describe('QuestionCard numeric review', () => {
  it('omits the "Correct answer" line when the key was withheld (blank answer)', () => {
    const html = render({ ...question, correct: false, earned: 0, answered: false })
    expect(html).not.toContain('Correct answer')
  })

  it('shows the key and tolerance for a wrong answer', () => {
    const html = render({
      ...question,
      correct: false,
      earned: 0,
      answered: true,
      correctNumber: 0.5,
      tolerance: 0.01,
    })
    expect(html).toContain('Correct answer:')
    expect(html).toContain('0.5')
  })

  it('shows a zero key (falsy but defined)', () => {
    const html = render({ ...question, correct: false, earned: 0, answered: true, correctNumber: 0 })
    expect(html).toContain('Correct answer:')
  })
})
