<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import ConfigModal from './components/ConfigModal.vue'
import ImagePreviewModal from './components/ImagePreviewModal.vue'
import UploadModal from './components/UploadModal.vue'
import WindowControls from './components/WindowControls.vue'
import { OssBrowserService } from './services/oss'
import type { OssConfig, OssEntry, UploadResult } from './types/oss'
import { downloadToUserDevice } from './utils/download'
import { canAutoConnect, createInitialConfig, hasPersistedConfig, savePersistedConfig } from './utils/config-storage'
import { formatBytes, isImageFile } from './utils/file'
import { isDesktopShell, startWindowDrag, toggleMaximizeWindow } from './utils/windowControls'

const isDesktop = isDesktopShell()

const service = new OssBrowserService()

const config = reactive<OssConfig>(createInitialConfig())

const connected = ref(false)
const connecting = ref(false)
const configOpen = ref(false)
const configError = ref('')

const currentPrefix = ref('')
const entries = ref<OssEntry[]>([])
const loading = ref(false)
const listError = ref('')
const continuationToken = ref('')
const nextContinuationToken = ref('')
const isTruncated = ref(false)
const pageIndex = ref(1)

const uploadOpen = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const uploadError = ref('')
const uploadResult = ref<UploadResult | null>(null)
const toast = ref('')
const downloadingKey = ref('')
const previewOpen = ref(false)
const previewName = ref('')
const previewUrl = ref('')
const previewError = ref('')
let toastTimer = 0

const folders = computed(() => entries.value.filter((entry) => entry.type === 'folder'))

const currentPathLabel = computed(() => {
  if (!currentPrefix.value) return '/'
  return `/${currentPrefix.value}`
})

const listSummary = computed(() => {
  if (!connected.value || loading.value) return ''
  const folderCount = folders.value.length
  const fileCount = entries.value.filter((entry) => entry.type === 'file').length
  return `${folderCount} 文件夹 · ${fileCount} 文件`
})

const breadcrumbs = computed(() => {
  const parts = currentPrefix.value.split('/').filter(Boolean)
  const items = [{ label: '根目录', prefix: '' }]
  let prefix = ''
  for (const part of parts) {
    prefix += `${part}/`
    items.push({ label: part, prefix })
  }
  return items
})

onMounted(async () => {
  if (!hasPersistedConfig()) {
    configOpen.value = true
    return
  }

  if (canAutoConnect(config)) {
    await connect({ ...config })
    if (!connected.value) configOpen.value = true
  } else {
    configOpen.value = true
  }
})

async function connect(next: OssConfig) {
  const wasConnected = connected.value
  connecting.value = true
  configError.value = ''

  try {
    await service.connect(next)
    Object.assign(config, next)
    savePersistedConfig(next)
    connected.value = true
    configOpen.value = false
    currentPrefix.value = ''
    continuationToken.value = ''
    pageIndex.value = 1
    await loadDirectory()
    showToast('OSS 已连接')
  } catch (error) {
    connected.value = wasConnected
    configError.value = toMessage(error)
  } finally {
    connecting.value = false
  }
}

async function loadDirectory() {
  if (!connected.value) return

  loading.value = true
  listError.value = ''
  try {
    const result = await service.list(currentPrefix.value, continuationToken.value)
    entries.value = result.entries
    nextContinuationToken.value = result.nextContinuationToken
    isTruncated.value = result.isTruncated
  } catch (error) {
    listError.value = toMessage(error)
  } finally {
    loading.value = false
  }
}

async function enterFolder(prefix: string) {
  currentPrefix.value = prefix
  continuationToken.value = ''
  pageIndex.value = 1
  await loadDirectory()
}

async function goBreadcrumb(prefix: string) {
  await enterFolder(prefix)
}

async function nextPage() {
  if (!nextContinuationToken.value) return
  continuationToken.value = nextContinuationToken.value
  pageIndex.value += 1
  await loadDirectory()
}

async function refresh() {
  continuationToken.value = ''
  pageIndex.value = 1
  await loadDirectory()
  if (!listError.value) showToast('目录已刷新')
}

async function firstPage() {
  continuationToken.value = ''
  pageIndex.value = 1
  await loadDirectory()
}

function openUpload() {
  uploadError.value = ''
  uploadResult.value = null
  uploadProgress.value = 0
  uploadOpen.value = true
}

async function upload(file: File, filename: string) {
  uploading.value = true
  uploadError.value = ''
  uploadProgress.value = 0

  try {
    uploadResult.value = await service.upload(currentPrefix.value, file, filename, (percent) => {
      uploadProgress.value = percent
    })
    await refresh()
  } catch (error) {
    uploadError.value = toMessage(error)
  } finally {
    uploading.value = false
  }
}

function copyPublicUrl(entry: OssEntry) {
  copyText(service.publicUrl(entry.key))
}

function openImagePreview(entry: OssEntry) {
  previewOpen.value = true
  previewName.value = entry.name
  previewUrl.value = ''
  previewError.value = ''

  try {
    previewUrl.value = service.signedPreviewUrl(entry.key)
  } catch (error) {
    previewError.value = toMessage(error)
  }
}

function closeImagePreview() {
  previewOpen.value = false
  previewName.value = ''
  previewUrl.value = ''
  previewError.value = ''
}

function onFileClick(entry: OssEntry) {
  if (entry.type !== 'file') return
  if (isImageFile(entry.name)) openImagePreview(entry)
}

async function download(entry: OssEntry) {
  if (downloadingKey.value) return

  downloadingKey.value = entry.key
  try {
    const url = service.signedDownloadUrl(entry.key, entry.name)
    const savedTo = await downloadToUserDevice(url, entry.name)
    showToast(`已保存：${savedTo}`)
  } catch (error) {
    const message = toMessage(error)
    if (message !== '已取消保存') showToast(message)
  } finally {
    downloadingKey.value = ''
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('链接已复制')
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
    showToast('链接已复制')
  }
}

function showToast(message: string) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, message.length > 28 ? 3200 : 1800)
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message)
  return String(error || '未知错误')
}

function onTitlebarDblClick(event: MouseEvent) {
  if (!isDesktop) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.window-controls')) return
  void toggleMaximizeWindow()
}

function onTitlebarMouseDown(event: MouseEvent) {
  if (!isDesktop || event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (!target?.closest('[data-tauri-drag-region]')) return
  if (target.closest('button, a, input, textarea, select, label, .window-controls')) return
  void startWindowDrag()
}
</script>

<template>
  <div class="app-shell" :class="{ 'is-desktop': isDesktop }" data-theme="light">
    <header class="app-chrome" data-tauri-drag-region="" @mousedown="onTitlebarMouseDown" @dblclick="onTitlebarDblClick">
      <div class="chrome-brand-block" data-tauri-drag-region="">
        <img class="brand-mark" src="/app-icon.svg" alt="" />
        <span class="chrome-title">Nekox OSS Tool</span>
      </div>

      <div class="chrome-drag" data-tauri-drag-region="" />

      <div class="chrome-window-slot">
        <WindowControls />
      </div>
    </header>

    <main class="workspace">
      <aside class="sidebar">
        <div class="sidebar-brand"><img src="/app-icon.svg" alt="" /><div><strong>Nekox</strong><span>OSS 文件工作台</span></div></div>
        <div class="sidebar-title">
          <span>目录导航</span>
          <small>按需加载</small>
        </div>

        <button class="tree-root" type="button" :class="{ active: currentPrefix === '' }" @click="enterFolder('')">
          <span>▣</span> 根目录
        </button>

        <div v-if="breadcrumbs.length > 1" class="tree-ancestors">
          <button
            v-for="item in breadcrumbs.slice(1)"
            :key="item.prefix"
            type="button"
            :class="{ active: item.prefix === currentPrefix }"
            @click="enterFolder(item.prefix)"
          >
            <span>⌞</span> {{ item.label }}
          </button>
        </div>

        <div class="sidebar-divider" />
        <div class="sidebar-subtitle">当前目录下的文件夹</div>
        <button v-for="folder in folders" :key="folder.key" class="folder-shortcut" type="button" @click="enterFolder(folder.key)">
          <span>▸</span>
          <b>{{ folder.name }}</b>
        </button>
        <p v-if="connected && !loading && folders.length === 0" class="sidebar-empty">没有子目录</p>

        <div class="sidebar-note">
          <strong>操作说明</strong>
          <span>图片点击文件名可预览；下载会弹出保存位置（桌面端）或保存到浏览器默认下载目录。</span>
        </div>
      </aside>

      <section class="content-panel">
        <div class="path-toolbar">
          <div class="path-toolbar-main">
            <span class="path-toolbar-label">当前路径</span>
            <nav class="path-bar" aria-label="目录路径">
              <template v-for="(item, index) in breadcrumbs" :key="item.prefix">
                <button type="button" :class="{ active: item.prefix === currentPrefix }" @click="goBreadcrumb(item.prefix)">
                  {{ item.label }}
                </button>
                <span v-if="index < breadcrumbs.length - 1" class="path-sep">/</span>
              </template>
            </nav>
            <code v-if="connected" class="path-code">{{ currentPathLabel }}</code>
          </div>

          <div class="toolbar-group">
            <div :class="['conn-indicator', connected && 'is-online']">
              <i aria-hidden="true" />
              <span>{{ connected ? `${config.bucket} · ${config.region}` : '未连接' }}</span>
            </div>
            <button class="toolbar-btn" type="button" title="连接配置" @click="configOpen = true">连接</button>
            <span class="toolbar-divider" aria-hidden="true" />
            <span v-if="listSummary" class="toolbar-meta">{{ listSummary }}</span>
            <span v-if="listSummary" class="toolbar-divider" aria-hidden="true" />
            <button class="toolbar-btn" type="button" :disabled="!connected || loading" @click="refresh">
              {{ loading ? '刷新中…' : '刷新' }}
            </button>
            <span class="toolbar-divider" aria-hidden="true" />
            <button class="toolbar-btn is-primary" type="button" :disabled="!connected" @click="openUpload">上传</button>
          </div>
        </div>

        <div v-if="connected && !listError" class="list-head">
          <span>名称</span>
          <span>大小</span>
          <span class="list-head-actions">操作</span>
        </div>

        <div v-if="!connected" class="empty-state">
          <img class="welcome-icon" src="/app-icon.svg" alt="Nekox OSS Tool" />
          <span class="welcome-eyebrow">NEKOX OSS TOOL</span>
          <h2>让云端文件，触手可及</h2>
          <p>连接你的阿里云 OSS，轻松浏览、上传与分享文件。</p>
          <button class="primary-button" type="button" @click="configOpen = true">打开连接配置</button>
        </div>

        <div v-else-if="listError" class="empty-state error-state">
          <div class="empty-icon">!</div>
          <h2>目录读取失败</h2>
          <p>{{ listError }}</p>
          <button class="secondary-button" type="button" @click="refresh">重试</button>
        </div>

        <div v-else class="file-area">
          <div v-if="loading" class="loading-list">
            <i v-for="index in 7" :key="index" />
          </div>

          <div v-else-if="entries.length === 0" class="empty-folder">
            <strong>当前目录为空</strong>
            <span>可以直接上传文件到这里。</span>
          </div>

          <div v-else class="file-list">
            <div v-for="entry in entries" :key="entry.key" class="file-row" @dblclick="entry.type === 'folder' && enterFolder(entry.key)">
              <button v-if="entry.type === 'folder'" class="file-name folder-name" type="button" @click="enterFolder(entry.key)">
                <span class="entry-icon">▰</span>
                <b>{{ entry.name }}</b>
              </button>
              <button
                v-else-if="isImageFile(entry.name)"
                class="file-name image-name"
                type="button"
                title="点击预览图片"
                @click="onFileClick(entry)"
              >
                <span class="entry-icon">🖼</span>
                <span>{{ entry.name }}</span>
              </button>
              <div v-else class="file-name">
                <span class="entry-icon">□</span>
                <span>{{ entry.name }}</span>
              </div>

              <span class="file-size">{{ entry.type === 'folder' ? '—' : formatBytes(entry.size) }}</span>

              <div class="row-actions">
                <template v-if="entry.type === 'file'">
                  <button v-if="isImageFile(entry.name)" type="button" title="预览图片" @click="openImagePreview(entry)">预览</button>
                  <button type="button" title="复制公共链接" @click="copyPublicUrl(entry)">复制链接</button>
                  <button
                    type="button"
                    title="下载文件"
                    :disabled="downloadingKey === entry.key"
                    @click="download(entry)"
                  >
                    {{ downloadingKey === entry.key ? '下载中…' : '下载' }}
                  </button>
                </template>
              </div>
            </div>
          </div>

          <div v-if="pageIndex > 1 || isTruncated" class="status-bar">
            <span>第 {{ pageIndex }} 页 · 每页最多 300 项</span>
            <div class="toolbar-group">
              <button v-if="pageIndex > 1" class="toolbar-btn" type="button" @click="firstPage">第一页</button>
              <button v-if="isTruncated && nextContinuationToken" class="toolbar-btn" type="button" @click="nextPage">下一页</button>
            </div>
          </div>
        </div>
      </section>
    </main>

    <ConfigModal
      :open="configOpen"
      :initial="config"
      :connecting="connecting"
      :error="configError"
      @close="configOpen = false"
      @connect="connect"
    />

    <ImagePreviewModal
      :open="previewOpen"
      :name="previewName"
      :url="previewUrl"
      :error="previewError"
      @close="closeImagePreview"
    />

    <UploadModal
      :open="uploadOpen"
      :prefix="currentPrefix"
      :uploading="uploading"
      :progress="uploadProgress"
      :result="uploadResult"
      :error="uploadError"
      @close="uploadOpen = false"
      @upload="upload"
      @copy="copyText"
    />

    <transition name="toast">
      <div v-if="toast" :class="['toast', toast.length > 28 && 'toast-wide']">{{ toast }}</div>
    </transition>
  </div>
</template>
