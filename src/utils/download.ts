function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export async function downloadToUserDevice(url: string, filename: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)

  const bytes = new Uint8Array(await response.arrayBuffer())

  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeFile } = await import('@tauri-apps/plugin-fs')

    const path = await save({
      defaultPath: filename,
      title: '保存文件',
    })
    if (!path) throw new Error('已取消保存')

    await writeFile(path, bytes)
    return path
  }

  const objectUrl = URL.createObjectURL(new Blob([bytes]))
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)

  return '浏览器默认下载目录'
}
