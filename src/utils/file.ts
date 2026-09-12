export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? '0 B' : '—'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function basename(key: string): string {
  const normalized = key.replace(/\/$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

export function joinPrefix(prefix: string, name: string): string {
  return `${prefix}${name}`.replace(/^\/+/, '')
}

export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, extension: '' }
  return { stem: name.slice(0, dot), extension: name.slice(dot) }
}

export function validateUploadFileName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('上传文件名不能为空。')
  if (/[\\/]/.test(normalized)) throw new Error('文件名不能包含 / 或 \\，请先进入目标目录再上传。')
  if (normalized === '.' || normalized === '..' || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('文件名包含不支持的字符。')
  }
  return normalized
}

/** Folder paths come only from the file picker; never normalize traversal away. */
export function validateUploadRelativePath(path: string): string {
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('上传相对路径无效，请重新选择文件或文件夹。')
  }
  if (path.split('/').some((segment) => !segment.trim() || segment === '.' || segment === '..')) {
    throw new Error('上传路径不能包含空目录、. 或 ..。')
  }
  return path
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'])

export function isImageFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}
