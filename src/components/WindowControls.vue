<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { onMounted, onUnmounted, ref } from 'vue'
import {
  closeWindow,
  isDesktopShell,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from '../utils/windowControls'

const maximized = ref(false)
const desktop = isDesktopShell()
let unlisten: (() => void) | null = null

onMounted(async () => {
  if (!desktop) return
  maximized.value = await isWindowMaximized()
  unlisten = await getCurrentWindow().onResized(async () => {
    maximized.value = await isWindowMaximized()
  })
})

onUnmounted(() => {
  unlisten?.()
})

async function handleMinimize() {
  await minimizeWindow()
}

async function handleMaximize() {
  await toggleMaximizeWindow()
  maximized.value = await isWindowMaximized()
}

async function handleClose() {
  await closeWindow()
}
</script>

<template>
  <div v-if="desktop" class="window-controls">
    <button class="win-btn" type="button" title="最小化" aria-label="最小化" @click.stop="handleMinimize">
      <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7h10" stroke="currentColor" stroke-width="1.6" /></svg>
    </button>
    <button
      class="win-btn"
      type="button"
      :title="maximized ? '还原' : '最大化'"
      :aria-label="maximized ? '还原' : '最大化'"
      @click.stop="handleMaximize"
    >
      <svg v-if="!maximized" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="2.5" y="2.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
      <svg v-else viewBox="0 0 14 14" aria-hidden="true">
        <path d="M4.5 4.5h6v6H4.5z" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M3.5 9.5V3.5h6" fill="none" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
    <button class="win-btn is-close" type="button" title="关闭" aria-label="关闭" @click.stop="handleClose">
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.6" />
      </svg>
    </button>
  </div>
</template>
