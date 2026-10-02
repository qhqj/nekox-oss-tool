import OSS from 'ali-oss'
import type { OssConfig, OssEntry, OssListResult, UploadResult } from '../types/oss'
import { basename, encodeObjectKey, joinPrefix, splitFileName, validateUploadFileName, validateUploadRelativePath } from '../utils/file'
import { applyParsedOssHost, formatOssConnectError, normalizeHttpsUrl } from '../utils/oss-config'
import { abortable, UploadFailure, UploadSession, UploadStoppedError } from '../utils/upload'
import type { UploadCredentials, UploadOptions, UploadOutcome } from '../utils/upload'
import { createUploadTransport, limitUploadRequestRetries } from '../utils/upload-transport'

type ProgressHandler = (percent: number) => void

interface Checkpoint {
  file: File; name: string; fileSize: number; partSize: number; uploadId: string
  doneParts: Array<{ number: number; etag: string }>
}
interface ResumeRecord {
  owner: OssBrowserService; generation: number; accountId: string; bucket: string; region: string; endpoint: string
  prefix: string; requestedKey: string; file: File; size: number; modified: number; filename: string
  key: string; renamed: boolean; checkpoint?: Checkpoint
}
const sessions = new WeakMap<UploadSession, ResumeRecord>()

function snapshot(value: unknown, file: File, key: string): Checkpoint | undefined {
  if (!value || typeof value !== 'object') return
  const cp = value as Checkpoint
  if (cp.file !== file || cp.name !== key || cp.fileSize !== file.size ||
      !Number.isInteger(cp.partSize) || cp.partSize < 100 * 1024 || cp.partSize > 5 * 1024 ** 3 ||
      Math.ceil(file.size / cp.partSize) > 10000 || typeof cp.uploadId !== 'string' || !cp.uploadId || cp.uploadId.length > 1024 ||
      !Array.isArray(cp.doneParts) || cp.doneParts.length > 10000) return
  const numbers = new Set<number>()
  const doneParts: Checkpoint['doneParts'] = []
  for (const part of cp.doneParts) {
    if (!part || !Number.isInteger(part.number) || part.number < 1 || part.number > Math.ceil(file.size / cp.partSize) || numbers.has(part.number) ||
        typeof part.etag !== 'string' || !part.etag || part.etag.length > 1024) return
    numbers.add(part.number); doneParts.push({ number: part.number, etag: part.etag })
  }
  // Do not retain response headers, SDK credentials, arbitrary fields, or mutable SDK arrays.
  return { file, name: key, fileSize: file.size, partSize: cp.partSize, uploadId: cp.uploadId, doneParts }
}

function failure(error: unknown): UploadFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : ''
  return new UploadFailure(name === 'abort' ? 'NoSuchUpload' : code)
}

export class OssBrowserService {
  private client: OSS | null = null
  private config: OssConfig | null = null
  private generation = 0
  private accountId = ''
  private uploading = false

  private makeClient(normalized: OssConfig, signal?: AbortSignal): OSS {
    const options: Record<string, unknown> = {
      region: normalized.region, bucket: normalized.bucket, accessKeyId: normalized.accessKeyId,
      accessKeySecret: normalized.accessKeySecret, secure: true, authorizationV4: true,
      timeout: 60_000, retryMax: 0,
    }
    if (normalized.stsToken) options.stsToken = normalized.stsToken
    if (normalized.endpoint) options.endpoint = normalized.endpoint
    if (signal) options.urllib = createUploadTransport(signal)
    const client = new OSS(options as any)
    if (signal) limitUploadRequestRetries(client as unknown as { request: (params: object) => Promise<unknown> })
    return client
  }

  async connect(config: OssConfig, accountId = ''): Promise<void> {
    if (this.uploading) throw new Error('请先暂停上传再连接账号。')
    const normalized = this.normalizeConfig(config)

    let client: OSS
    try {
      client = this.makeClient(normalized)
      // 用一次极小的对象列表请求验证凭证、Bucket、Region 与 CORS。
      await client.listV2({ 'max-keys': 1 })
    } catch (error) {
      throw new Error(formatOssConnectError(error))
    }

    if (this.uploading) throw new Error('上传期间不能替换连接，请先暂停。')
    this.client = client
    this.config = normalized
    this.generation += 1
    this.accountId = accountId
  }

  /** Manual replacement in memory only; no STS service, list check or persistence. */
  updateUploadCredentials(credentials: UploadCredentials): UploadCredentials {
    if (this.uploading) throw new Error('请先暂停上传再更新凭据。')
    const next = this.normalizeConfig({ ...this.requireConfig(), accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret, stsToken: credentials.stsToken })
    let client: OSS
    try { client = this.makeClient(next) } catch { throw new Error('无法更新上传凭据，请检查输入。') }
    this.client = client
    this.config = next
    return { accessKeyId: next.accessKeyId, accessKeySecret: next.accessKeySecret, stsToken: next.stsToken }
  }

  disconnect(): void {
    if (this.uploading) throw new Error('请先暂停上传再断开账号。')
    this.generation += 1
    this.client = null
    this.config = null
  }

  async list(prefix = '', continuationToken = ''): Promise<OssListResult> {
    const client = this.requireClient()
    const query: Record<string, string | number> = {
      delimiter: '/',
      'max-keys': 300,
    }

    // 根目录省略空 prefix，避免 SDK 与 OSS 对空查询参数的 V4 签名处理不一致。
    if (prefix) query.prefix = prefix
    if (continuationToken) query['continuation-token'] = continuationToken

    let raw: {
      prefixes?: string[]
      objects?: Array<{ name: string; size?: number | string }>
      isTruncated?: boolean
      nextContinuationToken?: string
    }
    try {
      raw = (await client.listV2(query)) as unknown as typeof raw
    } catch (error) {
      throw new Error(formatOssConnectError(error))
    }

    const folders: OssEntry[] = (raw.prefixes ?? []).map((folderKey) => ({
      type: 'folder',
      name: basename(folderKey),
      key: folderKey,
      size: 0,
    }))

    const files: OssEntry[] = (raw.objects ?? [])
      .filter((object) => object.name !== prefix && !object.name.endsWith('/'))
      .map((object) => ({
        type: 'file',
        name: basename(object.name),
        key: object.name,
        size: Number(object.size ?? 0),
      }))

    return {
      entries: [...folders, ...files],
      nextContinuationToken: raw.nextContinuationToken ?? '',
      isTruncated: Boolean(raw.isTruncated),
    }
  }

  async upload(
    prefix: string,
    file: File,
    requestedName: string,
    onProgress?: ProgressHandler,
  ): Promise<UploadResult> {
    const outcome = await this.uploadFile(prefix, file, validateUploadFileName(requestedName), {
      onProgress,
      resolveConflict: async () => 'rename',
    })
    if (outcome.status !== 'success') throw new UploadStoppedError()
    return outcome.result
  }

  async uploadFile(prefix: string, file: File, relativePath: string, options: UploadOptions = {}): Promise<UploadOutcome> {
    this.requireClient()
    const config = this.requireConfig()
    const requestedKey = joinPrefix(prefix, validateUploadRelativePath(relativePath))
    if (options.signal?.aborted) throw new UploadStoppedError()
    if (this.uploading) throw new Error('当前账号已有上传任务，请等待或暂停。')
    const session = options.session ?? new UploadSession()
    let record = sessions.get(session)
    if (record && (record.owner !== this || record.generation !== this.generation || record.accountId !== this.accountId ||
        record.bucket !== config.bucket || record.region !== config.region || record.endpoint !== config.endpoint ||
        record.prefix !== prefix || record.requestedKey !== requestedKey || record.file !== file ||
        record.size !== file.size || record.modified !== file.lastModified || record.filename !== file.name)) {
      throw new Error('上传任务的账号、Bucket、目标或文件已改变；请移除后重新选择，不可复用分片记录。')
    }
    if (!record) {
      record = { owner: this, generation: this.generation, accountId: this.accountId,
        bucket: config.bucket, region: config.region, endpoint: config.endpoint, prefix, requestedKey,
        file, size: file.size, modified: file.lastModified, filename: file.name, key: requestedKey, renamed: false }
      sessions.set(session, record)
    }
    const state = record
    this.uploading = true
    let knownConflict = false
    const rejectedKeys = new Set<string>()
    let networkRetries = 0
    try {
      // Total write attempts (including one checkpoint-only timeout retry) remain bounded to five.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const controller = new AbortController()
        let client: OSS | null = null
        let active = true
        const abort = () => { controller.abort(); client?.cancel() }
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
        const check = () => { if (controller.signal.aborted) throw new UploadStoppedError() }
        const clearCheckpoint = () => { state.checkpoint = undefined; options.onCheckpoint?.(false) }
        try {
          check()
          try { client = this.makeClient(config, controller.signal) } catch { throw new UploadFailure('') }
          let overwrite = false
          if (knownConflict || await abortable(this.objectExists(state.key, client), controller.signal)) {
            check()
            rejectedKeys.add(state.key)
            if (state.renamed) {
              clearCheckpoint()
              state.key = await abortable(this.resolveConflictName(requestedKey, rejectedKeys, client), controller.signal)
            } else {
              const action = options.resolveConflict ? await abortable(options.resolveConflict(state.key), controller.signal) : 'rename'
              check()
              if (action === null) throw new UploadStoppedError()
              if (action === 'skip') { clearCheckpoint(); return { status: 'skipped', key: state.key } }
              if (action === 'overwrite') overwrite = true
              else {
                state.renamed = true
                clearCheckpoint()
                state.key = await abortable(this.resolveConflictName(requestedKey, rejectedKeys, client), controller.signal)
              }
            }
          }
          check()
          knownConflict = false
          options.onProgress?.(state.checkpoint ? Math.max(1, Math.round(state.checkpoint.doneParts.length / (Math.ceil(file.size / state.checkpoint.partSize) + 1) * 100)) : 1)
          try {
            // OSS ignores this header for buckets with versioning enabled or suspended.
            // Keep the list check too; do not request additional bucket permissions.
            const headers = overwrite ? {} : { 'x-oss-forbid-overwrite': 'true' }
            if (file.size >= 8 * 1024 * 1024) {
              await abortable(client.multipartUpload(state.key, file, {
                headers,
                parallel: 4,
                partSize: 1024 * 1024,
                ...(state.checkpoint ? { checkpoint: snapshot(state.checkpoint, file, state.key) } : {}),
                progress: async (value: number, checkpoint: unknown) => {
                  if (!active || controller.signal.aborted) return
                  const saved = snapshot(checkpoint, file, state.key)
                  if (saved) { state.checkpoint = saved; options.onCheckpoint?.(true) }
                  options.onProgress?.(Math.max(1, Math.min(99, Math.round(value * 100))))
                },
              }), controller.signal)
            } else {
              await abortable(client.put(state.key, file, { headers }), controller.signal)
            }
          } catch (error) {
            check()
            const classified = failure(error)
            if (!overwrite && classified.code === 'FileAlreadyExists') {
              clearCheckpoint()
              knownConflict = true
              continue
            }
            if (classified.code === 'NoSuchUpload') clearCheckpoint()
            if (state.checkpoint && ['RequestTimeout', 'ConnectionTimeoutError'].includes(classified.code) && networkRetries < 1) {
              networkRetries += 1
              continue
            }
            throw classified
          }
          check()
          clearCheckpoint()
          options.onProgress?.(100)
          return { status: 'success', result: {
            key: state.key,
            publicUrl: this.publicUrl(state.key),
            renamed: state.key !== requestedKey,
          } }
        } finally {
          active = false
          options.signal?.removeEventListener('abort', abort)
          controller.abort()
          client?.cancel()
        }
      }
      throw new Error('目标目录持续出现同名冲突，请稍后重试。')
    } finally { this.uploading = false }
  }

  publicUrl(key: string): string {
    const config = this.requireConfig()
    const encodedKey = encodeObjectKey(key)

    if (config.publicBaseUrl) {
      return `${config.publicBaseUrl.replace(/\/$/, '')}/${encodedKey}`
    }

    return `https://${config.bucket}.${config.region}.aliyuncs.com/${encodedKey}`
  }

  signedDownloadUrl(key: string, filename?: string): string {
    return this.signedAccessUrl(key, {
      attachment: true,
      filename: filename || basename(key),
    })
  }

  signedPreviewUrl(key: string): string {
    return this.signedAccessUrl(key)
  }

  private signedAccessUrl(key: string, options?: { attachment?: boolean; filename?: string }): string {
    const client = this.requireClient()
    const params: Record<string, unknown> = { expires: 300 }

    if (options?.attachment) {
      params.response = {
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(options.filename || basename(key))}`,
      }
    }

    return client.signatureUrl(key, params)
  }

  private async resolveConflictName(key: string, rejectedKeys: Set<string>, client = this.requireClient()): Promise<string> {
    const slashIndex = key.lastIndexOf('/')
    const prefix = slashIndex >= 0 ? key.slice(0, slashIndex + 1) : ''
    const fileName = slashIndex >= 0 ? key.slice(slashIndex + 1) : key
    const { stem, extension } = splitFileName(fileName)

    for (let index = 1; index <= 9999; index += 1) {
      const candidate = `${prefix}${stem} (${index})${extension}`
      // Do not choose a server-rejected key again if listing has not caught up.
      if (rejectedKeys.has(candidate)) continue
      if (!(await this.objectExists(candidate, client))) return candidate
    }

    throw new Error('同名文件过多，无法生成可用文件名。')
  }

  private async objectExists(key: string, client = this.requireClient()): Promise<boolean> {
    const seenTokens = new Set<string>()
    let token = ''
    while (true) {
      const query: Record<string, string | number> = { prefix: key, 'max-keys': 1000 }
      if (token) query['continuation-token'] = token
      let raw: { objects?: Array<{ name: string }>; isTruncated?: boolean; nextContinuationToken?: string }
      try {
        raw = (await client.listV2(query)) as unknown as typeof raw
      } catch (error) {
        throw failure(error)
      }
      if ((raw.objects ?? []).some((object) => object.name === key)) return true
      if (!raw.isTruncated) return false
      const nextToken = raw.nextContinuationToken
      if (!nextToken || seenTokens.has(nextToken)) {
        throw new Error('OSS 同名检查分页异常，已停止上传以避免误覆盖。')
      }
      seenTokens.add(nextToken)
      token = nextToken
    }
  }

  private normalizeConfig(config: OssConfig): OssConfig {
    const normalized = {
      ...config,
      region: config.region.trim(),
      bucket: config.bucket.trim(),
      accessKeyId: config.accessKeyId.trim(),
      accessKeySecret: config.accessKeySecret.trim(),
      stsToken: config.stsToken.trim(),
      endpoint: normalizeHttpsUrl(config.endpoint, 'OSS Endpoint'),
      publicBaseUrl: normalizeHttpsUrl(config.publicBaseUrl, '公共访问基础地址', true),
    }

    applyParsedOssHost(normalized, normalized.bucket)
    applyParsedOssHost(normalized, normalized.region)
    applyParsedOssHost(normalized, normalized.endpoint)

    if (!normalized.region) throw new Error('请填写 Region，例如 oss-cn-hangzhou。')
    if (!normalized.bucket) throw new Error('请填写 Bucket。')
    if (!normalized.accessKeyId) throw new Error('请填写 AccessKey ID。')
    if (!normalized.accessKeySecret) throw new Error('请填写 AccessKey Secret。')

    return normalized
  }

  private requireClient(): OSS {
    if (!this.client) throw new Error('尚未连接 OSS。')
    return this.client
  }

  private requireConfig(): OssConfig {
    if (!this.config) throw new Error('尚未连接 OSS。')
    return this.config
  }
}
