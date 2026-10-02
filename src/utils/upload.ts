import type { UploadResult } from '../types/oss'

export type ConflictAction = 'overwrite' | 'skip' | 'rename'

export interface UploadOptions {
  signal?: AbortSignal
  session?: UploadSession
  onProgress?: (percent: number) => void
  onCheckpoint?: (available: boolean) => void
  /** Returning null pauses the queue before writing this object. */
  resolveConflict?: (key: string) => Promise<ConflictAction | null>
}

/** Opaque identity only; actual checkpoints live in the service's session WeakMap. */
export class UploadSession {}

export interface UploadCredentials {
  accessKeyId: string
  accessKeySecret: string
  stsToken: string
}

export class UploadFailure extends Error {
  constructor(public readonly code: string) { super(uploadErrorMessage({ code })); this.name = 'UploadFailure' }
}

export function isCredentialFailure(error: unknown): boolean {
  return error instanceof UploadFailure && ['SecurityTokenExpired', 'InvalidSecurityToken', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(error.code)
}

/** Observe late settlement without letting it update the cancelled caller. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(new UploadStoppedError()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
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
  session: UploadSession
  attempted: boolean
  resumable: boolean
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
    case 'RequestTimeTooSkewed': return '系统时间与 OSS 校验时间不符，请校准时间后重试。'
    case 'FileAlreadyExists': return '目标文件已存在，请重试并重新选择同名处理方式。'
    case 'NoSuchUpload': return '分片记录已失效；点击重试将从头上传此文件。'
    default: return 'OSS 请求失败，请检查网络、CORS、凭证有效期及列举/上传权限后重试。'
  }
}
