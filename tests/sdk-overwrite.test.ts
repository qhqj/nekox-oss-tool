// @vitest-environment node
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Exercise the installed Browser SDK's real multipart flow; the transport is wholly synthetic.
const require = createRequire(import.meta.url)
const managed = require('ali-oss/lib/browser/managed-upload.js')
const multipart = require('ali-oss/lib/common/multipart.js')

describe('installed SDK overwrite header propagation', () => {
  it('retains the guard on both initiate and complete requests', async () => {
    const requests: Array<{ subres: unknown; headers: Record<string, string> }> = []
    const context = {
      resetCancelFlag: () => {}, isCancel: () => false, _convertMetaToHeaders: () => {},
      _getFileSize: async () => 256 * 1024,
      _getPartSize: managed._getPartSize, _divideParts: managed._divideParts,
      _resumeMultipart: managed._resumeMultipart,
      initMultipartUpload: multipart.initMultipartUpload,
      completeMultipartUpload: multipart.completeMultipartUpload,
      _createBuffer: async () => Buffer.from('synthetic-part'),
      _uploadPart: async () => ({ res: { headers: { etag: 'synthetic-etag' } } }),
      _parallel: async (items: number[], _parallel: number, run: (item: number) => Promise<unknown>) => {
        const results = await Promise.allSettled(items.map(run))
        return results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason)
      },
      _objectRequestParams: (_method: string, _key: string, options: Record<string, unknown>) => ({ ...options, bucket: 'synthetic-bucket' }),
      request: vi.fn(async (params) => {
        requests.push({ subres: params.subres, headers: { ...params.headers } })
        return { data: { UploadId: 'synthetic-upload' }, res: { headers: { etag: 'synthetic-etag' } } }
      }),
    }
    await managed.multipartUpload.call(context, 'folder/file.bin', Buffer.from('synthetic-file'), {
      headers: { 'x-oss-forbid-overwrite': 'true' }, parallel: 4, partSize: 128 * 1024,
    })
    expect(requests).toHaveLength(2)
    expect(requests[0].subres).toBe('uploads')
    expect(requests[1].subres).toEqual({ uploadId: 'synthetic-upload' })
    for (const request of requests) expect(request.headers['x-oss-forbid-overwrite']).toBe('true')
  })
  it('grants the save command without adding blanket filesystem scopes', () => {
    const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
    expect(capability.permissions).toContain('fs:allow-write-file')
    expect(capability.permissions).toContain('dialog:default')
    expect(capability.permissions.some((permission: unknown) => typeof permission !== 'string')).toBe(false)
    expect(capability.permissions).not.toContain('fs:write-all')
  })
})
