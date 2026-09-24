import { describe, expect, it } from 'vitest'
import type { PlatformRole, PlatformUserId } from '@deepseek-ai/dsh-platform-user'
import {
  mapPlatformUser,
  readMeResponse,
  readMeUser,
  resolveConfig,
  type MeUser,
} from '../src/index.ts'

const me = (overrides: Partial<MeUser> = {}): MeUser => ({
  id: 'user-1',
  authSubject: 'auth-1',
  loginName: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  status: 'pending_approval',
  platformRoles: [],
  createdAt: '2026-09-21T00:00:00Z',
  createdBy: null,
  approvedAt: null,
  approvedBy: null,
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
  lockedAt: null,
  lockedBy: null,
  lockedReason: null,
  ...overrides,
})

describe('dsh-platform-user-console', () => {
  it('resolves config with defaults, trims trailing slash, and rejects empty fields', () => {
    expect(resolveConfig({ supabaseUrl: 'https://example.supabase.co' })).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      webConsoleBaseUrl: 'http://127.0.0.1:8080',
    })
    expect(resolveConfig({
      supabaseUrl: 'https://example.supabase.co',
      webConsoleBaseUrl: 'http://127.0.0.1:8080/',
    })).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      webConsoleBaseUrl: 'http://127.0.0.1:8080',
    })
    expect(() => resolveConfig({ supabaseUrl: '' })).toThrow('supabaseUrl must be a non-empty string')
    expect(() => resolveConfig({
      supabaseUrl: 'https://example.supabase.co',
      webConsoleBaseUrl: ' ',
    })).toThrow('webConsoleBaseUrl must be a non-empty string')
  })

  it('unwraps the ApiResponse envelope and rejects failures', () => {
    const data = { id: 'user-1' }
    expect(readMeResponse({ success: true, data, error: null })).toEqual(data)
    expect(() => readMeResponse({ success: false, data: null, error: { message: 'denied' } }))
      .toThrow('/api/users/me reported failure')
    expect(() => readMeResponse('not-an-object')).toThrow('response must be an object')
  })

  it('validates and maps a minimal pending user', () => {
    const validated = readMeUser({ ...me(), platformRoles: [], orgUnits: [] })
    expect(mapPlatformUser(validated)).toEqual({
      id: 'user-1' as PlatformUserId,
      authSubject: 'auth-1',
      loginName: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      status: 'pending_approval',
      platformRoles: [],
      createdAt: '2026-09-21T00:00:00Z',
    })
  })

  it('maps an active user with the approval trail', () => {
    const validated = readMeUser(me({
      status: 'active',
      platformRoles: ['normal_user'],
      createdBy: 'admin-1',
      approvedAt: '2026-09-21T01:00:00Z',
      approvedBy: 'admin-1',
    }))
    expect(mapPlatformUser(validated)).toMatchObject({
      status: 'active',
      platformRoles: ['normal_user'],
      createdBy: 'admin-1' as PlatformUserId,
      approvedAt: '2026-09-21T01:00:00Z',
      approvedBy: 'admin-1' as PlatformUserId,
    })
  })

  it('maps a disabled user with the disable trail', () => {
    const validated = readMeUser(me({
      status: 'disabled',
      disabledAt: '2026-09-21T02:00:00Z',
      disabledBy: 'admin-1',
      disabledReason: '离职',
    }))
    expect(mapPlatformUser(validated)).toMatchObject({
      disabledAt: '2026-09-21T02:00:00Z',
      disabledBy: 'admin-1' as PlatformUserId,
      disabledReason: '离职',
    })
  })

  it('rejects unknown status, unknown roles, and malformed fields', () => {
    expect(() => readMeUser(me({ status: 'unknown' as never }))).toThrow('unknown platform user status')
    expect(() => readMeUser(me({ platformRoles: ['boss' as PlatformRole] }))).toThrow('unknown platform role')
    expect(() => readMeUser(me({ authSubject: '' }))).toThrow('must be a non-empty string')
    expect(() => readMeUser(null)).toThrow('platform user not found')
  })

  it('classifies a missing backend record as UNKNOWN_USER', () => {
    const data = readMeResponse({ success: true, data: null, error: null })
    expect(() => mapPlatformUser(readMeUser(data))).toThrow('platform user not found for authenticated subject')
  })
})
