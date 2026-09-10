<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { OssConfig } from '../types/oss'
import { applyParsedOssHost } from '../utils/oss-config'

const props = defineProps<{
  open: boolean
  initial: OssConfig
  connecting: boolean
  error: string
}>()

const emit = defineEmits<{
  close: []
  connect: [config: OssConfig]
}>()

const form = reactive<OssConfig>({ ...props.initial })
const parseHint = ref('')

watch(
  () => props.open,
  (open) => {
    if (open) {
      Object.assign(form, props.initial)
      parseHint.value = ''
    }
  },
)

function tryParseHostInput(input: string): boolean {
  if (!applyParsedOssHost(form, input)) return false
  parseHint.value = `已识别 Bucket：${form.bucket}，Region：${form.region}`
  return true
}

function onHostPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? ''
  if (!tryParseHostInput(text)) return
  event.preventDefault()
}

function onHostBlur(field: 'bucket' | 'region' | 'endpoint') {
  tryParseHostInput(form[field])
}

function submit() {
  tryParseHostInput(form.bucket)
  tryParseHostInput(form.region)
  tryParseHostInput(form.endpoint)
  emit('connect', { ...form })
}
</script>

<template>
  <div v-if="open" class="modal-mask">
    <section class="modal-card config-card" role="dialog" aria-modal="true" aria-label="OSS 配置">
      <header class="modal-header">
        <div class="modal-heading">
          <div class="modal-icon">☁</div>
          <div>
            <h2>OSS 连接配置</h2>
            <p>连接信息会保存在本机，下次启动自动恢复；请勿在不可信设备上使用。</p>
          </div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" :disabled="connecting" @click="emit('close')">×</button>
      </header>

      <div class="security-note">
        本地桌面工具会将 AccessKey 保存在本机存储中。若部署为公网网页，请勿启用完整凭证持久化。
      </div>

      <div class="form-grid">
        <label>
          <span>Region（示例：oss-cn-beijing）</span>
          <input
            v-model="form.region"
            placeholder="oss-cn-beijing"
            autocomplete="off"
            @paste="onHostPaste"
            @blur="onHostBlur('region')"
          />
        </label>
        <label>
          <span>Bucket（示例：my-bucket，仅填名称）</span>
          <input
            v-model="form.bucket"
            placeholder="my-bucket 或粘贴 geekzenalioss.oss-cn-beijing.aliyuncs.com"
            autocomplete="off"
            @paste="onHostPaste"
            @blur="onHostBlur('bucket')"
          />
        </label>
        <label>
          <span>AccessKey ID（示例：LTAI5t...）</span>
          <input v-model="form.accessKeyId" placeholder="LTAI5t..." autocomplete="off" />
        </label>
        <label>
          <span>AccessKey Secret</span>
          <input v-model="form.accessKeySecret" type="password" placeholder="••••••••" autocomplete="new-password" />
        </label>
        <label class="full-row">
          <span>STS Token（可选，示例：CAIS...）</span>
          <input v-model="form.stsToken" type="password" placeholder="使用 STS 临时凭证时填写" autocomplete="off" />
        </label>
        <label class="full-row">
          <span>OSS Endpoint（可选，示例：https://oss-cn-beijing.aliyuncs.com）</span>
          <input
            v-model="form.endpoint"
            placeholder="一般留空；需自定义时与 Region 地域一致"
            autocomplete="off"
            @paste="onHostPaste"
            @blur="onHostBlur('endpoint')"
          />
          <small>留空时由 Region 自动生成；若填写，Endpoint 地域须与 Region 一致。支持粘贴 Bucket 域名自动识别。</small>
        </label>
        <label class="full-row">
          <span>公共访问基础地址（可选，示例：https://cdn.example.com）</span>
          <input v-model="form.publicBaseUrl" placeholder="https://cdn.example.com" autocomplete="off" />
          <small>配置了 CDN / 自定义域名时建议填写；否则按 Bucket + Region 生成公共链接。</small>
        </label>
      </div>

      <p v-if="parseHint" class="parse-hint">{{ parseHint }}</p>

      <p v-if="error" class="error-box">{{ error }}</p>

      <footer class="modal-actions">
        <button class="secondary-button" type="button" :disabled="connecting" @click="emit('close')">取消</button>
        <button class="primary-button" type="button" :disabled="connecting" @click="submit">
          {{ connecting ? '连接中…' : '连接并刷新' }}
        </button>
      </footer>
    </section>
  </div>
</template>
