// @vitest-environment node
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUploadTransport, limitUploadRequestRetries } from '../src/utils/upload-transport'
import { UploadStoppedError } from '../src/utils/upload'
const require = createRequire(import.meta.url)
const Client = require('ali-oss/lib/browser/client.js')
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const xml = '<ListBucketResult><Name>synthetic-bucket</Name><IsTruncated>false</IsTruncated></ListBucketResult>'

describe('abortable SDK transport', () => {
  it('bounds the installed SDK clock-skew recursion independently of retryMax', async () => {
    vi.stubGlobal('location', { protocol: 'https:' })
    const fetch = vi.fn().mockImplementation(async () => new Response('<Error><Code>RequestTimeTooSkewed</Code><ServerTime>2026-10-02T00:00:00Z</ServerTime></Error>', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const client = new Client({ region: 'oss-cn-hangzhou', bucket: 'synthetic-bucket', secure: true, authorizationV4: true,
      accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret', stsToken: 'synthetic-token',
      urllib: createUploadTransport(new AbortController().signal), retryMax: 0 })
    limitUploadRequestRetries(client)
    await expect(client.listV2({ 'max-keys': 1 })).rejects.toMatchObject({ code: 'RequestTimeTooSkewed' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('uses the installed Browser SDK signing, XML parsing and classified errors with synthetic fetch only', async () => {
    vi.stubGlobal('location', { protocol: 'https:' })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(xml, { status: 200 }))
      .mockResolvedValueOnce(new Response('<Error><Code>SecurityTokenExpired</Code><Message>synthetic-secret</Message></Error>', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const client = new Client({ region: 'oss-cn-hangzhou', bucket: 'synthetic-bucket', secure: true, authorizationV4: true,
      accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret', stsToken: 'synthetic-token',
      urllib: createUploadTransport(new AbortController().signal), retryMax: 0 })
    const result = await client.listV2({ 'max-keys': 1 })
    expect(result.isTruncated).toBe(false)
    expect(fetch.mock.calls[0][0]).toMatch(/^https:\/\/synthetic-bucket\.oss-cn-hangzhou\.aliyuncs\.com\//)
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(fetch.mock.calls[0][1].headers.authorization).toMatch(/^OSS4-HMAC-SHA256 /)
    await expect(client.listV2({ 'max-keys': 1 })).rejects.toMatchObject({ code: 'SecurityTokenExpired' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('passes binary buffers and signed OSS headers while omitting browser-forbidden headers', async () => {
    const body = new Uint8Array([1, 2, 3])
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { ETag: 'synthetic-etag' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await createUploadTransport(new AbortController().signal).request('https://synthetic.example.test/key', {
      method: 'PUT', content: body, headers: { Authorization: 'synthetic-signature', 'x-oss-forbid-overwrite': 'true',
        'Content-Length': '3', Host: 'synthetic.example.test', 'User-Agent': 'synthetic-agent' },
    })
    expect(fetch.mock.calls[0][1].body).toBe(body)
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'synthetic-signature', 'x-oss-forbid-overwrite': 'true' })
    expect(result.res).toMatchObject({ statusCode: 200, headers: { etag: 'synthetic-etag' } })
  })
  it('aborts every concurrent request belonging to this upload and hides transport details', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signals.push(options.signal); options.signal.addEventListener('abort', () => reject(new Error('synthetic-secret')))
    })))
    const controller = new AbortController(), transport = createUploadTransport(controller.signal)
    const requests = [transport.request('https://synthetic.example.test/a', { method: 'PUT' }),
      transport.request('https://synthetic.example.test/b', { method: 'PUT' })]
    controller.abort()
    const results = await Promise.allSettled(requests)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    for (const result of results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(UploadStoppedError) }
  })
  it('classifies one request timeout without exposing its URL or headers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('synthetic-secret')))
    })))
    const result = createUploadTransport(new AbortController().signal).request('https://synthetic.example.test/a', { method: 'PUT', timeout: 10 }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(10)
    const error = await result
    expect(error).toMatchObject({ name: 'ConnectionTimeoutError', status: -2 })
    expect(error.message).not.toContain('synthetic-secret')
    expect(error).not.toHaveProperty('url'); expect(error).not.toHaveProperty('headers')
  })
  it.each(['http://synthetic.example.test/a', 'https://user:pass@synthetic.example.test/a', 'https://synthetic.example.test/a#fragment'])('rejects unsafe request URLs before fetch', async (url) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(createUploadTransport(new AbortController().signal).request(url, { method: 'PUT' })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
