import OSS from 'ali-oss'
import type { OssConfig, OssEntry, OssListResult, UploadResult } from '../types/oss'
import { basename, encodeObjectKey, joinPrefix, splitFileName } from '../utils/file'
import { applyParsedOssHost, formatOssConnectError } from '../utils/oss-config'

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

    const client = new OSS(options as any)

    try {
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

    const raw = (await client.listV2(query)) as unknown as {
      prefixes?: string[]
      objects?: Array<{ name: string; size?: number | string }>
      isTruncated?: boolean
      nextContinuationToken?: string
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
    const client = this.requireClient()
    const safeName = this.validateFileName(requestedName)
    const requestedKey = joinPrefix(prefix, safeName)
    const finalKey = await this.resolveConflictName(requestedKey)

    onProgress?.(1)

    if (file.size >= 8 * 1024 * 1024) {
      await client.multipartUpload(finalKey, file, {
        parallel: 4,
        partSize: 1024 * 1024,
        progress: async (value: number) => {
          onProgress?.(Math.max(1, Math.min(99, Math.round(value * 100))))
        },
      })
    } else {
      await client.put(finalKey, file)
    }

    onProgress?.(100)

    return {
      key: finalKey,
      publicUrl: this.publicUrl(finalKey),
      renamed: finalKey !== requestedKey,
    }
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
    const raw = (await client.listV2({ prefix: key, 'max-keys': 1 })) as unknown as {
      objects?: Array<{ name: string }>
    }
    return (raw.objects ?? []).some((object) => object.name === key)
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

  private validateFileName(name: string): string {
    const normalized = name.trim()
    if (!normalized) throw new Error('上传文件名不能为空。')
    if (normalized.includes('/')) throw new Error('文件名不能包含 /，请先进入目标目录再上传。')
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
