<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import type { OssAccount } from '../types/accounts'
import { applyParsedOssHost } from '../utils/oss-config'
import { canAutoConnect, createInitialConfig } from '../utils/config-storage'

const props = defineProps<{
  open: boolean
  accounts: OssAccount[]
  /** Only the account backing the live OSS connection receives the connected badge. */
  activeAccountId: string
  /** The profile the user requested to edit, including a failed connection attempt. */
  initialSelectedAccountId?: string
  connecting: boolean
  error: string
}>()

const emit = defineEmits<{
  close: []
  connect: [account: OssAccount]
  save: [account: OssAccount]
  remove: [id: string]
}>()

function newAccount(): OssAccount {
  const id = globalThis.crypto?.randomUUID?.() ?? `account-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { id, name: '', notes: '', config: createInitialConfig() }
}

function clone(account: OssAccount): OssAccount {
  return { ...account, config: { ...account.config } }
}

const form = reactive<OssAccount>(newAccount())
const drafts = new Map<string, OssAccount>()
const newDraftId = ref('')
const parseHint = ref('')
const formError = ref('')
const confirmRemove = ref(false)
const desktop = isTauri()
const savedAccount = computed(() => props.accounts.find((account) => account.id === form.id))
const dirty = computed(() => !savedAccount.value || JSON.stringify(clone(form)) !== JSON.stringify(savedAccount.value))

function setDraft(account: OssAccount) {
  Object.assign(form, clone(account))
  parseHint.value = ''
  formError.value = ''
  confirmRemove.value = false
}

function selectAccount(id: string) {
  if (props.connecting || id === form.id) return
  drafts.set(form.id, clone(form))
  const account = drafts.get(id) ?? props.accounts.find((candidate) => candidate.id === id)
  if (account) setDraft(account)
}

function addAccount() {
  if (props.connecting) return
  if (newDraftId.value) {
    selectAccount(newDraftId.value)
    return
  }
  if (props.accounts.length >= 100) {
    formError.value = '最多保存 100 个账号，请先移除不再使用的本机账号。'
    return
  }
  drafts.set(form.id, clone(form))
  const account = newAccount()
  newDraftId.value = account.id
  setDraft(account)
}

watch(() => props.open, (open) => {
  if (!open) {
    // Release draft credentials when the dialog closes; saved credentials live in account state.
    drafts.clear()
    setDraft(newAccount())
    newDraftId.value = ''
    return
  }
  drafts.clear()
  const requestedId = props.initialSelectedAccountId || props.activeAccountId
  const account = props.accounts.find((candidate) => candidate.id === requestedId) ?? props.accounts[0]
  if (account) {
    newDraftId.value = ''
    setDraft(account)
  } else {
    const fresh = newAccount()
    newDraftId.value = fresh.id
    setDraft(fresh)
  }
}, { immediate: true })

watch(() => props.accounts, (accounts, previous) => {
  if (!props.open) return
  if (accounts.some((account) => account.id === newDraftId.value)) newDraftId.value = ''
  for (const prior of previous) {
    if (!accounts.some((account) => account.id === prior.id)) drafts.delete(prior.id)
  }
  if (form.id !== newDraftId.value && !accounts.some((account) => account.id === form.id)) {
    const next = accounts.find((account) => account.id === props.activeAccountId) ?? accounts[0]
    if (next) setDraft(next)
    else {
      const fresh = newAccount()
      newDraftId.value = fresh.id
      setDraft(fresh)
    }
  }
})

function tryParseHostInput(input: string): boolean {
  if (!applyParsedOssHost(form.config, input)) return false
  parseHint.value = `已识别 Bucket：${form.config.bucket}，Region：${form.config.region}`
  return true
}

function onHostPaste(event: ClipboardEvent) {
  if (!tryParseHostInput(event.clipboardData?.getData('text') ?? '')) return
  event.preventDefault()
}

function submit(connect: boolean) {
  if (props.connecting) return
  formError.value = ''
  if (!form.name.trim()) {
    formError.value = '请填写账号名称，便于在列表中区分。'
    return
  }
  tryParseHostInput(form.config.bucket)
  tryParseHostInput(form.config.region)
  tryParseHostInput(form.config.endpoint)
  if (connect && !canAutoConnect(form.config)) {
    formError.value = '连接前请填写 Region、Bucket、AccessKey ID 和 AccessKey Secret。'
    return
  }
  const account = clone(form)
  account.name = account.name.trim()
  account.notes = account.notes.trim()
  if (connect) emit('connect', account)
  else emit('save', account)
}

function removeAccount() {
  if (!savedAccount.value || props.connecting) return
  emit('remove', form.id)
  confirmRemove.value = false
}
</script>

<template>
  <div v-if="open" class="modal-mask">
    <section class="modal-card config-card" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
      <header class="modal-header">
        <div class="modal-heading">
          <div class="modal-icon">☁</div>
          <div>
            <h2 id="account-dialog-title">账号与连接</h2>
            <p>为不同 AccessKey、Bucket 保存独立账号，选中后连接。</p>
          </div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" :disabled="connecting" @click="emit('close')">×</button>
      </header>

      <div class="security-note">
        <template v-if="desktop">Windows 桌面版使用当前 Windows 用户的系统加密保存凭证。</template>
        <template v-else>网页版只保存账号资料；Secret 和 STS Token 仅在本次页面会话保留，刷新或重启后需重新输入。</template>
        长期 AccessKey 适用于本地 / 内网兼容使用，公网使用优先配置 STS 临时凭证。
      </div>

      <div class="account-workspace">
        <aside class="account-sidebar" aria-label="账号列表">
          <div class="account-list-heading"><strong>本机账号</strong><span>{{ accounts.length }}</span></div>
          <button class="secondary-button add-account" type="button" :disabled="connecting" @click="addAccount">＋ 新增账号</button>
          <div class="account-list">
            <button
              v-for="account in accounts"
              :key="account.id"
              class="account-item"
              :class="{ selected: form.id === account.id }"
              type="button"
              :aria-pressed="form.id === account.id"
              :disabled="connecting"
              @click="selectAccount(account.id)"
            >
              <strong>{{ account.name }}<span v-if="account.id === activeAccountId" class="current-badge">当前连接</span></strong>
              <span>{{ account.config.bucket || '未填写 Bucket' }}</span>
              <small v-if="account.notes">{{ account.notes }}</small>
            </button>
            <button v-if="newDraftId" class="account-item" :class="{ selected: form.id === newDraftId }" type="button" :disabled="connecting" @click="selectAccount(newDraftId)">
              <strong>新账号</strong><small>尚未保存</small>
            </button>
          </div>
          <p class="draft-note">切换列表会保留未保存的填写内容；关闭窗口会放弃这些修改。</p>
        </aside>

        <form class="account-editor" autocomplete="off" @submit.prevent="submit(true)">
          <fieldset :disabled="connecting">
            <div class="form-grid">
              <label class="full-row">
                <span>账号名称 <span v-if="dirty" class="draft-marker">· 未保存</span></span>
                <input v-model="form.name" maxlength="60" placeholder="例如：个人图床 / 测试环境" />
              </label>
              <label class="full-row">
                <span>备注（可选）</span>
                <textarea v-model="form.notes" rows="2" maxlength="300" placeholder="填写用途或负责人，不要在备注中填写密钥" />
              </label>
              <label>
                <span>Region</span>
                <input v-model="form.config.region" placeholder="oss-cn-beijing" @paste="onHostPaste" @blur="tryParseHostInput(form.config.region)" />
              </label>
              <label>
                <span>Bucket</span>
                <input v-model="form.config.bucket" placeholder="my-bucket 或粘贴 Bucket 域名" @paste="onHostPaste" @blur="tryParseHostInput(form.config.bucket)" />
              </label>
              <label>
                <span>AccessKey ID</span>
                <input v-model="form.config.accessKeyId" placeholder="LTAI5t..." />
              </label>
              <label>
                <span>AccessKey Secret</span>
                <input v-model="form.config.accessKeySecret" type="password" placeholder="请输入密钥" autocomplete="new-password" />
              </label>
              <label class="full-row">
                <span>STS Token（可选）</span>
                <input v-model="form.config.stsToken" type="password" placeholder="使用 STS 临时凭证时填写" autocomplete="new-password" />
                <small>临时凭证到期后需更新 Secret 与 Token。</small>
              </label>
              <label class="full-row">
                <span>OSS Endpoint（可选）</span>
                <input v-model="form.config.endpoint" placeholder="https://oss-cn-beijing.aliyuncs.com" @paste="onHostPaste" @blur="tryParseHostInput(form.config.endpoint)" />
                <small>一般留空；自定义时地域须与 Region 一致。支持粘贴 Bucket 域名自动识别。</small>
              </label>
              <label class="full-row">
                <span>公共访问基础地址（可选）</span>
                <input v-model="form.config.publicBaseUrl" placeholder="https://cdn.example.com" />
                <small>配置 CDN / 自定义域名时填写；否则使用 Bucket + Region 生成公共链接。</small>
              </label>
            </div>
          </fieldset>

          <p v-if="parseHint" class="parse-hint">{{ parseHint }}</p>
          <p v-if="formError || error" class="error-box" role="alert">{{ formError || error }}</p>

          <div v-if="confirmRemove" class="remove-confirmation">
            <p>从本机移除“{{ savedAccount?.name }}”的配置和凭证？Bucket 内的文件不受影响。</p>
            <div><button class="secondary-button" type="button" :disabled="connecting" @click="confirmRemove = false">取消</button><button class="secondary-button danger-button" type="button" :disabled="connecting" @click="removeAccount">确认移除本机账号</button></div>
          </div>
          <footer class="modal-actions account-actions">
            <button v-if="savedAccount && !confirmRemove" class="remove-button" type="button" :disabled="connecting" @click="confirmRemove = true">移除本机账号</button>
            <span class="action-spacer" />
            <button class="secondary-button" type="button" :disabled="connecting" @click="submit(false)">仅保存</button>
            <button class="primary-button" type="submit" :disabled="connecting">{{ connecting ? '处理中…' : '保存并连接' }}</button>
          </footer>
        </form>
      </div>
    </section>
  </div>
</template>

<style scoped>
.config-card { width: min(940px, 94vw); }
.account-workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr); margin-top: 16px; }
.account-sidebar { padding: 4px 14px 18px; border-right: 1px solid var(--border-soft); }
.account-list-heading { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 0 2px 12px; }
.account-list-heading span { color: var(--text-3); }
.add-account { width: 100%; text-align: left; }
.account-list { display: grid; gap: 6px; margin-top: 12px; max-height: 440px; overflow: auto; }
.account-item { width: 100%; min-width: 0; display: grid; gap: 6px; padding: 11px 10px; border: 1px solid transparent; border-radius: 8px; text-align: left; color: var(--text); background: transparent; overflow-wrap: anywhere; }
.account-item:hover { background: var(--bg-hover); }
.account-item.selected { border-color: var(--accent); background: var(--accent-soft); }
.account-item strong { font-size: 12px; font-weight: 600; }
.account-item > span { font-size: 10px; color: var(--text-2); }
.account-item small { color: var(--text-2); font-size: 10px; line-height: 1.5; white-space: pre-wrap; }
.current-badge { display: inline-block; margin-left: 6px; border-radius: 4px; padding: 1px 4px; background: var(--green-soft); color: var(--green); font-size: 9px; }
.draft-note { margin-top: 18px; font-size: 10px; color: var(--text-3); line-height: 1.7; }
.account-editor { min-width: 0; }
.account-editor fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.account-editor .form-grid { padding-top: 0; }
.draft-marker { color: var(--accent); }
textarea { width: 100%; min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-app); color: var(--text); padding: 8px 9px; font: inherit; font-size: 12.5px; resize: vertical; }
textarea:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
.account-actions { flex-wrap: wrap; }
.action-spacer { flex: 1; }
.remove-button { border: 0; padding: 7px 0; color: var(--red); font-size: 11px; background: transparent; }
.danger-button { color: var(--red); border-color: var(--red); }
.remove-confirmation { margin: 0 20px 16px; padding: 10px; border-radius: 8px; background: var(--red-soft); color: var(--red); font-size: 11px; line-height: 1.6; }
.remove-confirmation p { margin: 0 0 8px; overflow-wrap: anywhere; }
.remove-confirmation div { display: flex; gap: 8px; justify-content: flex-end; }
@media (max-width: 700px) {
  .account-workspace { grid-template-columns: 1fr; }
  .account-sidebar { border-right: 0; border-bottom: 1px solid var(--border-soft); margin-bottom: 18px; }
  .account-list { max-height: 180px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .draft-note { margin: 10px 0 0; }
  .account-editor .form-grid { grid-template-columns: 1fr; }
}
</style>
