// @vitest-environment node
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Exercise the installed Browser SDK's real multipart flow; the transport is wholly synthetic.
const require = createRequire(import.meta.url)
const managed = require('ali-oss/lib/browser/managed-upload.js')
const multipart = require('ali-oss/lib/common/multipart.js')
const parallel = require('ali-oss/lib/common/parallel.js')

function recoveryContext() {
  return {
    ...managed, ...parallel, options: { bucket: 'synthetic-bucket', cancelFlag: false },
    _convertMetaToHeaders: () => {}, _createBuffer: async () => Buffer.from('synthetic-part'),
    _uploadPart: vi.fn(async () => ({ res: { headers: { etag: 'synthetic-etag' } } })),
    initMultipartUpload: vi.fn(async () => ({ uploadId: 'synthetic-upload', res: {} })),
    completeMultipartUpload: vi.fn(async () => ({})), abortMultipartUpload: vi.fn(),
  }
}

describe('installed SDK overwrite header propagation', () => {
  it('resumes only remaining part numbers without initializing another upload and retains completion protection', async () => {
    const context = recoveryContext(), file = Buffer.alloc(384 * 1024)
    const checkpoint = { file, name: 'folder/file.bin', fileSize: file.length, partSize: 128 * 1024,
      uploadId: 'synthetic-upload', doneParts: [{ number: 1, etag: 'saved-etag' }] }
    await context.multipartUpload('folder/file.bin', file, { checkpoint, parallel: 2, headers: { 'x-oss-forbid-overwrite': 'true' } })
    expect(context.initMultipartUpload).not.toHaveBeenCalled()
    expect(context._uploadPart.mock.calls.map((call: any[]) => call[2])).toEqual([2, 3])
    expect(context.completeMultipartUpload.mock.calls[0][3].headers).toEqual({ 'x-oss-forbid-overwrite': 'true' })
    expect(context.completeMultipartUpload.mock.calls[0][2]).toHaveLength(3)
  })
  it('cancel() without an abort argument never deletes remote parts or completes after a late part response', async () => {
    const context = recoveryContext(), file = Buffer.alloc(384 * 1024), progress = vi.fn()
    let release!: () => void
    context._uploadPart.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ res: { headers: { etag: 'late-etag' } } })
    }))
    const checkpoint = { file, name: 'file.bin', fileSize: file.length, partSize: 128 * 1024,
      uploadId: 'synthetic-upload', doneParts: [{ number: 1, etag: 'saved-etag' }] }
    const pending = context.multipartUpload('file.bin', file, { checkpoint, parallel: 1, progress })
    await vi.waitFor(() => expect(release).toBeDefined())
    context.cancel(); release()
    await expect(pending).rejects.toMatchObject({ name: 'cancel' })
    expect(context.abortMultipartUpload).not.toHaveBeenCalled()
    expect(context.completeMultipartUpload).not.toHaveBeenCalled()
    expect(context._uploadPart).toHaveBeenCalledOnce()
    expect(checkpoint.doneParts).toEqual([{ number: 1, etag: 'saved-etag' }])
    expect(progress).not.toHaveBeenCalled()
  })
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
  it('does not grant generic filesystem writes for the native download sink', () => {
    const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
    expect(capability.permissions).not.toContain('fs:allow-write-file')
    expect(capability.permissions).toContain('dialog:default')
    expect(capability.permissions.some((permission: unknown) => typeof permission !== 'string')).toBe(false)
    expect(capability.permissions).not.toContain('fs:write-all')
  })
})
