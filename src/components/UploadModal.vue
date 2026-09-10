<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { UploadResult } from '../types/oss'

const props = defineProps<{
  open: boolean
  prefix: string
  uploading: boolean
  progress: number
  result: UploadResult | null
  error: string
}>()

const emit = defineEmits<{
  close: []
  upload: [file: File, filename: string]
  copy: [text: string]
}>()

const file = ref<File | null>(null)
const filename = ref('')
const inputKey = ref(0)

const targetPath = computed(() => `${props.prefix}${filename.value || '文件名'}`)

watch(
  () => props.open,
  (open) => {
    if (open) {
      file.value = null
      filename.value = ''
      inputKey.value += 1
    }
  },
)

function onPick(event: Event) {
  const target = event.target as HTMLInputElement
  const picked = target.files?.[0] ?? null
  file.value = picked
  if (picked) filename.value = picked.name
}

function submit() {
  if (!file.value) return
  emit('upload', file.value, filename.value)
}
</script>

<template>
  <div v-if="open" class="modal-mask">
    <section class="modal-card" role="dialog" aria-modal="true" aria-label="上传文件">
      <header class="modal-header">
        <div class="modal-heading">
          <div class="modal-icon">↑</div>
          <div>
            <h2>上传文件</h2>
            <p>目标目录：/{{ prefix }}</p>
          </div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" :disabled="uploading" @click="emit('close')">×</button>
      </header>

      <div v-if="!result" class="upload-body">
        <label class="file-picker">
          <input :key="inputKey" type="file" @change="onPick" />
          <strong>{{ file ? file.name : '选择一个文件' }}</strong>
          <span>{{ file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : '不读取内容，选中后等待你确认上传' }}</span>
        </label>

        <label>
          <span>上传文件名</span>
          <input v-model="filename" placeholder="选择文件后可修改名称" :disabled="uploading" />
          <small>若目标目录存在同名文件，将自动改为 “文件名 (1).ext”。</small>
        </label>

        <div class="path-preview">/{{ targetPath }}</div>

        <div v-if="uploading" class="progress-wrap">
          <div class="progress-bar"><i :style="{ width: `${progress}%` }" /></div>
          <span>{{ progress }}%</span>
        </div>

        <p v-if="error" class="error-box">{{ error }}</p>
      </div>

      <div v-else class="upload-success">
        <div class="success-mark">✓</div>
        <h3>上传完成</h3>
        <p v-if="result.renamed">检测到同名文件，已自动重命名。</p>
        <code>/{{ result.key }}</code>
        <div class="url-box">
          <input :value="result.publicUrl" readonly />
          <button class="secondary-button" type="button" @click="emit('copy', result.publicUrl)">复制链接</button>
        </div>
      </div>

      <footer class="modal-actions">
        <button class="secondary-button" type="button" :disabled="uploading" @click="emit('close')">
          {{ result ? '完成' : '取消' }}
        </button>
        <button v-if="!result" class="primary-button" type="button" :disabled="!file || !filename.trim() || uploading" @click="submit">
          {{ uploading ? '上传中…' : '开始上传' }}
        </button>
      </footer>
    </section>
  </div>
</template>
