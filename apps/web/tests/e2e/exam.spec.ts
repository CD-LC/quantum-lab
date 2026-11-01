/**
 * exam.spec.ts — sitting the foundations certification.
 *
 * The paper is drawn per attempt, so nothing here asserts a specific score or a
 * specific question. What it does assert is the machinery: the clock runs down,
 * answers stick, a refresh mid-exam resumes the SAME paper rather than dealing a
 * new one, and submitting produces a score plus a per-question review.
 *
 * ── What changed when grading moved server-side ─────────────────────────────
 *
 * These specs run against a server with no Supabase project, so the browser is
 * an ANONYMOUS candidate: it gets a guest cookie, the paper comes from
 * /api/exams/foundations-cert/attempt without its answers, and the score is
 * computed on the server. Everything below is therefore a real end-to-end test
 * of the graded path — it just cannot earn a certificate, which needs an
 * account, and there is a spec for that refusal too.
 *
 * Two consequences for the specs themselves:
 *   · the paper no longer appears on navigation. The clock starts on "Begin
 *     exam", because the server stamps the deadline at that moment.
 *   · a graded attempt is a server record, so returning to the page shows the
 *     RESULT rather than silently dealing a fresh paper. Retaking is a click.
 */

import { test, expect, type Page } from '@playwright/test'

import { getExam } from '../../lib/exams/catalogue'
import { expectNoConsoleErrors, gotoClean } from './helpers'

const EXAM_ID = 'foundations-cert'
const EXAM = getExam(EXAM_ID)!

const timer = (page: Page) => page.getByRole('timer')
const navigator_ = (page: Page) => page.getByRole('navigation', { name: /question navigator/i })

const clockToSeconds = (text: string): number => {
  const parts = text.trim().split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return Number.NaN
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** Press Begin and wait for the server to deal a paper. */
async function beginExam(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Begin exam$/ }).click()
  await waitForPaper(page)
}

/** Wait for the runner to render the paper the server sent. */
async function waitForPaper(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: EXAM.title })).toBeVisible()
  await expect(page.getByRole('region', { name: /^Question 1 of \d+$/ })).toBeVisible()
}

/**
 * Answers are synced to the server on a 700ms debounce (SYNC_DEBOUNCE_MS in
 * ExamRunner). A reload fired before it lands would test the debounce, not the
 * resume, so wait it out plus a margin for the round trip.
 */
async function waitForAnswerSync(page: Page): Promise<void> {
  await page.waitForTimeout(1500)
}

/** Answer the question on screen by picking its first option. Returns false if it is numeric. */
async function answerCurrent(page: Page): Promise<boolean> {
  const radios = page.getByRole('radio')
  if ((await radios.count()) > 0) {
    await radios.first().click()
    return true
  }
  const checkboxes = page.getByRole('checkbox')
  if ((await checkboxes.count()) > 0) {
    await checkboxes.first().click()
    return true
  }
  const numeric = page.getByLabel('Your answer')
  if ((await numeric.count()) > 0) {
    await numeric.fill('0.5')
    return true
  }
  return false
}

test.describe('certification exam', () => {
  test('starts a paper with a running clock', async ({ page }) => {
    const console_ = expectNoConsoleErrors(page)
    await gotoClean(page, `/certify/${EXAM_ID}`)
    await beginExam(page)

    await expect(page.getByText(`0 / ${EXAM.questionCount} answered`)).toBeVisible()
    await expect(navigator_(page).getByRole('button')).toHaveCount(EXAM.questionCount)

    const clock = timer(page)
    await expect(clock).toBeVisible()

    const start = clockToSeconds(await clock.innerText())
    expect(Number.isNaN(start), 'the timer is not a clock').toBe(false)
    expect(start).toBeLessThanOrEqual(EXAM.timeLimitMinutes * 60)
    expect(start).toBeGreaterThan(EXAM.timeLimitMinutes * 60 - 30)

    // Counting DOWN, waited for rather than slept through.
    await expect
      .poll(async () => clockToSeconds(await clock.innerText()), { timeout: 8000 })
      .toBeLessThan(start)

    console_.assertClean(`/certify/${EXAM_ID}`)
  })

  test('answers persist and the same paper resumes after a mid-exam reload', async ({ page }) => {
    await gotoClean(page, `/certify/${EXAM_ID}`)
    await beginExam(page)

    expect(await answerCurrent(page), 'question 1 offered nothing to answer').toBe(true)
    await expect(page.getByText(`1 / ${EXAM.questionCount} answered`)).toBeVisible()

    // Snapshot AFTER answering, so the selection marker is part of both sides
    // of the comparison and only a genuinely different paper can differ.
    const promptBefore = await page
      .getByRole('region', { name: /^Question 1 of \d+$/ })
      .innerText()

    await waitForAnswerSync(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPaper(page)

    // Same paper — the question ids are written down on the server's attempt
    // row, so this survives a reload, a new tab, and a different machine — and
    // the answer, which now came back from the server rather than localStorage.
    const promptAfter = await page
      .getByRole('region', { name: /^Question 1 of \d+$/ })
      .innerText()
    expect(promptAfter).toBe(promptBefore)
    await expect(page.getByText(`1 / ${EXAM.questionCount} answered`)).toBeVisible()
  })

  test('submitting produces a score and a per-question review', async ({ page }) => {
    await gotoClean(page, `/certify/${EXAM_ID}`)
    await beginExam(page)

    const answerTarget = Math.min(5, EXAM.questionCount)
    for (let i = 0; i < answerTarget; i += 1) {
      await expect(page.getByRole('region', { name: `Question ${i + 1} of ${EXAM.questionCount}` })).toBeVisible()
      expect(await answerCurrent(page), `question ${i + 1} offered nothing to answer`).toBe(true)
      if (i < answerTarget - 1) await page.getByRole('button', { name: /^Next/ }).click()
    }
    await expect(page.getByText(`${answerTarget} / ${EXAM.questionCount} answered`)).toBeVisible()

    await page.getByRole('button', { name: /^Submit exam$/ }).click()
    await expect(page.getByRole('heading', { name: /submit for grading\?/i })).toBeVisible()
    await page.getByRole('button', { name: /yes, submit and grade/i }).click()

    // A score — any score. The paper is seeded per attempt, so the number is
    // deliberately not asserted, only its shape and its range.
    // Waited for, not read once: until the graded payload comes back from the
    // server the h1 is still the paper's own title, so `toBeVisible()` is
    // satisfied by the WRONG heading and the read below races the swap.
    const scoreHeading = page.getByRole('heading', { level: 1 })
    await expect(scoreHeading).toHaveText(/^\d+(\.\d+)?%$/)
    const scoreText = (await scoreHeading.innerText()).trim()
    expect(scoreText, `score heading read "${scoreText}"`).toMatch(/^\d+(\.\d+)?%$/)
    const score = Number.parseFloat(scoreText)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)

    // The review: every question, with a correct/incorrect verdict on each.
    const review = page.getByRole('region', { name: /question review/i })
    await expect(review).toBeVisible()
    await expect(review.getByRole('heading', { name: /review every question/i })).toBeVisible()
    await expect(
      review.getByRole('region', { name: /^Question \d+ of \d+$/ }),
    ).toHaveCount(EXAM.questionCount)

    const verdicts = review.getByText(/^(✓ Correct|✗ Incorrect)$/)
    await expect(verdicts).toHaveCount(EXAM.questionCount)

    // The clock is gone once the paper is graded.
    await expect(timer(page)).toHaveCount(0)
  })

  test('a graded attempt is not handed back as an unfinished one', async ({ page }) => {
    await gotoClean(page, `/certify/${EXAM_ID}`)
    await beginExam(page)

    await answerCurrent(page)
    await page.getByRole('button', { name: /^Submit exam$/ }).click()
    await page.getByRole('button', { name: /yes, submit and grade/i }).click()
    await expect(page.getByRole('region', { name: /question review/i })).toBeVisible()

    // Coming back shows the RESULT, not a fresh paper with the clock running.
    // The attempt is a server record now, so the browser cannot forget it.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: /question review/i })).toBeVisible()
    await expect(timer(page)).toHaveCount(0)

    // After a paper that did not pass the server makes the next one wait (the
    // review shows the answer key, so an instant retake would harvest the
    // bank). The button says so up front instead of leading to an error page.
    await expect(page.getByRole('button', { name: /^Retake exam$/ })).toBeDisabled()
    await expect(page.getByText(/you can sit again from/i)).toBeVisible()
  })

  test('an anonymous pass is graded but not certified', async ({ page }) => {
    // No Supabase in this environment, so the candidate is a guest. The point
    // of this spec is the refusal: the grading path is identical and the
    // credential is not available, which is the honest half of guest mode.
    await gotoClean(page, `/certify/${EXAM_ID}`)
    await beginExam(page)

    await expect(
      page.getByText(/you are sitting this anonymously/i),
      'a guest is not told their attempt cannot be certified'
    ).toBeVisible()

    await answerCurrent(page)
    await page.getByRole('button', { name: /^Submit exam$/ }).click()
    await page.getByRole('button', { name: /yes, submit and grade/i }).click()
    await expect(page.getByRole('region', { name: /question review/i })).toBeVisible()

    // Whatever the score, no certificate is offered to an anonymous sitting.
    await expect(page.getByRole('button', { name: /issue my certificate/i })).toHaveCount(0)
  })

  test('a fabricated certificate number does not verify', async ({ page }) => {
    // The checksum is right and no such certificate was ever issued, which is
    // the case a forger would actually try.
    await gotoClean(page, '/verify/QL-AAAAA-AAAAA-4')
    await expect(page.getByRole('heading', { name: /not verified/i })).toBeVisible()
    await expect(page.getByText(/no certificate has been issued/i)).toBeVisible()

    // …and one that is not even the right shape is told so, rather than being
    // reported as a missing certificate.
    await gotoClean(page, '/verify/definitely-not-a-certificate')
    await expect(page.getByText(/not the shape of a qubit16 certificate/i)).toBeVisible()
  })
})
