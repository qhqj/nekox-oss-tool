import { describe, expect, it } from 'vitest'
import { formatOssConnectError } from '../src/utils/oss-config'

describe('credential-free OSS diagnostics', () => {
  it('never echoes unknown SDK payloads or signed URLs', () => {
    const message = formatOssConnectError(new Error('synthetic-secret https://example.invalid/?security-token=synthetic-token'))
    expect(message).not.toContain('synthetic')
    expect(message).toContain('OSS 请求失败')
  })
  it('retains actionable network and expired-token guidance without raw messages', () => {
    expect(formatOssConnectError(new Error('XHR error synthetic-secret'))).toContain('CORS')
    expect(formatOssConnectError(new Error('XHR error synthetic-secret'))).not.toContain('synthetic')
    expect(formatOssConnectError({ code: 'SecurityTokenExpired', message: 'synthetic-token' })).toContain('已过期')
  })
})
