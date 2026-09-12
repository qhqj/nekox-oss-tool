<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { OssBrowserService } from '../services/oss'
import { formatBytes, validateUploadFileName, validateUploadRelativePath } from '../utils/file'
import { UploadStoppedError } from '../utils/upload'
import type { ConflictAction, UploadQueueItem, UploadStatus } from '../utils/upload'

const props = defineProps<{
  open: boolean
  prefix: string
  service: OssBrowserService
  accountLabel: string
}>()
const emit = defineEmits<{
  close: []
  busy: [value: boolean]
  completed: []
  copy: [text: string]
}>()

const queue = ref<UploadQueueItem[]>([])
const running = ref(false)
const stopRequested = ref(false)
const selectionError = ref('')
const inputKey = ref(0)
const conflictKey = ref('')
const applyRemaining = ref(false)
const rememberedAction = ref<ConflictAction | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const folderSupported = typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input')
let nextId = 0
let conflictResolver: ((action: ConflictAction | null) => void) | null = null

const counts = computed(() => {
  const result: Record<UploadStatus, number> = { pending: 0, uploading: 0, success: 0, failed: 0, skipped: 0 }
  for (const item of queue.value) result[item.status] += 1
  return result
})
const totalBytes = computed(() => queue.value.reduce((sum, item) => sum + item.file.size, 0))
const statusLabels: Record<UploadStatus, string> = {
  pending: '等待', uploading: '上传中', success: '成功', failed: '失败', skipped: '已跳过',
}

watch(() => props.open, (open) => {
  if (open && !running.value) {
    queue.value = []
    selectionError.value = ''
    inputKey.value += 1
    stopRequested.value = false
    rememberedAction.value = null
    conflictKey.value = ''
    applyRemaining.value = false
  }
})
onBeforeUnmount(() => {
  stopRequested.value = true
  conflictResolver?.(null)
})

function addFiles(event: Event, isFolder: boolean) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  const rejected: string[] = []
  selectionError.value = ''
  for (const file of files) {
    try {
      const relativePath = validateUploadRelativePath(isFolder ? file.webkitRelativePath : file.name)
      const slash = relativePath.lastIndexOf('/')
      queue.value.push({
        id: ++nextId, file, relativePath,
        directory: slash >= 0 ? relativePath.slice(0, slash + 1) : '',
        filename: relativePath.slice(slash + 1),
        status: 'pending', progress: 0, error: '',
      })
    } catch {
      rejected.push(file.name)
    }
  }
  if (rejected.length) selectionError.value = `${rejected.length} 个文件的相对路径无效，未加入队列。请重新选择。`
  input.value = ''
}

function removeItem(id: number) {
  queue.value = queue.value.filter((item) => item.id !== id || item.status === 'uploading')
}
function resolveConflict(key: string): Promise<ConflictAction | null> {
  if (stopRequested.value) return Promise.resolve(null)
  if (rememberedAction.value) return Promise.resolve(rememberedAction.value)
  conflictKey.value = key
  applyRemaining.value = false
  return new Promise((resolve) => { conflictResolver = resolve })
}
function chooseConflict(action: ConflictAction) {
  if (applyRemaining.value) rememberedAction.value = action
  const resolve = conflictResolver
  conflictResolver = null
  conflictKey.value = ''
  resolve?.(action)
}
function requestStop() {
  stopRequested.value = true
  if (conflictResolver) {
    const resolve = conflictResolver
    conflictResolver = null
    conflictKey.value = ''
    resolve(null)
  }
}

async function start(onlyItem?: UploadQueueItem) {
  if (running.value) return
  const candidates = onlyItem ? [onlyItem] : queue.value.filter((item) => item.status === 'pending')
  if (!candidates.length) return
  running.value = true
  stopRequested.value = false
  rememberedAction.value = null
  emit('busy', true)
  let successes = 0
  try {
    for (const item of candidates) {
      if (stopRequested.value) break
      if (!queue.value.some((queued) => queued.id === item.id)) continue
      item.status = 'uploading'
      item.error = ''
      item.progress = 0
      try {
        // Preserve picker paths exactly unless the user edits the basename.
        const originalName = item.relativePath.slice(item.relativePath.lastIndexOf('/') + 1)
        const filename = item.filename === originalName ? originalName : validateUploadFileName(item.filename)
        const relativePath = validateUploadRelativePath(`${item.directory}${filename}`)
        const outcome = await props.service.uploadFile(props.prefix, item.file, relativePath, {
          onProgress: (progress) => { item.progress = progress },
          resolveConflict,
        })
        if (outcome.status === 'skipped') item.status = 'skipped'
        else {
          item.status = 'success'
          item.result = outcome.result
          successes += 1
        }
      } catch (error) {
        if (error instanceof UploadStoppedError) {
          item.status = 'pending'
          item.progress = 0
          break
        }
        item.status = 'failed'
        // Service errors are fixed, credential-free messages; local validation is fixed too.
        item.error = error instanceof Error ? error.message : '上传失败，请稍后重试。'
      }
    }
  } finally {
    running.value = false
    emit('busy', false)
    if (successes) emit('completed')
  }
}
function retryFailed() {
  for (const item of queue.value) {
    if (item.status === 'failed') item.status = 'pending'
  }
  void start()
}
</script>

<template>
  <div v-if="open" class="modal-mask">
    <section class="modal-card upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <header class="modal-header">
        <div class="modal-heading">
          <div class="modal-icon">↑</div>
          <div>
            <h2 id="upload-title">上传文件</h2>
            <p>{{ accountLabel }} · 目标目录：/{{ prefix }}</p>
          </div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" :disabled="running" @click="emit('close')">×</button>
      </header>

      <div class="upload-content">
        <div class="pick-actions">
          <input :key="`files-${inputKey}`" ref="fileInput" class="hidden-picker" type="file" multiple :disabled="running" @change="addFiles($event, false)" />
          <input :key="`folder-${inputKey}`" ref="folderInput" class="hidden-picker" type="file" webkitdirectory multiple :disabled="running" @change="addFiles($event, true)" />
          <button class="secondary-button" type="button" :disabled="running" @click="fileInput?.click()">＋ 选择多个文件</button>
          <button class="secondary-button" type="button" :disabled="running || !folderSupported" @click="folderInput?.click()">＋ 选择文件夹</button>
          <span>{{ queue.length }} 个文件 · {{ formatBytes(totalBytes) }}</span>
        </div>
        <p class="queue-note">文件夹会递归加入队列，并保留所选文件夹名及子目录。空文件夹不创建对象。上传前逐个检查同名文件。</p>
        <p v-if="!folderSupported" class="error-box">当前浏览器不支持文件夹选择，请使用文件多选。</p>
        <p v-if="selectionError" class="error-box" role="alert">{{ selectionError }}</p>

        <div v-if="!queue.length" class="queue-empty">选择文件或文件夹后，点击“开始上传”。</div>
        <ol v-else class="upload-queue" aria-label="上传队列">
          <li v-for="item in queue" :key="item.id" class="queue-item" :class="`status-${item.status}`">
            <div class="queue-item-header">
              <strong class="queue-path" :title="`${prefix}${item.directory}${item.filename}`">{{ item.directory }}{{ item.filename }}</strong>
              <span class="queue-size">{{ formatBytes(item.file.size) }}</span>
              <span class="queue-status">{{ statusLabels[item.status] }}{{ item.status === 'uploading' ? ` ${item.progress}%` : '' }}</span>
              <button v-if="item.status === 'pending' || item.status === 'failed'" class="icon-button" type="button" :aria-label="`移除 ${item.filename}`" @click="removeItem(item.id)">×</button>
            </div>
            <label v-if="item.status === 'pending' || item.status === 'failed'" class="filename-edit">
              <span>文件名</span>
              <input v-model="item.filename" :disabled="running" aria-label="上传文件名" placeholder="文件名不可包含路径分隔符" />
              <button v-if="item.status === 'failed'" class="secondary-button" type="button" :disabled="running" @click="start(item)">重试</button>
            </label>
            <div v-if="item.status === 'uploading'" class="progress-bar" role="progressbar" :aria-valuenow="item.progress" aria-valuemin="0" aria-valuemax="100" :aria-label="item.filename"><i :style="{ width: `${item.progress}%` }" /></div>
            <p v-if="item.error" class="item-error" role="alert">{{ item.error }}</p>
            <div v-if="item.result" class="item-result">
              <p v-if="item.result.renamed" class="rename-notice">检测到同名对象，已自动重命名。</p>
              <code>/{{ item.result.key }}</code>
              <div class="result-link"><input :value="item.result.publicUrl" aria-label="公共 URL" readonly /><button class="secondary-button" type="button" @click="emit('copy', item.result!.publicUrl)">复制链接</button></div>
            </div>
          </li>
        </ol>

        <p v-if="queue.length" class="queue-summary" aria-live="polite">成功 {{ counts.success }} · 跳过 {{ counts.skipped }} · 失败 {{ counts.failed }} · 等待 {{ counts.pending }}</p>
        <p v-if="stopRequested" class="queue-note">{{ running ? '当前文件完成后停止，不会开始下一个文件。' : '队列已停止，等待中的文件可继续上传。' }}</p>
      </div>

      <footer class="modal-actions upload-actions">
        <button class="secondary-button" type="button" :disabled="running" @click="emit('close')">关闭</button>
        <button v-if="counts.failed" class="secondary-button" type="button" :disabled="running" @click="retryFailed">重试失败项</button>
        <button v-if="running" class="secondary-button" type="button" :disabled="stopRequested" @click="requestStop">当前文件完成后停止</button>
        <button class="primary-button" type="button" :disabled="running || !counts.pending" @click="start()">{{ running ? '上传中…' : (counts.success || counts.skipped || counts.failed ? '继续上传' : '开始上传') }}</button>
      </footer>
    </section>

    <div v-if="conflictKey" class="conflict-mask">
      <section class="conflict-card" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-description">
        <h3 id="conflict-title">目标位置已有同名文件</h3>
        <code>/{{ conflictKey }}</code>
        <p id="conflict-description">请选择如何处理。覆盖会替换此 Object Key 当前对应的内容。</p>
        <label class="apply-conflicts"><input v-model="applyRemaining" type="checkbox" />对本次上传后续同名冲突使用相同选择</label>
        <div class="conflict-actions">
          <button class="danger-button" type="button" @click="chooseConflict('overwrite')">覆盖</button>
          <button class="secondary-button" type="button" @click="chooseConflict('skip')">不上传</button>
          <button class="primary-button" type="button" autofocus @click="chooseConflict('rename')">自动重命名</button>
        </div>
        <button class="pause-conflict" type="button" @click="requestStop">暂停队列，稍后决定</button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.upload-modal { width: min(860px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); display: flex; flex-direction: column; }
.upload-content { overflow: auto; padding: 24px; min-height: 0; }
.hidden-picker { display: none; }
.pick-actions, .queue-item-header, .filename-edit, .result-link, .conflict-actions { display: flex; align-items: center; gap: 10px; }
.pick-actions { flex-wrap: wrap; }
.pick-actions > span, .queue-size, .queue-note, .queue-summary { color: #77849b; font-size: 13px; }
.queue-note { line-height: 1.7; margin: 12px 0; }
.queue-empty { padding: 48px 12px; border: 1px dashed #cdd6e5; border-radius: 12px; color: #77849b; text-align: center; }
.upload-queue { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 12px; }
.queue-item { padding: 14px; border: 1px solid #e1e6ef; border-radius: 12px; min-width: 0; }
.queue-path { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
.queue-status, .queue-size { white-space: nowrap; }
.queue-status { font-size: 12px; color: #5f6d84; }
.status-success .queue-status { color: #148461; }
.status-failed .queue-status, .item-error { color: #bb3945; }
.filename-edit { margin-top: 10px; }
.filename-edit > span { font-size: 12px; white-space: nowrap; color: #77849b; }
.filename-edit input, .result-link input { flex: 1; min-width: 0; }
.filename-edit input { padding: 7px 10px; font-size: 13px; }
.item-error, .rename-notice { margin: 10px 0 0; font-size: 13px; line-height: 1.6; }
.rename-notice { color: #986417; }
.item-result code, .conflict-card code { display: block; overflow-wrap: anywhere; padding: 10px 0; color: #40506b; }
.result-link { margin-top: 2px; }
.result-link input { font-size: 12px; color: var(--text-main, #40506b); background: var(--bg-app, #f6f8fc); border: 1px solid var(--border-color, #e1e6ef); border-radius: 8px; padding: 9px 11px; }
.progress-bar { margin-top: 12px; }
.upload-actions { flex-shrink: 0; flex-wrap: wrap; }
.conflict-mask { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: #0e183675; z-index: 110; }
.conflict-card { width: min(540px, 100%); max-height: calc(100dvh - 40px); overflow: auto; padding: 26px; background: white; border-radius: 18px; box-shadow: 0 20px 60px #14264b30; }
.conflict-card h3 { margin: 0; font-size: 18px; }
.conflict-card p { line-height: 1.7; color: #5f6d84; font-size: 14px; }
.apply-conflicts { display: flex; flex-direction: row; align-items: center; gap: 8px; margin: 16px 0; color: #536079; font-size: 13px; }
.apply-conflicts input { width: 16px; height: 16px; }
.conflict-actions { flex-wrap: wrap; }
.danger-button { border: 1px solid #e8b7bd; color: #ac3543; background: #fff4f5; padding: 10px 18px; border-radius: 9px; cursor: pointer; }
.pause-conflict { border: 0; background: none; color: #71809a; padding: 14px 0 0; font-size: 13px; cursor: pointer; }
@media (max-width: 580px) {
  .upload-content { padding: 16px; }
  .queue-item-header { flex-wrap: wrap; }
  .queue-path { flex-basis: calc(100% - 40px); }
  .result-link { align-items: stretch; flex-direction: column; }
  .upload-actions button { flex: 1; }
}
</style>
