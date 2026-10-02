import { UploadFailure, UploadStoppedError } from './upload'

/** The SDK recursively retries clock-skew errors even with retryMax=0. */
export function limitUploadRequestRetries(client: { request: (params: object) => Promise<unknown> }) {
  const request = client.request.bind(client)
  const depths = new WeakMap<object, number>()
  client.request = async (params) => {
    const depth = depths.get(params) ?? 0
    if (depth >= 2) throw new UploadFailure('RequestTimeTooSkewed')
    depths.set(params, depth + 1)
    try { return await request(params) } finally {
      if (depth === 0) depths.delete(params)
      else depths.set(params, depth)
    }
  }
}

interface RequestParameters {
  method: string
  headers?: Record<string, string>
  content?: BodyInit
  timeout?: number
}

/** ali-oss's injectable urllib contract, limited to its metadata/upload responses. */
export function createUploadTransport(signal: AbortSignal) {
  return {
    async request(url: string, params: RequestParameters) {
      if (signal.aborted) throw new UploadStoppedError()
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || url.includes('#')) throw new Error('上传地址无效。')
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, params.timeout || 60_000)
      try {
        // Browser-forbidden headers are not part of this SDK's ordinary V4 additional headers.
        const headers = Object.fromEntries(Object.entries(params.headers ?? {}).filter(([name]) => !['content-length', 'host', 'user-agent'].includes(name.toLowerCase())))
        const response = await fetch(url, { method: params.method, headers, body: params.content,
          signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
        const data = await response.text() // Small OSS XML/status response, never object content.
        if (signal.aborted) throw new UploadStoppedError()
        const responseHeaders = Object.fromEntries(response.headers.entries())
        return { data, status: response.status, headers: responseHeaders,
          res: { data, status: response.status, statusCode: response.status, headers: responseHeaders } }
      } catch {
        if (signal.aborted) throw new UploadStoppedError()
        // Preserve the SDK's recognized error classification, without raw URLs or headers.
        throw Object.assign(new Error(timedOut ? '上传请求超时。' : '上传网络请求失败。'), {
          name: timedOut ? 'ConnectionTimeoutError' : 'RequestError', status: timedOut ? -2 : -1,
        })
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
      }
    },
  }
}
