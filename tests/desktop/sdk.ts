// Build-time test alias only; production Vite never includes this adapter.
import OSS from 'ali-oss/dist/aliyun-oss-sdk.js'
import { createUploadTransport } from '../../src/utils/upload-transport'
export default function OfflineOSS(options: Record<string, unknown>) {
  return new OSS({ ...options, urllib: options.urllib ?? createUploadTransport(new AbortController().signal) })
}
