import type { OssConfig } from '../types/oss'

const STORAGE_KEY = 'nekox-oss-tool/config'

export interface PersistedOssConfig {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  stsToken: string
  endpoint: string
  publicBaseUrl: string
}

export function createInitialConfig(): OssConfig {
  const persisted = loadPersistedConfig()

  return {
    region: persisted?.region || import.meta.env.VITE_OSS_DEFAULT_REGION || 'oss-cn-beijing',
    bucket: persisted?.bucket || import.meta.env.VITE_OSS_DEFAULT_BUCKET || '',
    accessKeyId: persisted?.accessKeyId || '',
    accessKeySecret: persisted?.accessKeySecret || '',
    stsToken: persisted?.stsToken || '',
    endpoint: persisted?.endpoint || '',
    publicBaseUrl: persisted?.publicBaseUrl || import.meta.env.VITE_OSS_PUBLIC_BASE_URL || '',
  }
}

export function loadPersistedConfig(): PersistedOssConfig | null {
  if (typeof localStorage === 'undefined') return null

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<PersistedOssConfig>
    if (!parsed || typeof parsed !== 'object') return null

    return {
      region: String(parsed.region ?? '').trim(),
      bucket: String(parsed.bucket ?? '').trim(),
      accessKeyId: String(parsed.accessKeyId ?? '').trim(),
      accessKeySecret: String(parsed.accessKeySecret ?? '').trim(),
      stsToken: String(parsed.stsToken ?? '').trim(),
      endpoint: String(parsed.endpoint ?? '').trim(),
      publicBaseUrl: String(parsed.publicBaseUrl ?? '').trim(),
    }
  } catch {
    return null
  }
}

export function savePersistedConfig(config: OssConfig): void {
  if (typeof localStorage === 'undefined') return

  const data: PersistedOssConfig = {
    region: config.region.trim(),
    bucket: config.bucket.trim(),
    accessKeyId: config.accessKeyId.trim(),
    accessKeySecret: config.accessKeySecret.trim(),
    stsToken: config.stsToken.trim(),
    endpoint: config.endpoint.trim(),
    publicBaseUrl: config.publicBaseUrl.trim(),
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function hasPersistedConfig(): boolean {
  const persisted = loadPersistedConfig()
  if (!persisted) return false
  return Boolean(
    persisted.region ||
      persisted.bucket ||
      persisted.accessKeyId ||
      persisted.accessKeySecret ||
      persisted.endpoint ||
      persisted.publicBaseUrl,
  )
}

export function canAutoConnect(config: OssConfig): boolean {
  return Boolean(config.region && config.bucket && config.accessKeyId && config.accessKeySecret)
}
