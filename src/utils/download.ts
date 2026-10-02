import { invoke, isTauri } from '@tauri-apps/api/core'

const CHUNK_BYTES = 128 * 1024

export type DownloadResult =
  | { status: 'saved'; path: string }
  | { status: 'started' }
  | { status: 'cancelled' }

interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (receivedBytes: number) => void
}

/** An OSS basename is not necessarily a valid Windows filename. */
export function safeDownloadFileName(filename: string): string {
  let safe = Array.from(filename.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_').trim()).slice(0, 120).join('')
  safe = safe.replace(/[. ]+$/, '') || 'download'
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe)) safe = `_${safe}`
  return safe
}

function signedUrl(getUrl: (filename: string) => string, filename: string): string {
  try {
    const url = getUrl(filename)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || url.includes('#') || /[\\\u0000-\u0020\u007f]/.test(url)) throw new Error()
    // Preserve the original query and escaping: reserializing can invalidate a signature.
    return url
  } catch {
    throw new Error('无法生成安全的 HTTPS 下载链接，请重新连接账号后重试。')
  }
}

/** Generate a signature only after the desktop save dialog grants a destination. */
export async function downloadToUserDevice(
  getUrl: (filename: string) => string,
  filename: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  if (options.signal?.aborted) return { status: 'cancelled' }
  const safeName = safeDownloadFileName(filename)
  if (!isTauri()) {
    const anchor = document.createElement('a')
    anchor.href = signedUrl(getUrl, safeName)
    anchor.download = safeName
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.referrerPolicy = 'no-referrer'
    document.body.appendChild(anchor)
    try { anchor.click() } catch { throw new Error('无法启动浏览器下载，请重试。') } finally { anchor.remove() }
    // The browser owns transfer, cancellation and destination; a click is not a saved file.
    return { status: 'started' }
  }

  let id: string | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  let failure = '无法准备下载，请选择新的文件名并检查保存目录权限；已有文件不会被覆盖。'
  try {
    id = await invoke<string | null>('begin_download', { filename: safeName })
    if (!id || options.signal?.aborted) return { status: 'cancelled' }
    failure = '无法生成安全的 HTTPS 下载链接，请重新连接账号后重试。'
    const url = signedUrl(getUrl, safeName)
    failure = '下载失败，请检查网络、CORS、凭据有效期及保存目录后重试。'
    const response = await fetch(url, {
      signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
    })
    if (!response.ok) {
      failure = `下载失败（HTTP ${response.status}），请检查读取权限和凭据有效期。`
      throw new Error()
    }
    if (!response.body) {
      failure = '当前运行环境不支持流式下载，请更新 WebView2 后重试。'
      throw new Error()
    }
    reader = response.body.getReader()
    let received = 0
    while (true) {
      controller.signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
        controller.signal.throwIfAborted()
        const chunk = value.subarray(offset, offset + CHUNK_BYTES)
        // Await disk writes before reading more; binary IPC avoids JSON byte arrays.
        await invoke('write_download_chunk', chunk, { headers: { 'x-nekox-download': id } })
        received += chunk.byteLength
        options.onProgress?.(received)
      }
    }
    controller.signal.throwIfAborted()
    failure = '无法完成保存，请检查磁盘空间及目标文件是否已存在；已有文件不会被覆盖。'
    const path = await invoke<string>('finish_download', { id })
    id = null
    return { status: 'saved', path }
  } catch {
    if (controller.signal.aborted || options.signal?.aborted) return { status: 'cancelled' }
    // Raw transport errors can contain signed URLs or request headers.
    throw new Error(failure)
  } finally {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    if (reader) {
      try { await reader.cancel() } catch { /* The network may already have failed. */ }
      try { reader.releaseLock() } catch { /* Cleanup of our native task must still run. */ }
    }
    if (id) {
      try { await invoke('cancel_download', { id }) } catch {
        throw new Error('下载已停止，但临时文件清理未确认；请关闭应用后检查保存目录。')
      }
    }
  }
}
