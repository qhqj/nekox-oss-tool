import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OssBrowserService } from '../src/services/oss'
import { UploadFailure, UploadSession, UploadStoppedError } from '../src/utils/upload'

const sdk = vi.hoisted(() => ({ clients: [] as any[], list: vi.fn(), multipart: vi.fn(), put: vi.fn(), construct: vi.fn() }))
vi.mock('ali-oss', () => ({ default: class {
  options: any
  cancel = vi.fn()
  request = async () => ({})
  listV2 = sdk.list
  multipartUpload = sdk.multipart
  put = sdk.put
  constructor(options: any) { sdk.construct(options); this.options = options; sdk.clients.push(this) }
} }))
const config = { region: 'oss-cn-hangzhou', bucket: 'synthetic-bucket', accessKeyId: 'synthetic-id',
  accessKeySecret: 'synthetic-secret', stsToken: 'synthetic-token', endpoint: '', publicBaseUrl: '' }
let service: OssBrowserService
let file: File
let session: UploadSession
const checkpoint = () => ({ file, name: 'folder/large.bin', fileSize: file.size, partSize: 1024 * 1024,
  uploadId: 'synthetic-upload', doneParts: [{ number: 1, etag: 'synthetic-etag' }] })
async function retain(code = 'RequestError') {
  sdk.multipart.mockImplementationOnce(async (_key, _file, options) => {
    await options.progress(0.1, checkpoint()); throw { code, message: 'synthetic-secret' }
  })
  await expect(service.uploadFile('folder/', file, 'large.bin', { session })).rejects.toBeInstanceOf(UploadFailure)
}
beforeEach(async () => {
  vi.resetAllMocks(); sdk.clients.length = 0
  sdk.list.mockResolvedValue({ objects: [] }); sdk.multipart.mockResolvedValue({}); sdk.put.mockResolvedValue({})
  service = new OssBrowserService(); await service.connect(config, 'account-a'); sdk.list.mockClear()
  file = new File([new Uint8Array(8 * 1024 * 1024)], 'large.bin', { lastModified: 123 })
  session = new UploadSession()
})

describe('session-bound upload recovery', () => {
  it('aborts immediately, uses an isolated client and ignores late mutable checkpoints', async () => {
    let finish!: () => void
    let oldOptions: any
    const cp = checkpoint()
    Object.assign(cp, { config: { accessKeySecret: 'synthetic-secret' }, response: { headers: { Authorization: 'synthetic-secret' } } })
    sdk.multipart.mockImplementationOnce(async (_key, _file, options) => {
      oldOptions = options; await options.progress(0.1, cp)
      await new Promise<void>((resolve) => { finish = resolve })
      cp.doneParts.push({ number: 2, etag: 'late' }); await options.progress(0.8, cp)
    })
    const controller = new AbortController(), progress = vi.fn()
    const pending = service.uploadFile('folder/', file, 'large.bin', { session, signal: controller.signal, onProgress: progress })
    await vi.waitFor(() => expect(oldOptions).toBeDefined())
    const oldClient = sdk.clients.at(-1)
    controller.abort(); await expect(pending).rejects.toBeInstanceOf(UploadStoppedError)
    expect(oldClient.cancel).toHaveBeenCalledWith() // No remote DELETE / abort object argument.
    expect(sdk.clients[0].cancel).not.toHaveBeenCalled()
    finish(); await vi.waitFor(() => expect(cp.doneParts).toHaveLength(2))
    expect(progress.mock.calls.map(([value]) => value)).toEqual([1, 10])
    await service.uploadFile('folder/', file, 'large.bin', { session })
    expect(sdk.multipart.mock.lastCall![2].checkpoint.doneParts).toEqual([{ number: 1, etag: 'synthetic-etag' }])
    expect(sdk.multipart.mock.lastCall![2].checkpoint).not.toHaveProperty('config')
    expect(sdk.multipart.mock.lastCall![2].checkpoint).not.toHaveProperty('response')
    expect(sdk.clients.at(-1)).not.toBe(oldClient)
  })
  it('keeps the checkpoint after STS expiry and replaces only credentials without a request', async () => {
    await retain('SecurityTokenExpired')
    const before = sdk.list.mock.calls.length
    service.updateUploadCredentials({ accessKeyId: 'new-id', accessKeySecret: 'new-secret', stsToken: 'new-token', bucket: 'other' } as any)
    expect(sdk.list).toHaveBeenCalledTimes(before)
    await service.uploadFile('folder/', file, 'large.bin', { session })
    expect(sdk.clients.at(-1).options).toMatchObject({ bucket: config.bucket, accessKeyId: 'new-id', stsToken: 'new-token' })
    expect(sdk.multipart.mock.lastCall![2].checkpoint.uploadId).toBe('synthetic-upload')
  })
  it.each(['prefix', 'key', 'file', 'account', 'bucket', 'owner'])('refuses a checkpoint after changing %s before requests', async (changed) => {
    await retain()
    let target = service, targetFile = file, prefix = 'folder/', key = 'large.bin'
    if (changed === 'prefix') prefix = 'other/'
    if (changed === 'key') key = 'other.bin'
    if (changed === 'file') targetFile = new File([new Uint8Array(file.size)], file.name, { lastModified: file.lastModified })
    if (changed === 'account') await service.connect(config, 'account-b')
    if (changed === 'bucket') await service.connect({ ...config, bucket: 'other' }, 'account-a')
    if (changed === 'owner') { target = new OssBrowserService(); await target.connect(config, 'account-a') }
    sdk.list.mockClear(); sdk.multipart.mockClear()
    await expect(target.uploadFile(prefix, targetFile, key, { session })).rejects.toThrow('不可复用分片记录')
    expect(sdk.list).not.toHaveBeenCalled(); expect(sdk.multipart).not.toHaveBeenCalled()
  })
  it('retries a checkpoint timeout once and keeps the snapshot isolated from subsequent SDK mutation', async () => {
    const cp = checkpoint()
    sdk.multipart.mockImplementation(async (_key, _file, options) => {
      await options.progress(0.1, options.checkpoint ?? cp)
      throw { code: 'ConnectionTimeoutError' }
    })
    await expect(service.uploadFile('folder/', file, 'large.bin', { session })).rejects.toBeInstanceOf(UploadFailure)
    expect(sdk.multipart).toHaveBeenCalledTimes(2)
    expect(sdk.multipart.mock.calls[1][2].checkpoint).not.toBe(cp)
    expect(sdk.multipart.mock.calls[1][2].checkpoint.doneParts).not.toBe(cp.doneParts)
  })
  it('never automatically retransmits a small file or a multipart failure without a checkpoint', async () => {
    sdk.put.mockRejectedValue({ code: 'RequestTimeout' }); sdk.multipart.mockRejectedValue({ code: 'RequestTimeout' })
    await expect(service.uploadFile('', new File(['small'], 'small'), 'small')).rejects.toBeInstanceOf(UploadFailure)
    await expect(service.uploadFile('folder/', file, 'large.bin', { session })).rejects.toBeInstanceOf(UploadFailure)
    expect(sdk.put).toHaveBeenCalledOnce(); expect(sdk.multipart).toHaveBeenCalledOnce()
  })
  it.each([{ code: 'NoSuchUpload' }, { name: 'abort' }])('discards an expired upload ID (%j) then starts fresh only after a manual retry', async (error) => {
    await retain(); sdk.multipart.mockRejectedValueOnce(error)
    const availability = vi.fn()
    await expect(service.uploadFile('folder/', file, 'large.bin', { session, onCheckpoint: availability })).rejects.toThrow('分片记录已失效')
    expect(availability).toHaveBeenLastCalledWith(false)
    await service.uploadFile('folder/', file, 'large.bin', { session })
    expect(sdk.multipart.mock.lastCall![2]).not.toHaveProperty('checkpoint')
  })
  it('drops old-key checkpoints when a newly committed object requires renaming and keeps the guard', async () => {
    await retain()
    sdk.list.mockImplementation(async (query) => ({ objects: query.prefix === 'folder/large.bin' ? [{ name: query.prefix }] : [] }))
    await service.uploadFile('folder/', file, 'large.bin', { session, resolveConflict: async () => 'rename' })
    expect(sdk.multipart.mock.lastCall![0]).toBe('folder/large (1).bin')
    expect(sdk.multipart.mock.lastCall![2]).not.toHaveProperty('checkpoint')
    expect(sdk.multipart.mock.lastCall![2].headers).toEqual({ 'x-oss-forbid-overwrite': 'true' })
  })
  it('cancels metadata and pending decisions before starting any write', async () => {
    const controller = new AbortController()
    sdk.list.mockImplementationOnce(() => new Promise(() => {}))
    const pending = service.uploadFile('folder/', file, 'large.bin', { session, signal: controller.signal })
    controller.abort(); await expect(pending).rejects.toBeInstanceOf(UploadStoppedError)
    expect(sdk.multipart).not.toHaveBeenCalled()
    sdk.list.mockResolvedValue({ objects: [{ name: 'folder/large.bin' }] })
    const second = new AbortController()
    const resolveConflict = vi.fn(() => new Promise<null>(() => {}))
    const next = service.uploadFile('folder/', file, 'large.bin', { session, signal: second.signal, resolveConflict })
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalled())
    second.abort(); await expect(next).rejects.toBeInstanceOf(UploadStoppedError)
    expect(sdk.multipart).not.toHaveBeenCalled()
  })
  it('sanitizes constructor errors for upload clients', async () => {
    sdk.construct.mockImplementationOnce(() => { throw new Error('synthetic-secret') })
    const error = await service.uploadFile('folder/', file, 'large.bin', { session }).catch((error) => error)
    expect(error.message).not.toContain('synthetic-secret'); expect(sdk.list).not.toHaveBeenCalled()
  })
  it('refuses a pending reconnect result that would change the account during upload', async () => {
    let finishConnection!: (value: unknown) => void
    sdk.list.mockImplementationOnce(() => new Promise((resolve) => { finishConnection = resolve }))
    const connecting = service.connect({ ...config, bucket: 'other' }, 'account-b')
    sdk.multipart.mockImplementationOnce(async (_key, _file, options) => {
      await options.progress(0.1, checkpoint()); await new Promise(() => {})
    })
    const controller = new AbortController()
    const pending = service.uploadFile('folder/', file, 'large.bin', { session, signal: controller.signal })
    await vi.waitFor(() => expect(sdk.multipart).toHaveBeenCalled())
    finishConnection({ objects: [] })
    await expect(connecting).rejects.toThrow('上传期间不能替换连接')
    controller.abort(); await expect(pending).rejects.toBeInstanceOf(UploadStoppedError)
    await service.uploadFile('folder/', file, 'large.bin', { session })
    expect(sdk.clients.at(-1).options.bucket).toBe(config.bucket)
    expect(sdk.multipart.mock.lastCall![2].checkpoint.uploadId).toBe('synthetic-upload')
  })
})
