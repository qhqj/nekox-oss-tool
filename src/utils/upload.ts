import type { UploadResult } from '../types/oss'

export type ConflictAction = 'overwrite' | 'skip' | 'rename'

export interface UploadOptions {
  onProgress?: (percent: number) => void
  /** Returning null pauses the queue before writing this object. */
  resolveConflict?: (key: string) => Promise<ConflictAction | null>
}

export type UploadOutcome =
  | { status: 'success'; result: UploadResult }
  | { status: 'skipped'; key: string }

export class UploadStoppedError extends Error {
  constructor() {
    super('上传已暂停。')
    this.name = 'UploadStoppedError'
  }
}

export type UploadStatus = 'pending' | 'uploading' | 'success' | 'failed' | 'skipped'

export interface UploadQueueItem {
  id: number
  file: File
  relativePath: string
  directory: string
  filename: string
  status: UploadStatus
  progress: number
  error: string
  result?: UploadResult
}

/** Never show raw SDK errors: they can contain request headers and credentials. */
export function uploadErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : ''
  switch (code) {
    case 'AccessDenied': return 'OSS 拒绝访问。请检查当前账号的列举或上传权限。'
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch': return '凭证或签名验证失败，请重新连接账号。'
    case 'SecurityTokenExpired':
    case 'InvalidSecurityToken': return 'STS 凭证已过期或无效，请更新凭证后重试。'
    case 'RequestTimeout':
    case 'ConnectionTimeoutError': return '请求超时，请检查网络后重试。'
    case 'FileAlreadyExists': return '目标文件已存在，请重试并重新选择同名处理方式。'
    default: return 'OSS 请求失败，请检查网络、CORS、凭证有效期及列举/上传权限后重试。'
  }
}
