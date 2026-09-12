import OSS from 'ali-oss'
import type { OssConfig, OssEntry, OssListResult, UploadResult } from '../types/oss'
import { basename, encodeObjectKey, joinPrefix, splitFileName, validateUploadFileName, validateUploadRelativePath } from '../utils/file'
import { applyParsedOssHost, formatOssConnectError } from '../utils/oss-config'
import { UploadStoppedError, uploadErrorMessage } from '../utils/upload'
import type { UploadOptions, UploadOutcome } from '../utils/upload'

type ProgressHandler = (percent: number) => void

export class OssBrowserService {
  private client: OSS | null = null
  private config: OssConfig | null = null

  async connect(config: OssConfig): Promise<void> {
    const normalized = this.normalizeConfig(config)

    const options: Record<string, unknown> = {
      region: normalized.region,
      bucket: normalized.bucket,
      accessKeyId: normalized.accessKeyId,
      accessKeySecret: normalized.accessKeySecret,
      secure: true,
      authorizationV4: true,
      timeout: 60_000,
    }

    if (normalized.stsToken) options.stsToken = normalized.stsToken
    if (normalized.endpoint) options.endpoint = normalized.endpoint

    let client: OSS
    try {
      client = new OSS(options as any)
      // 用一次极小的对象列表请求验证凭证、Bucket、Region 与 CORS。
      await client.listV2({ 'max-keys': 1 })
    } catch (error) {
      throw new Error(formatOssConnectError(error))
    }

    this.client = client
    this.config = normalized
  }

  disconnect(): void {
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
    const client = this.requireClient()
    const requestedKey = joinPrefix(prefix, validateUploadRelativePath(relativePath))
    let finalKey = requestedKey
    let renameSelected = false
    let knownConflict = false

    // Bound repeated races against another uploader. Access errors never imply absence.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let overwrite = false
      if (knownConflict || await this.objectExists(finalKey)) {
        if (renameSelected) {
          finalKey = await this.resolveConflictName(requestedKey)
        } else {
          const action = options.resolveConflict ? await options.resolveConflict(finalKey) : 'rename'
          if (action === null) throw new UploadStoppedError()
          if (action === 'skip') return { status: 'skipped', key: finalKey }
          if (action === 'overwrite') overwrite = true
          else {
            renameSelected = true
            finalKey = await this.resolveConflictName(requestedKey)
          }
        }
      }
      knownConflict = false
      options.onProgress?.(1)
      try {
        // OSS ignores this header for buckets with versioning enabled or suspended.
        // Keep the list check too; do not request additional bucket permissions.
        const headers = overwrite ? {} : { 'x-oss-forbid-overwrite': 'true' }
        if (file.size >= 8 * 1024 * 1024) {
          await client.multipartUpload(finalKey, file, {
            headers,
            parallel: 4,
            partSize: 1024 * 1024,
            progress: async (value: number) => {
              options.onProgress?.(Math.max(1, Math.min(99, Math.round(value * 100))))
            },
          })
        } else {
          await client.put(finalKey, file, { headers })
        }
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : ''
        if (!overwrite && code === 'FileAlreadyExists') {
          knownConflict = true
          continue
        }
        throw new Error(uploadErrorMessage(error))
      }
      options.onProgress?.(100)
      return { status: 'success', result: {
        key: finalKey,
        publicUrl: this.publicUrl(finalKey),
        renamed: finalKey !== requestedKey,
      } }
    }
    throw new Error('目标目录持续出现同名冲突，请稍后重试。')
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

  private async resolveConflictName(key: string): Promise<string> {
    if (!(await this.objectExists(key))) return key

    const slashIndex = key.lastIndexOf('/')
    const prefix = slashIndex >= 0 ? key.slice(0, slashIndex + 1) : ''
    const fileName = slashIndex >= 0 ? key.slice(slashIndex + 1) : key
    const { stem, extension } = splitFileName(fileName)

    for (let index = 1; index <= 9999; index += 1) {
      const candidate = `${prefix}${stem} (${index})${extension}`
      if (!(await this.objectExists(candidate))) return candidate
    }

    throw new Error('同名文件过多，无法生成可用文件名。')
  }

  private async objectExists(key: string): Promise<boolean> {
    const client = this.requireClient()
    const seenTokens = new Set<string>()
    let token = ''
    while (true) {
      const query: Record<string, string | number> = { prefix: key, 'max-keys': 1000 }
      if (token) query['continuation-token'] = token
      let raw: { objects?: Array<{ name: string }>; isTruncated?: boolean; nextContinuationToken?: string }
      try {
        raw = (await client.listV2(query)) as unknown as typeof raw
      } catch (error) {
        throw new Error(uploadErrorMessage(error))
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
      endpoint: config.endpoint.trim(),
      publicBaseUrl: config.publicBaseUrl.trim(),
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
