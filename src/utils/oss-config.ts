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
    return `${message}\n\n这通常是 Bucket 未配置 CORS，或 Allowed Origins 未包含当前来源（${corsOriginHint()}）。请在 OSS 控制台 → Bucket → 数据安全 → 跨域设置 中添加规则，Methods 至少包含 GET、PUT、POST、HEAD。`
  }

  if (/bucket must be conform to the specifications/i.test(message)) {
    return `${message}\n\nBucket 只能填写名称（如 geekzenalioss），不要填写完整域名。可直接粘贴 geekzenalioss.oss-cn-beijing.aliyuncs.com 自动识别。`
  }

  return message
}
