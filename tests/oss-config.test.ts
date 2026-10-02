import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyParsedOssHost, normalizeHttpsUrl, parseOssHostInput } from '../src/utils/oss-config'
import { OssBrowserService } from '../src/services/oss'

const sdk = vi.hoisted(() => ({ construct: vi.fn(), listV2: vi.fn(), signatureUrl: vi.fn() }))
vi.mock('ali-oss', () => ({ default: class {
  constructor(options: unknown) { sdk.construct(options) }
  listV2 = sdk.listV2
  signatureUrl = sdk.signatureUrl
} }))

const config = {
  region: 'oss-cn-beijing', bucket: 'example-bucket', accessKeyId: 'synthetic-id',
  accessKeySecret: 'synthetic-secret', stsToken: 'synthetic-token', endpoint: '', publicBaseUrl: '',
}

beforeEach(() => {
  vi.resetAllMocks()
  sdk.listV2.mockResolvedValue({ objects: [] })
})

describe('HTTPS configuration boundaries', () => {
  it.each([
    'http://example.test', 'javascript:alert(1)', 'file:///tmp/file', '//example.test',
    'https://user:password@example.test', 'https://example.test?token=synthetic-token',
    'https://example.test#fragment', 'https://example.test?', 'https://example.test#',
    'https://example.test\\path', 'https://exa\nmple.test', 'https://',
  ])('rejects unsafe addresses without echoing their contents: %j', (input) => {
    expect(() => normalizeHttpsUrl(input, 'Endpoint')).toThrow('HTTPS')
    try { normalizeHttpsUrl(input, 'Endpoint') } catch (error) {
      expect((error as Error).message).not.toContain('synthetic-token')
      expect((error as Error).message).not.toContain('password')
    }
  })
  it('supports bare HTTPS hostnames, ports, and public path prefixes', () => {
    expect(normalizeHttpsUrl('', 'Endpoint')).toBe('')
    expect(normalizeHttpsUrl(' oss-cn-beijing.aliyuncs.com ', 'Endpoint')).toBe('https://oss-cn-beijing.aliyuncs.com')
    expect(normalizeHttpsUrl('custom.example.test:8443', 'Endpoint')).toBe('https://custom.example.test:8443')
    expect(normalizeHttpsUrl('https://cdn.example.test/base/', 'CDN', true)).toBe('https://cdn.example.test/base')
    expect(() => normalizeHttpsUrl('https://example.test/path', 'Endpoint')).toThrow('路径')
  })
  it.each(['endpoint', 'publicBaseUrl'] as const)('validates %s before constructing the SDK or listing objects', async (field) => {
    const service = new OssBrowserService()
    await expect(service.connect({ ...config, [field]: 'http://example.test' })).rejects.toThrow('HTTPS')
    expect(sdk.construct).not.toHaveBeenCalled()
    expect(sdk.listV2).not.toHaveBeenCalled()
  })
  it('retains normalized custom endpoints, public path prefixes and explicit preview/download signing', async () => {
    const service = new OssBrowserService()
    await service.connect({ ...config, endpoint: 'custom.example.test:8443', publicBaseUrl: 'https://cdn.example.test/base/' })
    expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://custom.example.test:8443', secure: true }))
    expect(service.publicUrl('folder/图 片.jpg')).toBe('https://cdn.example.test/base/folder/%E5%9B%BE%20%E7%89%87.jpg')
    expect(sdk.signatureUrl).not.toHaveBeenCalled()
    sdk.signatureUrl.mockReturnValue('synthetic-signed-url')
    expect(service.signedPreviewUrl('folder/image.jpg')).toBe('synthetic-signed-url')
    expect(sdk.signatureUrl).toHaveBeenLastCalledWith('folder/image.jpg', { expires: 300 })
    service.signedDownloadUrl('folder/image.jpg', 'image.jpg')
    expect(sdk.signatureUrl).toHaveBeenLastCalledWith('folder/image.jpg', {
      expires: 300, response: { 'content-disposition': "attachment; filename*=UTF-8''image.jpg" },
    })
  })
})

describe('OSS hostname parsing', () => {
  it.each([
    'example-bucket.oss-cn-beijing.aliyuncs.com',
    'https://example-bucket.oss-cn-beijing.aliyuncs.com/folder/file.jpg',
    'https://oss-cn-beijing.aliyuncs.com/example-bucket/folder/file.jpg',
  ])('recognizes complete official hostnames: %s', (input) => {
    expect(parseOssHostInput(input)).toEqual({ bucket: 'example-bucket', region: 'oss-cn-beijing' })
  })
  it.each([
    'http://example-bucket.oss-cn-beijing.aliyuncs.com',
    'https://attacker.example.test/example-bucket.oss-cn-beijing.aliyuncs.com',
    'https://example-bucket.oss-cn-beijing.aliyuncs.com.attacker.test',
    'https://example-bucket.oss-cn-beijing.aliyuncs.com@attacker.test',
    'https://user:password@example-bucket.oss-cn-beijing.aliyuncs.com',
    'https://example-bucket.oss-cn-beijing.aliyuncs.com:8443',
  ])('does not parse insecure, misleading, or custom-port hosts: %s', (input) => {
    expect(parseOssHostInput(input)).toBeNull()
    const target = { ...config, endpoint: input }
    expect(applyParsedOssHost(target, input)).toBe(false)
    expect(target.endpoint).toBe(input)
  })
})
