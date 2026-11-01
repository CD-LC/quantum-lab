import { test, expect, type Page } from '@playwright/test'

/**
 * Hand-written accessibility checks.
 *
 * Deliberately NOT axe-core: no new dependency was allowed, and more usefully,
 * every assertion here is one a human can read and argue with. These are
 * structural checks — they catch missing names, broken heading outlines and
 * invisible focus. They do not and cannot replace testing with a screen reader.
 *
 * A failing assertion in this file is documenting a real barrier. Do not relax
 * one to get the suite green; fix the product or record the finding in
 * docs/ACCESSIBILITY.md.
 */

/** Representative routes — one of each kind of surface, not all 56. */
const ROUTES = [
  '/', // marketing / hero
  '/visualizations', // index
  '/visualizations/superposition', // canvas visualization + VizFrame
  '/simulator', // the circuit editor
  '/tutor', // chat UI
  '/challenges', // list
  '/certify', // exam entry
  '/pricing',

  /*
   * Second pass — the surfaces the first audit never reached. Each of these is
   * a different *kind* of surface, not just another page: a paywalled async
   * console (/hardware), a dashboard built from local data (/insights), a
   * billing/account form (/account), a CRUD list with a destructive action
   * (/circuits), an SVG concept map (/coach), the onboarding funnel (/welcome),
   * the service-worker fallback (/offline) and the course index (/learn).
   *
   * All eight already passed the five structural checks below when they were
   * added, measured against a production build — they are here as regression
   * guards, and the defects this pass actually found are the named tests at
   * the bottom of the file, which each failed before their fix.
   */
  '/hardware',
  '/insights',
  '/account',
  '/circuits',
  '/coach',
  '/welcome',
  '/offline',
  '/learn',

  /*
   * Phase 15 surfaces — the weekly competition (a leaderboard table plus a
   * submission flow) and the QEC decoder duel (a canvas race with live
   * scoreboard). Added the same way /coach was: run the structural checks
   * against them from the day they ship.
   */
  '/compete',
  '/visualizations/qec-duel',

  // Phase 16 — the agent benchmark results page, added the same way.
  '/benchmark',

  // Learning paths (a milestone timeline with per-step checkboxes and a
  // progressbar) and the glossary (a definition list with a live filter).
  '/paths',
  '/paths/quantum-software-engineer',
  '/glossary',

  // The operator console: signed out it renders the sign-in gate, which is
  // the surface every admin meets first.
  '/admin/platform',

  /*
   * The visualization wave brought three genuinely new *kinds* of surface, and
   * this list stayed at "one canvas visualization" (/visualizations/superposition)
   * while it happened. Each of these breaks an assumption the older pages let
   * this suite make:
   *
   *   /visualizations/mach-zehnder — an optical table you build by dragging
   *     components between slots. The slots are real <button>s and the drag has
   *     a keyboard path, so the accessible-name and focus-ring checks below have
   *     something to say about it; drag-and-drop is exactly the interaction that
   *     ships keyboard-inaccessible when nobody looks.
   *   /visualizations/wave-packets — you draw the potential on the canvas, so
   *     the canvas takes role="application" and tabIndex={0} while drawing. A
   *     focusable canvas with no visible focus ring is a dead end for anyone
   *     navigating by keyboard.
   *   /visualizations/hydrogen-atom — a WebGL container with tabIndex={0} that
   *     mounts after hydration, plus a spectrum table. Nothing else here is a
   *     focusable three.js surface.
   */
  '/visualizations/mach-zehnder',
  '/visualizations/wave-packets',
  '/visualizations/hydrogen-atom',
] as const

// ── helpers ────────────────────────────────────────────────────────────────

async function goto(page: Page, route: string): Promise<void> {
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
  expect(response, `no response for ${route}`).not.toBeNull()
  expect(response?.ok(), `${route} returned ${response?.status()}`).toBeTruthy()
  // Client components (VizFrame, CircuitGrid, ChatPanel) hydrate after paint.
  await page.waitForLoadState('load')
}

/**
 * Elements matching `selector` that have no accessible name.
 *
 * A deliberately conservative reimplementation of the parts of accname that
 * matter here: aria-labelledby, aria-label, title, an SVG <title> child, alt,
 * an associated or wrapping <label>, and (for buttons/links) own content.
 *
 * A `placeholder` is NOT accepted as a name: it vanishes the moment the user
 * types and is not reliably exposed. Placeholder-as-label is one of the things
 * this spec is here to catch.
 *
 * Written as a single self-contained page function (rather than a shared
 * stringified helper) so it never needs eval() — a CSP without 'unsafe-eval'
 * would otherwise break the suite.
 */
async function unnamed(page: Page, selector: string): Promise<string[]> {
  return page.$$eval(selector, (nodes) => {
    const text = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
    const byIds = (ids: string | null): string =>
      text(
        (ids ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
      )

    const hasName = (el: Element): boolean => {
      if (text(el.getAttribute('aria-label')) !== '') return true
      if (byIds(el.getAttribute('aria-labelledby')) !== '') return true
      if (text(el.getAttribute('alt')) !== '') return true
      if (text(el.getAttribute('title')) !== '') return true
      const svgTitle = el.querySelector(':scope > title')
      if (svgTitle && text(svgTitle.textContent) !== '') return true
      if (el.id !== '') {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (forLabel && text(forLabel.textContent) !== '') return true
      }
      const wrapping = el.closest('label')
      if (wrapping && text(wrapping.textContent) !== '') return true
      const tag = el.tagName.toLowerCase()
      if (tag === 'button' || tag === 'a' || tag === 'summary') {
        if (text(el.textContent) !== '') return true
      }
      return false
    }

    const describe = (el: Element): string => {
      const attrs = ['id', 'name', 'type', 'placeholder', 'class']
        .map((a) => {
          const v = el.getAttribute(a)
          return v === null ? '' : `${a}="${v.slice(0, 40)}"`
        })
        .filter((x) => x !== '')
        .join(' ')
      return `<${el.tagName.toLowerCase()}${attrs === '' ? '' : ' ' + attrs}>`
    }

    return nodes
      .filter((n) => {
        // Explicitly decorative graphics are correctly exempt.
        if (n.getAttribute('aria-hidden') === 'true') return false
        const role = n.getAttribute('role')
        if (role === 'presentation' || role === 'none') return false
        return !hasName(n)
      })
      .map(describe)
  })
}

// ── 1. exactly one h1 per page ─────────────────────────────────────────────

for (const route of ROUTES) {
  test(`${route} has exactly one h1`, async ({ page }) => {
    await goto(page, route)
    const texts = await page.locator('h1').allTextContents()
    expect(texts.length, `${route} h1s: ${JSON.stringify(texts)}`).toBe(1)
  })
}

// ── 2. no skipped heading levels ───────────────────────────────────────────

for (const route of ROUTES) {
  test(`${route} has no skipped heading levels`, async ({ page }) => {
    await goto(page, route)
    const levels = await page.$$eval('h1, h2, h3, h4, h5, h6', (nodes) =>
      nodes.map((n) => ({
        level: Number(n.tagName.slice(1)),
        text: (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50),
      }))
    )
    const skips: string[] = []
    let previous = 0
    for (const h of levels) {
      if (previous !== 0 && h.level > previous + 1) {
        skips.push(`h${previous} → h${h.level} at "${h.text}"`)
      }
      previous = h.level
    }
    expect(skips, `${route} skipped heading levels`).toEqual([])
  })
}

// ── 3. every img / canvas / svg[role=img] has an accessible name ───────────

for (const route of ROUTES) {
  test(`${route} graphics have accessible names`, async ({ page }) => {
    await goto(page, route)
    const missing = await unnamed(page, 'img, canvas, svg[role="img"], [role="img"]')
    expect(missing, `${route} graphics with no accessible name`).toEqual([])
  })
}

// ── 4. every form control is labelled ──────────────────────────────────────

for (const route of ROUTES) {
  test(`${route} form controls are labelled`, async ({ page }) => {
    await goto(page, route)
    // A placeholder is NOT a label — see the note on unnamed() above.
    const unlabelled = await unnamed(page, 'input:not([type="hidden"]), select, textarea')
    expect(unlabelled, `${route} controls with no label`).toEqual([])
  })
}

// ── 5. 25 tab stops, each with a visible focus indicator ───────────────────

interface FocusProbe {
  tag: string
  label: string
  visible: boolean
}

for (const route of ROUTES) {
  test(`${route} focus is visible for the first 25 tab stops`, async ({ page }) => {
    await goto(page, route)
    await page.evaluate(() => {
      // Start from the very top of the document so tab order is deterministic.
      document.body.focus()
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })

    const invisible: string[] = []
    const seen = new Set<string>()

    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab')
      const probe = await page.evaluate<FocusProbe | null>(() => {
        const el = document.activeElement
        if (!el || el === document.body || !(el instanceof Element)) return null

        const style = (node: Element) => {
          const cs = getComputedStyle(node)
          return [
            cs.outlineStyle,
            cs.outlineWidth,
            cs.outlineColor,
            cs.boxShadow,
            cs.borderColor,
            cs.backgroundColor,
            cs.filter,
          ].join('|')
        }

        // Compare the element's own styles against the same element with focus
        // removed. Blurring and re-focusing is the only way to read the
        // unfocused computed style of the element that currently has focus.
        // The circuit editor paints its own focus indicator as an extra SVG
        // shape rather than a CSS outline, so also fingerprint the owning
        // <svg>'s markup length.
        const svgOwner = (el as SVGElement).ownerSVGElement ?? null
        // Transitions have to be suppressed for the duration of the comparison.
        // Several controls carry `transition-all duration-150`, so the computed
        // style read immediately after `.blur()` is the ring MID-FADE — still
        // almost exactly the focused value — and the element is then reported as
        // having no focus indicator at all. That produced a real failure on one
        // arbitrary gate button per run.
        const inline = (el as HTMLElement).style?.transition ?? ''
        if ((el as HTMLElement).style) (el as HTMLElement).style.transition = 'none'
        const focused = style(el)
        const svgMarkup = svgOwner ? svgOwner.innerHTML.length : -1
        ;(el as HTMLElement).blur?.()
        const blurred = style(el)
        const svgMarkupBlurred = svgOwner ? svgOwner.innerHTML.length : -1
        ;(el as HTMLElement).focus?.()
        if ((el as HTMLElement).style) (el as HTMLElement).style.transition = inline

        const changed =
          focused !== blurred ||
          svgMarkup !== svgMarkupBlurred ||
          // A UA ring that survives the blur/focus dance still counts.
          getComputedStyle(el).outlineStyle === 'auto'

        const name =
          el.getAttribute('aria-label') ??
          (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
        return { tag: el.tagName.toLowerCase(), label: name, visible: changed }
      })

      if (!probe) break
      const key = `${probe.tag}:${probe.label}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!probe.visible) invisible.push(`${probe.tag} "${probe.label}"`)
    }

    expect(invisible, `${route} focusable elements with no visible focus indicator`).toEqual([])
  })
}

// ── 6. the command palette: combobox + aria-activedescendant ───────────────

test('command palette exposes a correct combobox/listbox relationship', async ({ page }) => {
  await goto(page, '/')

  await page.keyboard.press('Control+k')

  const input = page.locator('dialog input[role="combobox"]')
  await expect(input, 'the palette search input must be a combobox').toBeVisible()

  // The listbox it controls must actually exist and carry role=listbox.
  const controls = await input.getAttribute('aria-controls')
  expect(controls, 'combobox must reference its listbox via aria-controls').toBeTruthy()
  // Attribute selectors, not `#id`: the option ids embed a route
  // ("qlab-search-option-viz-/visualizations/grover") and the "/" is not a
  // valid CSS id token. That is legal HTML but worth knowing about.
  const listbox = page.locator(`[id="${controls}"]`)
  await expect(listbox).toHaveAttribute('role', 'listbox')

  await input.fill('bell')
  await expect(listbox.locator('[role="option"]').first()).toBeVisible()

  await page.keyboard.press('ArrowDown')

  const activeId = await input.getAttribute('aria-activedescendant')
  expect(activeId, 'aria-activedescendant must be set once a row is active').toBeTruthy()

  const activeOption = page.locator(`[id="${activeId}"]`)
  await expect(activeOption, 'aria-activedescendant must point at a real element').toHaveCount(1)
  await expect(activeOption, 'the referenced element must be the selected option').toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(activeOption).toHaveAttribute('role', 'option')

  // And it must track: a second ArrowDown must move it somewhere else.
  await page.keyboard.press('ArrowDown')
  const nextId = await input.getAttribute('aria-activedescendant')
  expect(nextId, 'aria-activedescendant must follow the arrow keys').not.toBe(activeId)
})

// ── 7. the skip link ───────────────────────────────────────────────────────

/**
 * EXPECTED TO FAIL UNTIL app/layout.tsx IS UPDATED.
 *
 * components/ui/SkipLink.tsx exists and is correct, but layout.tsx is owned by
 * another workstream. That mounting has since landed: app/layout.tsx now
 * renders <SkipLink /> as the first child of <body> and <main id="main"
 * tabIndex={-1}>, so WCAG 2.4.1 (Level A) is satisfied and this test is live
 * again. It was `test.fixme` while the gap was real.
 */
test('skip link is first in the tab order and moves focus to main', async ({ page }) => {
  await goto(page, '/')

  await page.keyboard.press('Tab')

  const first = page.locator(':focus')
  await expect(first, 'the first tab stop must be the skip link').toHaveText(
    /skip to main content/i
  )
  await expect(first).toHaveAttribute('href', '#main')
  // Visually hidden until focused, then genuinely visible.
  await expect(first).toBeVisible()

  await page.keyboard.press('Enter')

  const focusedIsMain = await page.evaluate(() => {
    const el = document.activeElement
    return el?.id === 'main' || el?.tagName.toLowerCase() === 'main'
  })
  expect(focusedIsMain, 'activating the skip link must move focus into <main>').toBeTruthy()
})

// ── 8. landmarks ───────────────────────────────────────────────────────────

for (const route of ROUTES) {
  test(`${route} has exactly one main landmark`, async ({ page }) => {
    await goto(page, route)
    const count = await page.locator('main').count()
    const nested = await page.locator('main main').count()
    expect(nested, `${route} nests a <main> inside another <main>`).toBe(0)
    expect(count, `${route} main landmark count`).toBeGreaterThan(0)
  })
}

// ── 9. the exam clock speaks at thresholds, and never per second ───────────

const EXAM_ROUTE = '/certify/foundations-cert'

/** "9:58" → 598_000. NaN-safe so a broken clock fails loudly rather than oddly. */
function clockMs(text: string): number {
  const parts = text.trim().split(':').map(Number)
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return Number.NaN
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000
}

/**
 * Open the exam and press Begin.
 *
 * The paper no longer appears on page load: an attempt is a row the server
 * creates, its deadline is stamped from the server clock at that moment, and a
 * page view must not spend one. So every exam test starts here.
 */
async function beginExam(page: Page, route: string = EXAM_ROUTE): Promise<void> {
  await goto(page, route)
  await page.getByRole('button', { name: /^Begin exam$/ }).click()
  await expect(page.getByRole('region', { name: /^Question 1 of/ })).toBeVisible()
}

/**
 * Move the BROWSER's clock forward so that `desiredLeftMs` remains on screen.
 *
 * The countdown is `attempt.expiresAt` (an ISO stamp the server made) against
 * the browser's own `Date.now()`, re-read once a second. There is no longer a
 * stored `startedAt` to rewind — attempts live server-side — so the only way to
 * reach a threshold without sitting through 25 real minutes is to move the one
 * clock the page actually reads. That is also exactly what the component's
 * header says a candidate could do, and why the server re-checks its own clock
 * on submit; here it is a fast-forward, not an exploit. The shift is computed
 * from the clock currently on screen rather than from the exam's time limit, so
 * this stays correct if the limit is retuned.
 */
async function rewindExamClock(page: Page, desiredLeftMs: number): Promise<void> {
  const shown = clockMs(await page.getByRole('timer').innerText())
  expect(Number.isNaN(shown), 'the exam timer is not a clock').toBe(false)
  await page.evaluate((shiftMs) => {
    const w = window as unknown as { __realNow?: () => number; __clockShift?: number }
    if (!w.__realNow) {
      const real = Date.now.bind(Date)
      w.__realNow = real
      w.__clockShift = 0
      Date.now = () => real() + (w.__clockShift ?? 0)
    }
    w.__clockShift = (w.__clockShift ?? 0) + shiftMs
  }, shown - desiredLeftMs)
}

/** Current text of one of lib/a11y/announce.ts's two live regions. */
async function liveRegionText(page: Page, priority: 'polite' | 'assertive'): Promise<string> {
  return page.evaluate(
    (p) => document.querySelector(`[data-a11y-live="${p}"]`)?.textContent ?? '',
    priority
  )
}

/**
 * WCAG 4.1.3 / 2.2.1 — audit finding 7.
 *
 * A ticking countdown must NOT be a live region: "24:59, 24:58, …" once a
 * second is unusable. The requirement is the opposite shape — the digits are
 * silent, and meaningful thresholds are spoken instead, once each.
 */
test('the exam countdown is silent per second but announces time thresholds', async ({ page }) => {
  await beginExam(page)
  const clock = page.getByRole('timer')
  await expect(clock).toBeVisible()

  // The visible clock must not be wired to announce itself.
  await expect(clock, 'a per-second live region would drown out the paper').toHaveAttribute(
    'aria-live',
    'off'
  )
  const digitsHidden = await page.evaluate(() => {
    const timer = document.querySelector('[role="timer"]')
    if (!timer) return false
    // Either the timer itself or the element carrying the digits is hidden
    // from assistive tech — what matters is that the changing number is not
    // exposed as readable, changing content.
    if (timer.getAttribute('aria-hidden') === 'true') return true
    return Array.from(timer.querySelectorAll('*')).some(
      (n) => n.getAttribute('aria-hidden') === 'true' && /\d/.test(n.textContent ?? '')
    )
  })
  expect(digitsHidden, 'the ticking digits must be aria-hidden').toBe(true)

  // Ten minutes and a couple of seconds left: the 10-minute gate is imminent.
  await rewindExamClock(page, 10 * 60_000 + 2_500)

  await expect
    .poll(async () => liveRegionText(page, 'polite'), { timeout: 15_000 })
    .toMatch(/10 minutes remaining/i)

  // …and having said it once, it does not say it again, nor start reading the
  // clock. Three seconds is three ticks; the announcement must not churn.
  const settled = await liveRegionText(page, 'polite')
  await page.waitForTimeout(3_000)
  expect(
    await liveRegionText(page, 'polite'),
    'a re-render must not re-announce the same threshold'
  ).toBe(settled)

  // Expiry: the paper submits itself, and that is announced assertively.
  await rewindExamClock(page, 2_000)
  await expect
    .poll(async () => liveRegionText(page, 'assertive'), { timeout: 15_000 })
    .toMatch(/time is up.*submitted/i)
  await expect(page.getByRole('region', { name: /question review/i })).toBeVisible()
})

// ── 10. exam review mode is reachable by keyboard ──────────────────────────

/**
 * WCAG 2.1.1 — audit finding 18.
 *
 * Review-mode options used to be `disabled`, which takes them out of the tab
 * order entirely: a keyboard-only candidate could not read back their own
 * answers. They must stay focusable (aria-disabled, not disabled) and their
 * state must be readable without seeing the colour (1.4.1).
 */
test('review-mode exam options stay focusable and state their verdict in text', async ({
  page,
}) => {
  await beginExam(page)

  // Answer whatever question 1 offers, then submit — the shortest path to a
  // graded paper; the review lists every question either way.
  const options = page.locator('[role="radio"], [role="checkbox"]')
  if ((await options.count()) > 0) {
    await options.first().click()
  } else {
    await page.getByLabel('Your answer').fill('0.5')
  }
  await page.getByRole('button', { name: /^Submit exam$/ }).click()
  await page.getByRole('button', { name: /yes, submit and grade/i }).click()

  const review = page.getByRole('region', { name: /question review/i })
  await expect(review).toBeVisible()

  const reviewed = review.locator('[role="radio"], [role="checkbox"]')
  await expect.poll(async () => reviewed.count()).toBeGreaterThan(0)

  const first = reviewed.first()
  // `disabled` would make this impossible — a disabled button cannot take focus.
  await first.focus()
  await expect(first, 'a reviewed option must be reachable by keyboard').toBeFocused()
  await expect(first, 'and announced as unavailable rather than removed').toHaveAttribute(
    'aria-disabled',
    'true'
  )

  // 1.4.1: the verdict is carried by hue and a ✓/✗ glyph, both invisible to a
  // screen reader. Every reviewed option must also say it.
  const names = await reviewed.evaluateAll((nodes) =>
    nodes.map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
  )
  for (const name of names) {
    expect(name, 'a reviewed option with no spoken verdict').toMatch(
      /(your answer\. (correct|incorrect))|(you did not choose this)/i
    )
  }
})

// ── 11. the circuit editor is one tab stop with an arrow-key cursor ────────

/** Role, aria-label and id of whatever currently holds focus. */
async function focusedCell(page: Page): Promise<{ role: string; label: string }> {
  return page.evaluate(() => {
    const el = document.activeElement
    return {
      role: el?.getAttribute('role') ?? '',
      label: el?.getAttribute('aria-label') ?? '',
    }
  })
}

/** Gate count as the editor itself reports it in the SVG's accessible name. */
async function gateCount(page: Page): Promise<number> {
  const label = await page.getByRole('group', { name: /quantum circuit/i }).getAttribute('aria-label')
  const match = /and (\d+) gates?/.exec(label ?? '')
  return match ? Number(match[1]) : -1
}

/**
 * WCAG 2.4.3 / 2.1.1 — audit §2's remaining caveat, and §5c.
 *
 * The editor was operable but linear: one tab stop per wire plus one per placed
 * gate, so a 30-gate circuit was 30 extra stops. A grid widget is one stop with
 * an arrow-key cursor, and each cell says where it is and what is on it.
 */
test('the circuit editor is a single tab stop with an arrow-key grid cursor', async ({ page }) => {
  await goto(page, '/simulator')

  // role="group", not role="img" — see the note on circuitSvg in helpers.ts.
  // role="img" flattened the subtree and hid the very grid this test checks.
  const svg = page.getByRole('group', { name: /quantum circuit/i })
  await expect(svg).toBeVisible()

  const tabbable = await page.$$eval('svg [tabindex]:not([tabindex="-1"])', (nodes) => nodes.length)
  expect(tabbable, 'the whole grid must be exactly one tab stop').toBe(1)

  await page.getByRole('button', { name: /^H gate$/i }).click()

  // Entering the grid lands on the cursor cell, which names its own position.
  await page.locator('svg [role="gridcell"][tabindex="0"]').focus()
  let cell = await focusedCell(page)
  expect(cell.role, 'the grid cursor must be a gridcell').toBe('gridcell')
  expect(cell.label).toMatch(/qubit 0, column 1/i)

  // Arrows move between wires and columns.
  await page.keyboard.press('ArrowDown')
  cell = await focusedCell(page)
  expect(cell.label, 'ArrowDown must move to the next wire').toMatch(/qubit 1, column 1/i)

  await page.keyboard.press('ArrowRight')
  expect((await focusedCell(page)).label, 'ArrowRight must move a column').toMatch(
    /qubit 1, column 2/i
  )

  await page.keyboard.press('Home')
  expect((await focusedCell(page)).label, 'Home must return to the first column').toMatch(
    /qubit 1, column 1/i
  )

  // Enter places the selected gate on this wire…
  const before = await gateCount(page)
  await page.keyboard.press('Enter')
  await expect.poll(async () => gateCount(page)).toBe(before + 1)
  await expect(page.locator('pre').first()).toContainText('h q[1];')

  // …and the cell now describes what is on it, not just where it is.
  expect((await focusedCell(page)).label, 'an occupied cell must name its gate').toMatch(
    /qubit 1, column 1.*h gate.*press enter to remove/i
  )

  // Delete removes it again, without ever leaving the grid.
  await page.keyboard.press('Delete')
  await expect.poll(async () => gateCount(page)).toBe(before)
  expect((await focusedCell(page)).role, 'focus must stay on the grid cursor').toBe('gridcell')
})

// ═══════════════════════════════════════════════════════════════════════════
//  SECOND PASS — /hardware, /insights, /account, /circuits, /coach
//
//  Each test below failed against the build that shipped before its fix. The
//  numbers quoted in the comments were measured on that build, not estimated.
// ═══════════════════════════════════════════════════════════════════════════

// ── 12. the hardware paywall ───────────────────────────────────────────────

/**
 * Two device rows, one available and one not, so the picker renders at all.
 *
 * `/api/hardware/devices` proxies the Python service, which is not running in
 * CI. Stubbing the same-origin route is the only way to exercise DevicePicker
 * and CostEstimate — and it is a fair stand-in, because the route is a pure
 * pass-through (see app/api/hardware/devices/route.ts).
 */
const STUB_DEVICES = [
  {
    id: 'aer_simulator',
    name: 'Aer Simulator',
    provider: 'ibm',
    technology: 'simulator',
    qubits: 32,
    available: true,
    pending_jobs: null,
    source: 'catalogue',
    note: null,
    reason: null,
  },
  {
    id: 'ionq_aria_1',
    name: 'IonQ Aria-1',
    provider: 'aws',
    technology: 'trapped-ion',
    qubits: 25,
    available: false,
    pending_jobs: 3,
    source: 'catalogue',
    note: 'Trapped-ion device.',
    reason: 'Needs AWS credentials on the service.',
  },
]

const STUB_ESTIMATE = {
  backend: 'aer_simulator',
  shots: 1000,
  per_shot: 0.0003,
  task_fee: 0.3,
  estimated_total: 0.6,
  currency: 'USD',
  is_free: false,
  note: 'Indicative published rates, not a quote.',
}

async function stubHardwareApi(page: Page): Promise<void> {
  await page.route('**/api/hardware/devices*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STUB_DEVICES),
    })
  )
  await page.route('**/api/hardware/estimate*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STUB_ESTIMATE),
    })
  )
}

/**
 * WCAG 4.1.2 / 2.4.3 — the upgrade gate swallowed focus.
 *
 * `UpgradeGate mode="overlay"` drew the locked content behind a blur with
 * `aria-hidden="true"` and `pointer-events-none`. That combination is a defect,
 * not a fix: pointer-events only stops the mouse. On the shipped build this
 * measured **9 focusable elements inside the aria-hidden subtree** on
 * /hardware — the circuit preset buttons, the shots control and the submit
 * button. A keyboard user tabbed into them and a screen reader announced
 * nothing, because aria-hidden on focusable content produces exactly that:
 * focus on an element that is not in the accessibility tree.
 *
 * The fix is `inert`, which removes focus, pointer events and the a11y tree
 * together. If someone ever swaps it back for aria-hidden alone, this fails.
 */
test('the hardware upgrade overlay is inert, not merely aria-hidden', async ({ page }) => {
  await stubHardwareApi(page)
  await goto(page, '/hardware')

  // Precondition only — deliberately matched on the heading, which predates
  // this pass, so this test fails on the inert assertion below rather than on
  // the named region that the same fix introduced.
  const lock = page.getByRole('heading', { name: /a pro feature/i })
  await expect(lock, 'the hardware page must be gated in this deployment').toBeVisible()

  // The stubbed device list has to have landed before this is measured, or the
  // subtree is half-built and the probe below is weaker than it looks.
  await expect(page.locator('[role="radio"]').first()).toBeAttached()

  const probe = await page.evaluate(() => {
    const hidden = document.querySelector<HTMLElement>('[aria-hidden="true"].pointer-events-none')
    if (!hidden) return null
    const candidates = Array.from(
      hidden.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    )
    // The controls still EXIST — the whole point of the overlay is that the
    // locked page is visible behind the blur — so counting them proves nothing.
    // What must be true is that none of them can take focus. `inert` is what
    // makes .focus() a no-op; aria-hidden + pointer-events-none never did.
    const focusable = candidates.filter((el) => {
      el.focus()
      return document.activeElement === el
    })
    return {
      inert: hidden.inert === true,
      candidateCount: candidates.length,
      focusableCount: focusable.length,
    }
  })

  expect(probe, 'the overlay wrapper must exist').not.toBeNull()
  expect(probe?.inert, 'the blurred subtree must be inert').toBe(true)
  expect(
    probe?.candidateCount,
    'the locked page must still be rendered behind the blur, or this proves nothing'
  ).toBeGreaterThan(0)
  expect(
    probe?.focusableCount,
    'no control behind the paywall may accept focus'
  ).toBe(0)

  // And prove it from the keyboard rather than only from the attribute: 40 tab
  // presses must never land inside the hidden subtree.
  const strays: string[] = []
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab')
    const stray = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const hidden = el.closest('[aria-hidden="true"]')
      return hidden ? `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"` : null
    })
    if (stray) strays.push(stray)
  }
  expect(strays, 'tab order must not enter the paywalled subtree').toEqual([])
})

/**
 * WCAG 4.1.3 — a paywall that appears without saying why.
 *
 * UpgradeGate renders the real content while the entitlement is still loading
 * (deliberately — flashing a lock at a paying customer is worse), then swaps it
 * for the lock when the answer comes back. A sighted user watches that happen.
 * Before this fix a screen-reader user reading /hardware simply found the
 * content replaced mid-page with nothing announced.
 */
test('the paywall announces why the content stopped', async ({ page }) => {
  await stubHardwareApi(page)
  await goto(page, '/hardware')

  await expect
    .poll(async () => liveRegionText(page, 'polite'), { timeout: 15_000 })
    .toMatch(/pro feature.*running on real quantum hardware/is)
})

/**
 * WCAG 2.1.1 / 4.1.2 — the device picker.
 *
 * Two defects, both measured on the shipped build:
 *
 *  1. Unavailable devices were `disabled`, so they were not in the tab order at
 *     all. `device.reason` — "Needs AWS credentials on the service", the single
 *     most useful sentence on the page — was unreachable by keyboard. This is
 *     the same defect the exam's review mode had (audit finding 18) and it gets
 *     the same fix: `aria-disabled`, which announces the state without removing
 *     the control.
 *  2. `role="radiogroup"` with every radio tabbable is not a radiogroup. The
 *     WAI-ARIA pattern is one tab stop plus arrow keys, which is also what the
 *     circuit editor's grid does (§5c of docs/ACCESSIBILITY.md).
 */
test('unavailable hardware devices stay reachable and the radiogroup roves', async ({ page }) => {
  await stubHardwareApi(page)
  await goto(page, '/hardware')

  // The picker only exists once the stubbed catalogue has been fetched; reading
  // the DOM straight after load raced it and measured an empty list.
  await expect(page.locator('[role="radio"]')).toHaveCount(2)

  const radios = await page.$$eval('[role="radio"]', (nodes) =>
    nodes.map((n) => ({
      name: (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
      nativelyDisabled: (n as HTMLButtonElement).disabled,
      ariaDisabled: n.getAttribute('aria-disabled'),
      tabIndex: n.getAttribute('tabindex'),
    }))
  )

  expect(radios.length, 'both stub devices must render as radios').toBe(2)

  const unavailable = radios.find((r) => /IonQ Aria-1/.test(r.name))
  expect(unavailable, 'the unavailable device must still be rendered').toBeTruthy()
  expect(
    unavailable?.nativelyDisabled,
    '`disabled` removes the explanation from the keyboard entirely'
  ).toBe(false)
  expect(unavailable?.ariaDisabled, 'it must still announce as unavailable').toBe('true')
  expect(
    unavailable?.name,
    'and the reason it is unavailable must be part of what is read'
  ).toMatch(/needs aws credentials/i)

  // Roving tabindex: exactly one option carries tabindex="0".
  const entryPoints = radios.filter((r) => r.tabIndex === '0').length
  expect(entryPoints, 'a radiogroup is one tab stop, not one per option').toBe(1)
  expect(
    radios.filter((r) => r.tabIndex === '-1').length,
    'every other option must be removed from the tab order, not left unset'
  ).toBe(radios.length - 1)
})

/**
 * WCAG 4.1.3 — the cost estimate is the one number denominated in the user's
 * own money, and it is repriced by two controls that live elsewhere on the
 * page. On the shipped build, rendering `$0.60 USD` left the polite live region
 * completely empty — verified by reading `[data-a11y-live="polite"]` after the
 * estimate had painted.
 */
test('the hardware cost estimate is announced when it settles', async ({ page }) => {
  await stubHardwareApi(page)
  await goto(page, '/hardware')

  // The price is on screen…
  await expect(page.getByText('Estimated cost', { exact: true })).toBeVisible()

  // …and it was also said out loud, with the currency and the shot count, so
  // the figure is not ambiguous.
  await expect
    .poll(async () => liveRegionText(page, 'polite'), { timeout: 15_000 })
    .toMatch(/estimated cost.*\$0\.60 USD for 1,000 shots/i)
})

/**
 * NOT FIXED — recorded rather than quietly skipped.
 *
 * JobMonitor now announces every status transition (queued → running →
 * done/error/cancelled) and every recoverable poll failure, which is the
 * biggest 4.1.3 defect this pass found: a job that costs real money changed
 * state silently for hours. That fix is NOT covered by a running test, because
 * reaching JobMonitor needs all three of a Supabase session, a Pro entitlement
 * and a live `services/api` — `/api/hardware/submit` is authenticated, quota'd
 * and forwards to the Python service, none of which exists in CI.
 *
 * TO RE-ENABLE: give the suite a signed-in Pro fixture (the same thing the
 * certification and org tests will need) and stub `/api/hardware/submit` and
 * `/api/hardware/job/*` the way stubHardwareApi() stubs the catalogue. Then
 * assert the polite region moves "Job queued" → "Job running" → "Job complete…
 * shots measured", and that a re-render with an unchanged status adds nothing.
 */
test.fixme('the job monitor announces every status transition', async ({ page }) => {
  await goto(page, '/hardware')
  await expect
    .poll(async () => liveRegionText(page, 'polite'))
    .toMatch(/job (queued|running|complete)/i)
})

// ── 13. destructive actions on /circuits ───────────────────────────────────

/**
 * WCAG 3.3.4 / 4.1.3 — the two-press delete confirm was invisible.
 *
 * The only signal that the first press had armed the confirm was the button's
 * visible text changing "✕" → "Sure?" — and the button carried a STATIC
 * `aria-label="Delete <name>"`, which wins over content, so the accessible name
 * never changed at all and nothing was announced. A screen-reader user pressed
 * a button labelled "Delete Bell state", heard nothing, pressed it again to
 * check, and lost the circuit. The arming also expires after 3 seconds, which
 * was likewise unannounced.
 */
test('the circuit delete confirm changes its accessible name and says so', async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString()
    window.localStorage.setItem(
      'quantum-lab.circuits',
      JSON.stringify([
        {
          id: 'a11y-fixture',
          name: 'A11y fixture circuit',
          description: 'Seeded by tests/e2e/a11y.spec.ts.',
          qasm: 'OPENQASM 3;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n',
          numQubits: 2,
          createdAt: now,
          updatedAt: now,
        },
      ])
    )
  })
  await goto(page, '/circuits')

  const remove = page.getByRole('button', { name: /^Delete A11y fixture circuit$/ })
  await expect(remove, 'the seeded circuit must render with a delete button').toBeVisible()

  await remove.click()

  // The name itself must carry the new state — not just the visible glyph.
  await expect(
    page.getByRole('button', { name: /confirm deleting A11y fixture circuit/i }),
    'arming a destructive confirm must change the accessible name'
  ).toBeVisible()

  await expect
    .poll(async () => liveRegionText(page, 'polite'), { timeout: 10_000 })
    .toMatch(/press the button again within 3 seconds to confirm/i)
})

// ── 14. /insights — Label in Name, and the switch's consequences ───────────

/**
 * WCAG 2.5.3 Label in Name (Level A).
 *
 * The analytics switch carried `aria-label="Record analytics in this browser"`,
 * which REPLACES the accessible name rather than adding to it. Its visible text
 * is "Analytics on" / "Analytics off", so the visible label appeared nowhere in
 * the accessible name and a voice-control user saying "click Analytics on" hit
 * nothing at all. The context belongs in aria-describedby, which is announced
 * after the name instead of instead of it.
 */
test('the analytics switch name contains its visible label', async ({ page }) => {
  await goto(page, '/insights')

  const probe = await page.evaluate(() => {
    const sw = document.querySelector('[role="switch"]')
    if (!sw) return null
    const describedBy = (sw.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    return {
      visible: (sw.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ariaLabel: sw.getAttribute('aria-label'),
      describedBy: describedBy.replace(/\s+/g, ' ').trim(),
    }
  })

  expect(probe, 'the analytics switch must exist on /insights').not.toBeNull()
  expect(probe?.visible, 'the switch must have visible text').toMatch(/analytics (on|off)/i)

  // The accessible name is the content unless aria-label overrides it, so the
  // only way 2.5.3 holds here is for there to be no overriding aria-label.
  const name = probe?.ariaLabel ?? probe?.visible ?? ''
  expect(
    name.toLowerCase(),
    'the accessible name must contain the visible label (WCAG 2.5.3)'
  ).toContain((probe?.visible ?? '').toLowerCase())

  expect(
    probe?.describedBy,
    'the extra context must move to a description rather than be dropped'
  ).toMatch(/record analytics in this browser/i)
})

/**
 * WCAG 4.1.3 — "Generate sample data" replaces an empty state with six stat
 * tiles, two line charts and a histogram. None of that is in a live region, and
 * focus stays on a button that has just disappeared, so on the shipped build a
 * screen-reader user pressed it and the page went silent.
 */
test('generating sample analytics announces that the dashboard filled in', async ({ page }) => {
  await page.addInitScript(() => {
    // Start from a genuinely empty dashboard so the button is rendered.
    window.localStorage.removeItem('quantum-lab.analytics')
  })
  await goto(page, '/insights')

  const generate = page.getByRole('button', { name: /generate sample data/i })
  if ((await generate.count()) === 0) {
    // The buffer already had events; clear them through the product's own
    // control rather than asserting against a state the page is not in.
    const del = page.getByRole('button', { name: /delete all analytics/i })
    await del.click()
    await page.getByRole('button', { name: /click again to confirm/i }).click()
  }

  await page.getByRole('button', { name: /generate sample data/i }).click()

  await expect
    .poll(async () => liveRegionText(page, 'polite'), { timeout: 10_000 })
    .toMatch(/sample data generated/i)
})

// ── 15. /coach — sr-only must never be focusable-and-invisible ─────────────

/**
 * WCAG 2.4.7 Focus Visible (AA).
 *
 * SkillMap's SVG is `role="img"`, so it exposes a text-equivalent list of the
 * ten concepts as real links. That list was wrapped in `sr-only` — which clips
 * it to a 1px box — while the links inside stayed focusable. A sighted keyboard
 * user tabbing down /coach therefore lost the focus ring for ten consecutive
 * stops with nothing moving on screen.
 *
 * The 25-tab-stop check above does NOT catch this: it accepts a UA `outline:
 * auto` as evidence, and a clipped element still reports one. This walks the
 * ancestor chain for a clipping container instead, which is the thing that
 * actually decides whether a human can see the ring.
 */
test('focused links inside the skill map are not visually clipped', async ({ page }) => {
  await goto(page, '/coach')

  const clipped = await page.$$eval('a[href^="/learn/"]', (nodes) => {
    /** True when `el` or any ancestor hides it with the sr-only recipe. */
    const hiddenByClip = (el: Element): boolean => {
      let node: Element | null = el
      while (node && node !== document.body) {
        const cs = getComputedStyle(node)
        const clipPath = cs.clipPath
        const clip = cs.clip
        if (clipPath.includes('inset(50%)')) return true
        if (clip.replace(/\s|,/g, '') === 'rect(0px0px0px0px)') return true
        node = node.parentElement
      }
      return false
    }

    const bad: string[] = []
    for (const link of nodes) {
      ;(link as HTMLElement).focus()
      if (document.activeElement !== link) continue // not focusable, fine
      if (hiddenByClip(link)) {
        bad.push((link.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48))
      }
    }
    return bad
  })

  expect(
    clipped,
    'a focusable link must become visible when it takes focus — sr-only is only safe on content that cannot be focused'
  ).toEqual([])
})

// ── 16. billing outcomes are spoken ────────────────────────────────────────

/**
 * WCAG 4.1.3 — pressing a checkout CTA either navigates to Stripe or renders a
 * paragraph explaining why it did not, with focus still on the button. Before
 * this fix that paragraph had no live role, so a screen-reader user pressed
 * "Upgrade to Pro", the page appeared inert, and the explanation ("billing is
 * not configured in this environment") sat on screen unread. The button's own
 * label going "Redirecting…" → "Upgrade to Pro" is not a substitute — that
 * reads as the action having been undone.
 */
test('a checkout outcome is announced, not just rendered', async ({ page }) => {
  await goto(page, '/pricing')

  const upgrade = page.getByRole('button', { name: /^Upgrade to Pro$/ })
  await expect(upgrade).toBeVisible()
  await upgrade.click()

  const outcome = page.locator('[role="status"], [role="alert"]').filter({
    hasText: /billing|checkout|paid plans|available for purchase/i,
  })
  await expect(
    outcome.first(),
    'the reason a checkout did not happen must be in a live region'
  ).toBeVisible({ timeout: 15_000 })
})

// ── 17. /coach — choosing a goal re-ranks the page silently ────────────────

/**
 * WCAG 4.1.3.
 *
 * The goal chips are the only control on /coach, and their entire effect is on
 * three cards further down the page. `aria-pressed` flips on the chip, which
 * says "this chip is on" and nothing about the recommendations that just
 * changed — on the shipped build the polite region stayed empty after a chip
 * press, so a screen-reader user had no way to know the page had responded
 * short of navigating the whole document again.
 */
test('choosing a coach goal announces the re-ranked recommendation', async ({ page }) => {
  await goto(page, '/coach')

  const chip = page.getByRole('button', { name: /get to grover/i })
  await expect(chip, 'the goal chips must be rendered').toBeVisible()
  await chip.click()

  await expect(chip, 'the chip itself must report its own state').toHaveAttribute(
    'aria-pressed',
    'true'
  )

  await expect
    .poll(async () => liveRegionText(page, 'polite'), { timeout: 10_000 })
    .toMatch(/goal set to get to grover/i)
})
