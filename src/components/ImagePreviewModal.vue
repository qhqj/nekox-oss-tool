<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  name: string
  url: string
  error: string
}>()

const emit = defineEmits<{
  close: []
}>()

const loading = ref(false)
const imageError = ref('')

watch(
  () => [props.open, props.url, props.error] as const,
  ([open, url, error]) => {
    imageError.value = ''
    loading.value = Boolean(open && url && !error)
  },
)

function onImageLoad() {
  loading.value = false
}

function onImageError() {
  loading.value = false
  imageError.value = '图片加载失败，请检查 Bucket CORS 是否允许 GET。'
}
</script>

<template>
  <div v-if="open" class="modal-mask preview-mask">
    <section class="preview-card" role="dialog" aria-modal="true" :aria-label="`${name} 预览`">
      <header class="preview-header">
        <div>
          <h2>{{ name }}</h2>
          <p>请使用右上角按钮关闭，避免误触遮罩关闭</p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="preview-body">
        <p v-if="error" class="preview-status preview-error">{{ error }}</p>
        <p v-else-if="loading" class="preview-status">加载中…</p>
        <p v-else-if="imageError" class="preview-status preview-error">{{ imageError }}</p>
        <img v-show="!error && !imageError" :src="url" :alt="name" @load="onImageLoad" @error="onImageError" />
      </div>
    </section>
  </div>
</template>
