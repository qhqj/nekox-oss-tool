export interface ParsedOssHost {
  bucket: string
  region: string
}

const VIRTUAL_HOSTED_PATTERN =
  /^(?<bucket>[a-z0-9][a-z0-9-]{0,61}[a-z0-9])\.(?<region>oss-[a-z0-9-]+)\.aliyuncs\.com$/i

const PATH_STYLE_PATTERN =
  /^\/(?<bucket>[a-z0-9][a-z0-9-]{0,61}[a-z0-9])(?:\/|$)/i

function httpsAddress(input: string): URL {
  const value = input.trim()
  if (!value || /^[\/]/.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) throw new Error()
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error()
  return url
}

/** Validate before SDK construction; secure:true does not override an explicit HTTP endpoint. */
export function normalizeHttpsUrl(input: string, label: string, allowPath = false): string {
  if (!input.trim()) return ''
  try {
    const url = httpsAddress(input)
    if (/[?#]/.test(input) || (!allowPath && url.pathname !== '/')) throw new Error()
    return url.href.replace(/\/+$/, '')
  } catch {
    throw new Error(`${label} 必须为 HTTPS 地址，不能包含用户名、密码、查询参数或片段${allowPath ? '。' : '，且不能包含路径。'}`)
  }
}

export function parseOssHostInput(input: string): ParsedOssHost | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = httpsAddress(trimmed)
    if (url.port) return null
  } catch {
    return null
  }

  const virtualHosted = url.hostname.match(VIRTUAL_HOSTED_PATTERN)
  if (virtualHosted?.groups?.bucket && virtualHosted.groups.region) {
    return {
      bucket: virtualHosted.groups.bucket,
      region: virtualHosted.groups.region,
    }
  }

  const region = url.hostname.match(/^(oss-[a-z0-9-]+)\.aliyuncs\.com$/i)?.[1]
  const pathStyle = region && url.pathname.match(PATH_STYLE_PATTERN)
  if (pathStyle && pathStyle.groups?.bucket && region) {
    return {
      bucket: pathStyle.groups.bucket,
      region,
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
