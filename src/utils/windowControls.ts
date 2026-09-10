import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export function isDesktopShell(): boolean {
  return isTauri()
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauri()) return
  await getCurrentWindow().startDragging()
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return
  await getCurrentWindow().minimize()
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return
  await getCurrentWindow().toggleMaximize()
}

export async function closeWindow(): Promise<void> {
  if (!isTauri()) return
  await getCurrentWindow().close()
}

export async function isWindowMaximized(): Promise<boolean> {
  if (!isTauri()) return false
  return getCurrentWindow().isMaximized()
}
