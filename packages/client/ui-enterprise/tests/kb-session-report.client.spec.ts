import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportSessionKb } from '../src/client/kb-session-report.ts'
import { readToken } from '../src/client/task-api.ts'

vi.mock('../src/client/task-api.ts', () => ({
  readToken: vi.fn((): string | null => null),
}))

const mockedReadToken = vi.mocked(readToken)

beforeEach(() => {
  mockedReadToken.mockReturnValue('jwt-a')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('reportSessionKb', () => {
  it('posts entries with the employee JWT to the local kb-context route', async () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetcher)

    reportSessionKb([{ sessionId: 's-1', applicationId: 'app-1' }])

    expect(fetcher).toHaveBeenCalledTimes(1)
    const call = fetcher.mock.calls.at(0)
    if (call === undefined) throw new Error('fetch not called')
    const [url, init] = call
    expect(url).toBe('api/enterprise/kb/session-context')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-a')
    expect(init?.body).toBe(JSON.stringify({ entries: [{ sessionId: 's-1', applicationId: 'app-1' }] }))
  })

  it('skips the post without a login', () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetcher)
    mockedReadToken.mockReturnValue(null)

    reportSessionKb([{ sessionId: 's-1', applicationId: null }])

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('swallows transport failures instead of rejecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = vi.fn(() => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', fetcher)

    reportSessionKb([{ sessionId: 's-1', applicationId: 'app-1' }])

    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    warn.mockRestore()
  })
})
