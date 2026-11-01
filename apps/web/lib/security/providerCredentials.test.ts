/**
 * Tests for BYOK credential storage.
 *
 * This module holds RECOVERABLE vendor credentials, which makes it the most
 * dangerous store in the codebase: every other secret here is hashed and
 * therefore useless to whoever reads the table. So these tests are about what
 * must never happen — a plaintext secret reaching the database, a secret
 * reaching a client, a decryption failure passing as a working credential —
 * rather than about the happy path, which is three lines.
 *
 * The SECRET/PUBLIC SPLIT gets its own attention. Only IBM has a one-field
 * credential; AWS and Azure are several fields of which only some authorise
 * anything, and getting that split wrong fails in both directions: sealing an
 * identifier makes the listing useless, and storing a secret in the clear is
 * the bug this whole module exists to prevent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Supabase double ─────────────────────────────────────────────────────────
//
// Same shape as lib/security/apiKeys.test.ts: a recorder that collects the
// payload and the filters so a test can assert on what would have been WRITTEN,
// which is the only place "was it sealed?" is observable.

interface Recorded {
  table: string
  op: string
  filters: [string, unknown][]
  payload?: Record<string, unknown>
}

let recorded: Recorded[] = []
let nextResult: { data: unknown; error: { message: string } | null } = { data: null, error: null }

function chain(entry: Recorded) {
  const api: Record<string, unknown> = {}
  const self = () => api
  api.eq = (col: string, val: unknown) => {
    entry.filters.push([col, val])
    return api
  }
  api.order = self
  api.limit = self
  api.select = self
  api.single = () => Promise.resolve(nextResult)
  api.maybeSingle = () => Promise.resolve(nextResult)
  api.then = (resolve: (v: typeof nextResult) => unknown) => resolve(nextResult)
  return api
}

vi.mock('@/lib/billing/entitlements', () => ({
  isServiceRoleConfigured: true,
  getServiceSupabase: () => ({
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        const entry: Recorded = { table, op: 'insert', filters: [], payload }
        recorded.push(entry)
        return chain(entry)
      },
      upsert: (payload: Record<string, unknown>) => {
        const entry: Recorded = { table, op: 'upsert', filters: [], payload }
        recorded.push(entry)
        return chain(entry)
      },
      update: (payload: Record<string, unknown>) => {
        const entry: Recorded = { table, op: 'update', filters: [], payload }
        recorded.push(entry)
        return chain(entry)
      },
      delete: () => {
        const entry: Recorded = { table, op: 'delete', filters: [] }
        recorded.push(entry)
        return chain(entry)
      },
      select: (columns: string) => {
        const entry: Recorded = { table, op: 'select', filters: [], payload: { columns } }
        recorded.push(entry)
        return chain(entry)
      },
    }),
  }),
}))

import { isSealed, open, seal } from '@/lib/platform/secretBox'
import {
  BYOK_PROVIDERS,
  PROVIDER_FIELDS,
  byokConfigured,
  deleteProviderCredential,
  isByokProvider,
  listProviderCredentials,
  maskToken,
  resolveProviderCredential,
  saveProviderCredential,
  splitCredentialFields,
} from '@/lib/security/providerCredentials'

const USER = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'ibm-token-0123456789abcdef8f2c'

const BRAKET_FIELDS = {
  access_key_id: 'AKIAEXAMPLEEXAMPLE00',
  secret_access_key: 'aws-secret-access-key-abcd',
  region: 'us-east-1',
  s3_bucket: 'my-braket-results',
}

const AZURE_FIELDS = {
  resource_id:
    '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Quantum/Workspaces/ws',
  location: 'eastus',
  tenant_id: '11111111-1111-1111-1111-111111111111',
  client_id: '22222222-2222-2222-2222-222222222222',
  client_secret: 'azure-client-secret-abcd',
}

/** A stored row, as the database would hand it back. */
function row(provider: string, secrets: Record<string, string>, publicConfig: Record<string, string>) {
  return {
    provider,
    hint: '····abcd',
    public_config: publicConfig,
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
    last_used_at: null,
    secret: seal(JSON.stringify(secrets)),
  }
}

beforeEach(() => {
  recorded = []
  nextResult = { data: null, error: null }
  // `secretBox` derives a key from SUPABASE_SERVICE_ROLE_KEY when this is
  // unset, and the entitlements double above claims the service role is
  // configured, so the two halves have to agree or every test here is an
  // outage test.
  process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)
})

describe('maskToken', () => {
  it('shows the END of the secret, not the beginning', () => {
    // Vendor credentials frequently share a fixed prefix. Masking from the
    // front would make every user's hint identical and the feature pointless.
    expect(maskToken(TOKEN)).toBe('····8f2c')
  })

  it('reveals no more than four characters', () => {
    const masked = maskToken(TOKEN)
    expect(masked.replace(/·/g, '')).toHaveLength(4)
  })
})

describe('isByokProvider', () => {
  it('accepts every provider the submit path can actually present', () => {
    expect(isByokProvider('ibm')).toBe(true)
    expect(isByokProvider('braket')).toBe(true)
    expect(isByokProvider('azure')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isByokProvider('ionq')).toBe(false)
    expect(isByokProvider('')).toBe(false)
    expect(isByokProvider(null)).toBe(false)
  })

  it('agrees with the exported provider list', () => {
    for (const provider of BYOK_PROVIDERS) expect(isByokProvider(provider)).toBe(true)
  })
})

describe('the secret/public split', () => {
  // The non-obvious half of this feature. An AWS access key id is an
  // identifier, like a username; the secret access key is what authorises.
  // Sealing the id would make "which account is attached?" unanswerable, and
  // NOT sealing the secret key would be the bug this module exists to prevent.
  it('treats an AWS access key id as public and the secret key as secret', () => {
    const split = splitCredentialFields('braket', BRAKET_FIELDS)

    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.secrets).toHaveProperty('secret_access_key')
    expect(split.secrets).not.toHaveProperty('access_key_id')
    expect(split.publicConfig.access_key_id).toBe('AKIAEXAMPLEEXAMPLE00')
    expect(split.publicConfig.region).toBe('us-east-1')
  })

  it('treats Azure tenant and client ids as public, and only the client secret as secret', () => {
    const split = splitCredentialFields('azure', AZURE_FIELDS)

    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(Object.keys(split.secrets)).toEqual(['client_secret'])
    expect(split.publicConfig.tenant_id).toBe(AZURE_FIELDS.tenant_id)
    expect(split.publicConfig.client_id).toBe(AZURE_FIELDS.client_id)
  })

  it('never lets a field appear in both halves', () => {
    for (const provider of BYOK_PROVIDERS) {
      const fields = PROVIDER_FIELDS[provider]
      const secretNames = fields.filter((f) => f.secret).map((f) => f.name)
      const publicNames = fields.filter((f) => !f.secret).map((f) => f.name)
      expect(secretNames.filter((n) => publicNames.includes(n))).toEqual([])
    }
  })

  it('refuses a missing required field, naming it', () => {
    const missing = { ...BRAKET_FIELDS, s3_bucket: '' }
    const split = splitCredentialFields('braket', missing)

    expect(split.ok).toBe(false)
    if (split.ok) return
    // Braket refuses a task with no result destination, so catching it here
    // beats an opaque AWS rejection minutes later.
    expect(split.error).toContain('S3 bucket')
  })

  it('allows an optional field to be omitted', () => {
    const split = splitCredentialFields('ibm', { token: TOKEN })

    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.publicConfig).not.toHaveProperty('instance')
  })
})

describe('public field shapes', () => {
  const bad = (provider: 'ibm' | 'braket' | 'azure', fields: Record<string, string>, label: string) => {
    const split = splitCredentialFields(provider, fields)
    expect(split.ok).toBe(false)
    if (split.ok) return
    expect(split.error).toContain(label)
    // The offending value is never echoed back.
    for (const v of Object.values(fields)) {
      if (v.includes('/') && v.includes('?')) expect(split.error).not.toContain(v)
    }
  }

  it('accepts a well-formed credential for every provider', () => {
    expect(splitCredentialFields('azure', AZURE_FIELDS).ok).toBe(true)
    expect(splitCredentialFields('braket', BRAKET_FIELDS).ok).toBe(true)
    expect(
      splitCredentialFields('ibm', {
        token: TOKEN,
        instance: 'crn:v1:bluemix:public:quantum-computing:us-east:a/0123abcd:aaaa-bbbb::',
      }).ok
    ).toBe(true)
    expect(splitCredentialFields('braket', { ...BRAKET_FIELDS, s3_prefix: 'team/run-1.d' }).ok).toBe(true)
    expect(splitCredentialFields('braket', { ...BRAKET_FIELDS, region: 'ap-southeast-2' }).ok).toBe(true)
  })

  it('refuses an Azure location that could redirect the SDK request', () => {
    for (const location of ['internal.host.example/x?', 'a@evil.example', 'east:443', 'x#y', 'ea', 'eastus.evil']) {
      bad('azure', { ...AZURE_FIELDS, location }, 'Workspace region')
    }
  })

  it('folds an Azure or AWS region to lower case rather than refusing it', () => {
    const az = splitCredentialFields('azure', { ...AZURE_FIELDS, location: 'EastUS' })
    expect(az.ok && az.publicConfig.location).toBe('eastus')
    const aws = splitCredentialFields('braket', { ...BRAKET_FIELDS, region: 'US-East-1' })
    expect(aws.ok && aws.publicConfig.region).toBe('us-east-1')
  })

  it('requires GUIDs for the tenant and client ids', () => {
    bad('azure', { ...AZURE_FIELDS, tenant_id: 'contoso/../x' }, 'Directory (tenant) ID')
    bad('azure', { ...AZURE_FIELDS, client_id: 'not-a-guid' }, 'Application (client) ID')
  })

  it('requires the full workspace resource id', () => {
    bad('azure', { ...AZURE_FIELDS, resource_id: '/subscriptions/x' }, 'Workspace resource ID')
    bad(
      'azure',
      { ...AZURE_FIELDS, resource_id: 'https://evil.example/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Quantum/Workspaces/ws' },
      'Workspace resource ID'
    )
    bad(
      'azure',
      { ...AZURE_FIELDS, resource_id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Quantum/Workspaces/ws?x=1' },
      'Workspace resource ID'
    )
  })

  it('refuses a malformed AWS region, bucket, prefix or access key id', () => {
    bad('braket', { ...BRAKET_FIELDS, region: 'us-east-1/evil' }, 'AWS region')
    bad('braket', { ...BRAKET_FIELDS, s3_bucket: 'Bad_Bucket' }, 'S3 bucket for results')
    bad('braket', { ...BRAKET_FIELDS, s3_bucket: 'a..b' }, 'S3 bucket for results')
    bad('braket', { ...BRAKET_FIELDS, s3_bucket: 'bucket/../x' }, 'S3 bucket for results')
    bad('braket', { ...BRAKET_FIELDS, s3_prefix: '../../x' }, 'S3 key prefix')
    bad('braket', { ...BRAKET_FIELDS, access_key_id: 'akia-lowercase' }, 'AWS access key ID')
  })

  it('refuses an IBM instance containing URL metacharacters', () => {
    bad('ibm', { token: TOKEN, instance: 'crn:x@evil.example/?q' }, 'Instance CRN')
  })
})

describe('saveProviderCredential', () => {
  it('NEVER writes a plaintext secret', async () => {
    // The single most important assertion in this file. A regression here puts
    // live vendor credentials in a database dump.
    nextResult = { data: row('braket', { secret_access_key: 'x' }, {}), error: null }

    await saveProviderCredential(USER, 'braket', BRAKET_FIELDS)

    const write = recorded.find((r) => r.op === 'upsert')
    expect(write?.table).toBe('user_provider_credentials')
    expect(JSON.stringify(write?.payload)).not.toContain(BRAKET_FIELDS.secret_access_key)
    expect(isSealed(String(write?.payload?.secret))).toBe(true)
  })

  it('writes the identifiers in the clear, where they can be displayed', async () => {
    nextResult = { data: row('braket', { secret_access_key: 'x' }, {}), error: null }

    await saveProviderCredential(USER, 'braket', BRAKET_FIELDS)

    const write = recorded.find((r) => r.op === 'upsert')
    expect(write?.payload?.public_config).toEqual({
      access_key_id: 'AKIAEXAMPLEEXAMPLE00',
      region: 'us-east-1',
      s3_bucket: 'my-braket-results',
    })
  })

  it('seals a JSON object the box can open again', async () => {
    nextResult = { data: row('ibm', { token: TOKEN }, {}), error: null }

    await saveProviderCredential(USER, 'ibm', { token: TOKEN })

    const sealed = String(recorded.find((r) => r.op === 'upsert')?.payload?.secret)
    expect(JSON.parse(open(sealed) as string)).toEqual({ token: TOKEN })
  })

  it('clears last_used_at when a credential is replaced', async () => {
    // The previous credential's usage history is not this one's. A stale stamp
    // would tell the owner something they pasted a minute ago has been in use
    // for weeks.
    nextResult = { data: row('ibm', { token: TOKEN }, {}), error: null }

    await saveProviderCredential(USER, 'ibm', { token: TOKEN })

    expect(recorded.find((r) => r.op === 'upsert')?.payload?.last_used_at).toBeNull()
  })

  it('refuses a secret with whitespace in it rather than storing a bad paste', async () => {
    const outcome = await saveProviderCredential(USER, 'ibm', { token: 'abc def ghijklmno' })

    expect(outcome.ok).toBe(false)
    expect(recorded).toHaveLength(0)
  })

  it('refuses a secret too short to be one, without echoing it', async () => {
    const outcome = await saveProviderCredential(USER, 'ibm', { token: 'nope' })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).not.toContain('nope')
    expect(recorded).toHaveLength(0)
  })
})

describe('listProviderCredentials', () => {
  it('cannot return a secret — only the hint and the identifiers', async () => {
    nextResult = {
      data: [row('azure', { client_secret: AZURE_FIELDS.client_secret }, { location: 'eastus' })],
      error: null,
    }

    const records = await listProviderCredentials(USER)

    expect(records).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain(AZURE_FIELDS.client_secret)
    expect(records[0].publicConfig.location).toBe('eastus')
  })

  it('marks a credential that no longer decrypts as unreadable', async () => {
    // What a rotated SETTINGS_ENCRYPTION_KEY looks like. Without this flag the
    // failure is invisible until a submission quietly runs on the operator's
    // credentials instead.
    nextResult = {
      data: [
        {
          provider: 'ibm',
          hint: '····8f2c',
          public_config: {},
          created_at: 'x',
          updated_at: 'x',
          last_used_at: null,
          secret: 'v1.AAAA.BBBB.CCCC',
        },
      ],
      error: null,
    }

    expect((await listProviderCredentials(USER))[0].readable).toBe(false)
  })

  it('scopes the read to the caller', async () => {
    nextResult = { data: [], error: null }

    await listProviderCredentials(USER)

    expect(recorded[0].filters).toContainEqual(['user_id', USER])
  })
})

describe('resolveProviderCredential', () => {
  it('merges the secret and public halves back into one flat field map', async () => {
    // The flat shape is what `parse_credentials_header` expects upstream.
    nextResult = {
      data: {
        secret: seal(JSON.stringify({ secret_access_key: 'aws-secret-access-key-abcd' })),
        public_config: { access_key_id: 'AKIAEXAMPLEEXAMPLE00', region: 'us-east-1', s3_bucket: 'b' },
      },
      error: null,
    }

    const resolved = await resolveProviderCredential(USER, 'braket')

    expect(resolved).toEqual({
      provider: 'braket',
      fields: {
        access_key_id: 'AKIAEXAMPLEEXAMPLE00',
        region: 'us-east-1',
        s3_bucket: 'b',
        secret_access_key: 'aws-secret-access-key-abcd',
      },
    })
  })

  it('still reads a bare-string envelope as an IBM token', async () => {
    // The first release of this feature sealed IBM's token as a bare string.
    // A row written by it must keep working rather than silently stop
    // presenting a credential the owner believes is attached.
    nextResult = { data: { secret: seal(TOKEN), public_config: { instance: 'crn:x' } }, error: null }

    const resolved = await resolveProviderCredential(USER, 'ibm')

    expect(resolved?.fields.token).toBe(TOKEN)
    expect(resolved?.fields.instance).toBe('crn:x')
  })

  it('answers null when there is no credential, so the caller uses the operator’s', async () => {
    nextResult = { data: null, error: null }

    expect(await resolveProviderCredential(USER, 'ibm')).toBeNull()
  })

  it('answers null — not a broken credential — when the envelope will not open', async () => {
    // Presenting a credential we cannot read is not an option, and refusing
    // the submission outright would take hardware away from a user whose only
    // mistake was that the operator rotated a key.
    nextResult = { data: { secret: 'v1.AAAA.BBBB.CCCC', public_config: {} }, error: null }

    expect(await resolveProviderCredential(USER, 'ibm')).toBeNull()
  })

  it('THROWS when the store itself fails, rather than falling back silently', async () => {
    // The expensive direction. A user who attached their own credential
    // arranged NOT to spend the operator's allowance; spending it because
    // Supabase blinked is an invisible bill.
    nextResult = { data: null, error: { message: 'connection refused' } }

    await expect(resolveProviderCredential(USER, 'ibm')).rejects.toThrow()
  })
})

describe('deleteProviderCredential', () => {
  it('scopes the delete to the caller AND the provider', async () => {
    nextResult = { data: [{ provider: 'ibm' }], error: null }

    expect(await deleteProviderCredential(USER, 'ibm')).toBe(true)
    const del = recorded.find((r) => r.op === 'delete')
    expect(del?.filters).toContainEqual(['user_id', USER])
    expect(del?.filters).toContainEqual(['provider', 'ibm'])
  })

  it('reports false when there was nothing to remove', async () => {
    nextResult = { data: [], error: null }

    expect(await deleteProviderCredential(USER, 'ibm')).toBe(false)
  })
})

describe('byokConfigured', () => {
  it('is false without key material, so a secret is never stored in the clear', () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    expect(byokConfigured()).toBe(false)

    if (saved !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved
  })
})
