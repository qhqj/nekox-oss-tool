export interface ParsedOssHost {
  bucket: string
  region: string
}

const VIRTUAL_HOSTED_PATTERN =
  /(?:https?:\/\/)?(?<bucket>[a-z0-9][a-z0-9-]{0,61}[a-z0-9])\.(?<region>oss-[a-z0-9-]+)\.aliyuncs\.com(?:[/?#]|$)/i

const PATH_STYLE_PATTERN =
  /(?:https?:\/\/)?(?<region>oss-[a-z0-9-]+)\.aliyuncs\.com\/(?<bucket>[a-z0-9][a-z0-9-]{0,61}[a-z0-9])(?:[/?#]|$)/i

export function parseOssHostInput(input: string): ParsedOssHost | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const virtualHosted = trimmed.match(VIRTUAL_HOSTED_PATTERN)
  if (virtualHosted?.groups?.bucket && virtualHosted.groups.region) {
    return {
      bucket: virtualHosted.groups.bucket,
      region: virtualHosted.groups.region,
    }
  }

  const pathStyle = trimmed.match(PATH_STYLE_PATTERN)
  if (pathStyle?.groups?.bucket && pathStyle.groups.region) {
    return {
      bucket: pathStyle.groups.bucket,
      region: pathStyle.groups.region,
    }
  }

  return null
}

export function applyParsedOssHost<T extends { bucket: string; region: string; endpoint?: string }>(
  target: T,
  input: string,
): boolean {
  const parsed = parseOssHostInput(input)
  if (!parsed) return false

  target.bucket = parsed.bucket
  target.region = parsed.region
  if ('endpoint' in target) target.endpoint = ''
  return true
}

function corsOriginHint(): string {
  if (typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null') {
    return window.location.origin
  }
  return 'http://localhost:5173'
}

export function formatOssConnectError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error || '未知错误')

  const looksLikeNetwork =
    /XHR error|connected:\s*false|Network Error|Failed to fetch|net::ERR/i.test(message)

  if (looksLikeNetwork) {
    return `无法连接 OSS。请检查网络以及 Bucket 的 CORS 是否允许当前来源（${corsOriginHint()}）。可在 OSS 控制台 → Bucket → 数据安全 → 跨域设置 中检查 GET、PUT、POST、HEAD 等请求的允许规则。`
  }

  if (/bucket must be conform to the specifications/i.test(message)) {
    return 'Bucket 名称格式不正确，请只填写 Bucket 名称，或粘贴 OSS Bucket 域名自动识别。'
  }

  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : ''
  switch (code) {
    case 'AccessDenied': return 'OSS 拒绝访问，请检查当前账号对目标 Bucket 的权限。'
    case 'NoSuchBucket': return '目标 Bucket 不存在，请检查 Bucket 名称和 Region。'
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch': return '凭证或签名验证失败，请检查 AccessKey、Region、Endpoint 及系统时间。'
    case 'SecurityTokenExpired':
    case 'InvalidSecurityToken': return 'STS 临时凭证已过期或无效，请更新凭证后重新连接。'
    case 'RequestTimeout':
    case 'ConnectionTimeoutError': return 'OSS 请求超时，请检查网络后重试。'
    default: return 'OSS 请求失败，请检查网络、CORS、账号配置和 Bucket 权限后重试。'
  }
}
