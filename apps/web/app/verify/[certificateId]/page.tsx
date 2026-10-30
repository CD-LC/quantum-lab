import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { lookupCertificate } from '@/lib/exams/service'
import {
  formatCertificateDate,
  linkedInAddToProfileUrl,
  type VerifiedCertificateFacts,
} from '@/lib/certificate'
import { absoluteUrl, pageMetadata } from '@/lib/seo'
import { allowVerifyLookup, decodeCertificateSegment } from './guard'

/**
 * /verify/[certificateId] — the public proof.
 *
 * A server component that calls `lookupCertificate` directly rather than
 * fetching its own API route: same function, same answer, one fewer network
 * hop, and it renders without JavaScript. `/api/exams/verify/<id>` exists
 * alongside it for machine callers and is the thing the tests exercise.
 *
 * ── What is on this page, and why nothing else is ───────────────────────────
 *
 * The name, the exam, the date, and the number. Not the score, not how many
 * times the holder sat it, not the account, not the email. Somebody checking a
 * credential is entitled to know whether the claim is true; they are not
 * entitled to the candidate's exam history, and a verification page that leaks
 * one is a privacy incident waiting for its first HR department.
 *
 * `noIndex` for the same reason: these pages carry a person's name against
 * their result, and they exist to be looked up by number, not found by search.
 *
 * `force-dynamic` because the answer depends on a database row that can be
 * written a second after the page is built.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ certificateId: string }>
}

/**
 * One lookup per request, shared between `generateMetadata` and the page —
 * without `cache` the same certificate row would be read twice per render, and
 * the rate limiter would count the render twice.
 *
 * Returns `null` when the caller has used up the same per-minute allowance the
 * API route enforces; the page renders a "try again shortly" card for that.
 * A segment that is not valid percent-encoding is a 404, not a server error.
 */
const getVerification = cache(
  async (segment: string): Promise<Awaited<ReturnType<typeof lookupCertificate>> | null> => {
    const certificateId = decodeCertificateSegment(segment)
    if (certificateId === null) notFound()
    if (!(await allowVerifyLookup(await headers()))) return null
    return lookupCertificate(certificateId)
  }
)

/**
 * The metadata is derived from the verified record so a pasted link unfurls as
 * the credential it is ("Quantum Foundations Certification — verified") rather
 * than as an opaque number. The og:image comes from the site-wide
 * app/opengraph-image via `metadataBase`, and `noIndex` still applies: link
 * previews work without the page being findable by name in a search engine.
 * The holder's name is deliberately NOT in the description — it is shown to a
 * human who opens the page, not embedded in every unfurl cache on the way.
 */
export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params;
  const result = await getVerification(params.certificateId)
  if (!result) {
    return pageMetadata({
      title: 'Verify a certificate',
      description: 'Verify a Qubit16 certification number.',
      path: '/verify',
      noIndex: true,
    })
  }
  const verified = result.valid && result.examTitle
  return pageMetadata({
    title: verified
      ? `${result.examTitle} — verified certificate`
      : `Certificate ${result.id}`,
    description: verified
      ? `A verified Qubit16 certification, issued ${
          result.issuedAt ? formatCertificateDate(result.issuedAt) : 'on record'
        }. Number ${result.id}.`
      : 'Verify a Qubit16 certification number.',
    path: `/verify/${encodeURIComponent(result.id)}`,
    noIndex: true,
  })
}

export default async function VerifyPage(props: PageProps) {
  const params = await props.params;
  const result = await getVerification(params.certificateId)

  if (!result) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <p className="section-label">Verification</p>
        <section className="card mt-3 border-q-amber/50 p-6 md:p-8" aria-label="Too many lookups">
          <h1 className="section-title text-2xl text-q-amber-text">Try again shortly</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
            There have been a lot of certificate lookups from your connection in the last minute.
            Wait a moment and reload this page. This is not a statement about the certificate.
          </p>
        </section>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/verify" className="btn-ghost focus-ring">
            Check another number
          </Link>
        </div>
      </div>
    )
  }

  // The share affordances need every fact they embed; a valid-but-retired
  // record with no exam title still gets them, named by its catalogue id.
  const facts: VerifiedCertificateFacts | null =
    result.valid && result.name && result.issuedAt
      ? {
          id: result.id,
          name: result.name,
          examTitle: result.examTitle ?? result.examId ?? 'Qubit16 Certification',
          issuedAt: result.issuedAt,
          ...(result.examId ? { examId: result.examId } : {}),
        }
      : null

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <p className="section-label">Verification</p>

      {result.valid ? (
        <section className="card mt-3 border-q-teal/50 p-6 md:p-8" aria-label="Verified certificate">
          <h1 className="section-title text-2xl text-q-teal-text">Certificate verified</h1>
          <dl className="mt-6 space-y-4">
            <Row label="Issued to" value={result.name ?? '—'} />
            <Row label="Certification" value={result.examTitle ?? result.examId ?? '—'} />
            {result.level ? <Row label="Level" value={result.level} /> : null}
            <Row
              label="Date passed"
              value={result.issuedAt ? formatCertificateDate(result.issuedAt) : '—'}
            />
            <Row label="Number" value={result.id} mono />
          </dl>
          {result.reason ? (
            <p className="mt-6 text-[13px] leading-relaxed text-q-amber-text">{result.reason}</p>
          ) : null}
          {facts ? (
            <div className="mt-6 flex flex-wrap gap-3">
              {/* The deep link opens LinkedIn's certification form pre-filled;
                  its certUrl points back at this page, so "Show credential" on
                  the profile lands on the verification itself. */}
              <a
                href={linkedInAddToProfileUrl(facts, absoluteUrl('/'))}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary focus-ring"
              >
                Add to LinkedIn
              </a>
              <a
                href={`/api/certificates/${encodeURIComponent(facts.id)}/badge`}
                className="btn-ghost focus-ring"
              >
                Open Badge (JSON)
              </a>
            </div>
          ) : null}
          <p className="mt-6 border-t border-line pt-4 text-[12px] leading-relaxed text-ink-muted">
            This means Qubit16 graded a timed, server-side attempt at this exam for a signed-in
            account and recorded a pass on the date shown. The name is the one the holder supplied
            when the certificate was issued; we do not check identity documents. The score and the
            number of attempts are not published.
          </p>
        </section>
      ) : (
        <section className="card mt-3 border-q-rose/50 p-6 md:p-8" aria-label="Certificate not verified">
          <h1 className="section-title text-2xl text-q-rose-text">Not verified</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-secondary">{result.reason}</p>
          <p className="mt-4 font-mono text-[13px] text-ink-muted">{result.id}</p>
          <p className="mt-6 border-t border-line pt-4 text-[12px] leading-relaxed text-ink-muted">
            If this number came off a printed certificate, check for a mistyped character and try
            again. Qubit16 certification numbers have eleven characters after the{' '}
            <code>QL-</code> prefix.
          </p>
        </section>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/verify" className="btn-ghost focus-ring">
          Check another number
        </Link>
        <Link href="/certify" className="btn-ghost focus-ring">
          About the certifications
        </Link>
      </div>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-muted">
        {label}
      </dt>
      <dd className={`mt-1 text-lg font-bold text-ink ${mono ? 'font-mono text-base' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
