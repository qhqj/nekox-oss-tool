import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OssBrowserService } from '../src/services/oss'
import { UploadStoppedError } from '../src/utils/upload'
import { validateUploadFileName, validateUploadRelativePath } from '../src/utils/file'

const sdk = vi.hoisted(() => ({ construct: vi.fn(), listV2: vi.fn(), put: vi.fn(), multipartUpload: vi.fn(), signatureUrl: vi.fn() }))
vi.mock('ali-oss', () => ({ default: class {
  constructor() { sdk.construct() }
  listV2 = sdk.listV2
  put = sdk.put
  multipartUpload = sdk.multipartUpload
  signatureUrl = sdk.signatureUrl
} }))

let service: OssBrowserService
const file = () => new File(['synthetic content'], 'report.txt')
const config = {
  region: 'oss-cn-hangzhou', bucket: 'example', accessKeyId: 'synthetic-id',
  accessKeySecret: 'synthetic-secret', stsToken: '', endpoint: '', publicBaseUrl: 'https://cdn.example.test',
}

beforeEach(async () => {
  vi.resetAllMocks()
  sdk.listV2.mockResolvedValue({ objects: [], isTruncated: false })
  sdk.put.mockResolvedValue({})
  sdk.multipartUpload.mockResolvedValue({})
  service = new OssBrowserService()
  await service.connect(config)
  sdk.listV2.mockClear()
})

describe('upload path boundaries', () => {
  it.each(['../escape.txt', 'a/../b.txt', './a.txt', '/absolute.txt', 'C:/file.txt', 'a\\b.txt', 'a//b.txt', 'a/', 'a/./b.txt', 'a/\u0000.txt', ''])('rejects unsafe relative path %j', (path) => {
    expect(() => validateUploadRelativePath(path)).toThrow()
  })
  it('preserves folder root, subdirectories, Unicode and spaces', () => {
    expect(validateUploadRelativePath('资料/子 目录/report 01.pdf')).toBe('资料/子 目录/report 01.pdf')
  })
  it.each(['a/b.txt', 'a\\b.txt', '..', '.', '\u0000', ' '])('rejects manual filename %j', (name) => {
    expect(() => validateUploadFileName(name)).toThrow()
  })
  it('validates legacy manual filenames before OSS requests', async () => {
    await expect(service.upload('current/', file(), '../escape.txt')).rejects.toThrow()
    expect(sdk.listV2).not.toHaveBeenCalled()
    expect(sdk.put).not.toHaveBeenCalled()
  })
})

describe('metadata-only same-name resolution', () => {
  it('sanitizes SDK constructor failures', async () => {
    sdk.construct.mockImplementationOnce(() => { throw new Error('synthetic-secret') })
    const error = await service.connect(config).catch((reason) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain('synthetic-secret')
  })
  it('sanitizes connection-check and browsing failures', async () => {
    sdk.listV2.mockRejectedValue(new Error('synthetic-secret'))
    const connectError = await service.connect(config).catch((reason) => reason)
    const listError = await service.list().catch((reason) => reason)
    expect(connectError).toBeInstanceOf(Error)
    expect(listError).toBeInstanceOf(Error)
    expect(connectError.message).not.toContain('synthetic-secret')
    expect(listError.message).not.toContain('synthetic-secret')
  })
  it('uploads under the current prefix and guards a new key', async () => {
    const progress = vi.fn()
    const result = await service.uploadFile('current/', file(), 'root/sub/report.txt', { onProgress: progress })
    expect(result).toEqual({ status: 'success', result: {
      key: 'current/root/sub/report.txt', publicUrl: 'https://cdn.example.test/current/root/sub/report.txt', renamed: false,
    } })
    expect(sdk.put).toHaveBeenCalledWith('current/root/sub/report.txt', expect.any(File), { headers: { 'x-oss-forbid-overwrite': 'true' } })
    expect(progress.mock.calls.map(([value]) => value)).toEqual([1, 100])
    expect(sdk.listV2).toHaveBeenCalledWith({ prefix: 'current/root/sub/report.txt', 'max-keys': 1000 })
    expect(sdk.signatureUrl).not.toHaveBeenCalled()
  })
  it('does not confuse a longer object prefix with the exact key', async () => {
    sdk.listV2.mockResolvedValue({ objects: [{ name: 'report.txt.backup' }] })
    const resolveConflict = vi.fn()
    await service.uploadFile('', file(), 'report.txt', { resolveConflict })
    expect(resolveConflict).not.toHaveBeenCalled()
    expect(sdk.put).toHaveBeenCalledOnce()
  })
  it('checks subsequent list pages for the exact key', async () => {
    sdk.listV2.mockResolvedValueOnce({ objects: [{ name: 'report.txt.old' }], isTruncated: true, nextContinuationToken: 'page-2' })
      .mockResolvedValueOnce({ objects: [{ name: 'report.txt' }], isTruncated: false })
    expect(await service.uploadFile('', file(), 'report.txt', { resolveConflict: async () => 'skip' })).toEqual({ status: 'skipped', key: 'report.txt' })
    expect(sdk.listV2).toHaveBeenLastCalledWith({ prefix: 'report.txt', 'max-keys': 1000, 'continuation-token': 'page-2' })
    expect(sdk.put).not.toHaveBeenCalled()
  })
  it.each([
    { objects: [], isTruncated: true },
    { objects: [], isTruncated: true, nextContinuationToken: 'repeated' },
  ])('fails closed on invalid pagination', async (response) => {
    sdk.listV2.mockResolvedValue(response)
    await expect(service.uploadFile('', file(), 'report.txt')).rejects.toThrow('分页异常')
    expect(sdk.put).not.toHaveBeenCalled()
  })
  it('does not upload when list permissions fail and hides sensitive SDK details', async () => {
    sdk.listV2.mockRejectedValue({ code: 'AccessDenied', message: 'synthetic-secret', request: { headers: { Authorization: 'secret' } } })
    const error = await service.uploadFile('', file(), 'report.txt').catch((reason) => reason)
    expect(error.message).toContain('拒绝访问')
    expect(error.message).not.toContain('synthetic-secret')
    expect(sdk.put).not.toHaveBeenCalled()
  })
  it('only removes the overwrite guard after an explicit overwrite decision', async () => {
    sdk.listV2.mockResolvedValue({ objects: [{ name: 'report.txt' }] })
    const resolveConflict = vi.fn().mockResolvedValue('overwrite')
    await service.uploadFile('', file(), 'report.txt', { resolveConflict })
    expect(resolveConflict).toHaveBeenCalledWith('report.txt')
    expect(sdk.put).toHaveBeenCalledWith('report.txt', expect.any(File), { headers: {} })
  })
  it('increments the name within the same folder and retains the extension', async () => {
    const existing = new Set(['current/root/report.txt', 'current/root/report (1).txt'])
    sdk.listV2.mockImplementation(async (query) => ({ objects: existing.has(query.prefix) ? [{ name: query.prefix }] : [] }))
    const outcome = await service.uploadFile('current/', file(), 'root/report.txt', { resolveConflict: async () => 'rename' })
    expect(outcome).toEqual({ status: 'success', result: {
      key: 'current/root/report (2).txt', publicUrl: 'https://cdn.example.test/current/root/report%20(2).txt', renamed: true,
    } })
    expect(sdk.put.mock.lastCall?.[2]).toEqual({ headers: { 'x-oss-forbid-overwrite': 'true' } })
  })
  it('handles a concurrent new-key collision by prompting before any overwrite', async () => {
    sdk.put.mockRejectedValueOnce({ code: 'FileAlreadyExists' })
    const resolveConflict = vi.fn().mockResolvedValue('skip')
    expect(await service.uploadFile('', file(), 'report.txt', { resolveConflict })).toEqual({ status: 'skipped', key: 'report.txt' })
    expect(resolveConflict).toHaveBeenCalledOnce()
    expect(sdk.put).toHaveBeenCalledOnce()
  })
  it('retries a raced rename with the next available name', async () => {
    const existing = new Set(['report.txt'])
    sdk.listV2.mockImplementation(async (query) => ({ objects: existing.has(query.prefix) ? [{ name: query.prefix }] : [] }))
    sdk.put.mockImplementationOnce(async (key) => { existing.add(key); throw { code: 'FileAlreadyExists' } })
    const resolveConflict = vi.fn().mockResolvedValue('rename')
    const outcome = await service.uploadFile('', file(), 'report.txt', { resolveConflict })
    expect(outcome.status === 'success' && outcome.result.key).toBe('report (2).txt')
    expect(resolveConflict).toHaveBeenCalledOnce()
    expect(sdk.put).toHaveBeenCalledTimes(2)
  })
  it('can stop while awaiting a conflict without writing an object', async () => {
    sdk.listV2.mockResolvedValue({ objects: [{ name: 'report.txt' }] })
    await expect(service.uploadFile('', file(), 'report.txt', { resolveConflict: async () => null })).rejects.toBeInstanceOf(UploadStoppedError)
    expect(sdk.put).not.toHaveBeenCalled()
  })
  it('guards multipart writes and reports progress only after successful completion', async () => {
    const largeFile = new File([new Uint8Array(8 * 1024 * 1024)], 'large.bin')
    const progress = vi.fn()
    sdk.multipartUpload.mockImplementation(async (_key, _file, options) => { await options.progress(0.7); return {} })
    await service.uploadFile('', largeFile, 'large.bin', { onProgress: progress })
    expect(sdk.multipartUpload.mock.lastCall?.[2].headers).toEqual({ 'x-oss-forbid-overwrite': 'true' })
    expect(progress.mock.calls.map(([value]) => value)).toEqual([1, 70, 100])
    expect(sdk.put).not.toHaveBeenCalled()
  })
  it('sanitizes failed writes and does not report 100 percent', async () => {
    sdk.put.mockRejectedValue({ message: 'synthetic-secret', request: { signedUrl: 'sensitive' } })
    const progress = vi.fn()
    const error = await service.uploadFile('', file(), 'report.txt', { onProgress: progress }).catch((reason) => reason)
    expect(error.message).toBe('OSS 请求失败，请检查网络、CORS、凭证有效期及列举/上传权限后重试。')
    expect(progress).not.toHaveBeenCalledWith(100)
  })
})
