import { createApp, nextTick } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import App from '../../src/App.vue'
import '../../src/style.css'
import { loadAccounts, saveAccounts } from '../../src/utils/config-storage'
import { downloadToUserDevice } from '../../src/utils/download'

// Only Tauri's local IPC protocol retains its native transport; remote fetch/XHR fail closed.
const ipcFetch = globalThis.fetch.bind(globalThis)
const counts = { init: 0, part1: 0, aborts: 0, late: 0, gets: 0, unexpected: 0 }
let holdUpload = true
let releaseRace: (() => void) | undefined
const response = (xml = '', headers = {}) => new Response(xml, { status: 200, headers })
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input)), method = options.method ?? 'GET'
  if (url.origin === 'http://ipc.localhost' && method === 'POST') return ipcFetch(input, options)
  if (url.hostname === 'synthetic-bucket.oss-cn-hangzhou.aliyuncs.com') {
    if (url.searchParams.has('list-type')) return response('<ListBucketResult><Name>synthetic-bucket</Name><IsTruncated>false</IsTruncated></ListBucketResult>')
    if (method === 'POST' && url.searchParams.has('uploads')) {
      counts.init += 1
      return response('<InitiateMultipartUploadResult><Bucket>synthetic-bucket</Bucket><Key>large.bin</Key><UploadId>offline-upload</UploadId></InitiateMultipartUploadResult>')
    }
    if (method === 'PUT' && url.searchParams.has('partNumber')) {
      const part = Number(url.searchParams.get('partNumber'))
      if (part === 1) counts.part1 += 1
      if (holdUpload && part !== 1) return new Promise((resolve, reject) => {
        options.signal!.addEventListener('abort', () => {
          counts.aborts += 1
          if (part === 2) setTimeout(() => { counts.late += 1; resolve(response('', { ETag: `"offline-${part}"` })) }, 150)
          else reject(new DOMException('Synthetic cancellation', 'AbortError'))
        }, { once: true })
      })
      return response('', { ETag: `"offline-${part}"` })
    }
    if (method === 'POST' && url.searchParams.has('uploadId')) return response('<CompleteMultipartUploadResult><ETag>offline-final</ETag></CompleteMultipartUploadResult>')
  }
  if (url.hostname === 'offline.example.test' && method === 'GET') {
    counts.gets += 1
    const size = 384 * 1024 + 37
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251)
    let sent = false
    const raceReady = new Promise<void>((resolve) => { if (url.pathname === '/raced') releaseRace = resolve })
    return new Response(new ReadableStream({ async pull(controller) {
      if (sent) {
        if (url.pathname === '/stream-fail') controller.error(new Error('Synthetic stream failure'))
        else { if (url.pathname === '/raced') await raceReady; controller.close() }
      } else { sent = true; controller.enqueue(bytes) }
    } }))
  }
  counts.unexpected += 1
  throw new Error('Unexpected synthetic request')
}
globalThis.XMLHttpRequest = class { constructor() { counts.unexpected += 1; throw new Error('XHR disabled in offline test') } } as any

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(check: () => boolean) {
  for (let n = 0; n < 300; n++) { if (check()) return; await pause(20) }
  throw new Error('Test condition timeout')
}
async function record(name: string, passed: boolean) {
  await invoke('report', { name, passed })
  if (!passed) throw new Error(`Case failed: ${name}`)
}
function button(label: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll('button')).find((item) => item.textContent!.trim() === label)
  if (!element) throw new Error('Test button missing')
  return element
}
async function run() {
  await record('actual-tauri-webview', isTauri())
  const initial = await invoke<{ reloaded: boolean }>('get_test_state')
  if (initial.reloaded) {
    const state = await loadAccounts()
    await record('credentials-absent-after-page-reload', state.accounts.length === 1 && state.accounts.every((account) => !account.config.accessKeySecret && !account.config.stsToken))
    await record('no-unexpected-network', counts.unexpected === 0)
    await invoke('stage', { name: 'done' }); await invoke('finish_test'); return
  }
  const state = { version: 1 as const, activeAccountId: 'offline-account', accounts: [{ id: 'offline-account', name: '离线合成账号', notes: '仅供隔离验收', config: {
    region: 'oss-cn-hangzhou', bucket: 'synthetic-bucket', accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-session-secret',
    stsToken: 'synthetic-session-token', endpoint: '', publicBaseUrl: 'https://offline.example.test',
  } }] }
  await saveAccounts(state)
  const memory = await loadAccounts()
  await record('credentials-present-only-in-session', memory.accounts[0].config.accessKeySecret === 'synthetic-session-secret')
  const raw = await invoke<string>('load_account_vault')
  const stored = JSON.parse(raw)
  await record('native-vault-strips-secret-and-token', stored.accounts.every((account: any) => !account.config.accessKeySecret && !account.config.stsToken))
  await record('isolated-browser-storage-no-credentials', !Object.keys(localStorage).some((key) => /synthetic-session-(secret|token)/.test(localStorage.getItem(key) ?? '')))
  const app = createApp(App); app.mount('#app')
  await wait(() => !button('上传文件 / 文件夹').disabled)
  button('上传文件 / 文件夹').click(); await nextTick()
  const picker = document.querySelector<HTMLInputElement>('input[type=file]')!
  const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(8 * 1024 * 1024)], 'large.bin'))
  picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
  button('开始上传').click()
  await wait(() => !!document.querySelector('.progress-bar') && document.body.textContent!.includes('本次会话已有分片记录'))
  await record('upload-locks-account', document.querySelector<HTMLSelectElement>('#account-switch')!.disabled)
  await invoke('stage', { name: 'upload-view' }); await pause(600)
  button('暂停当前上传').click()
  await wait(() => !document.querySelector('.progress-bar'))
  await record('current-upload-aborted', counts.aborts > 0 && document.body.textContent!.includes('等待 1'))
  holdUpload = false
  button('继续上传').click()
  await wait(() => !!document.querySelector('.item-result code'))
  await pause(250)
  await record('resume-skips-saved-part-and-init', counts.init === 1 && counts.part1 === 1)
  await record('late-upload-response-isolated', counts.late === 1 && document.querySelector('.item-result code')!.textContent === '/large.bin' && document.body.textContent!.includes('成功 1'))
  app.unmount()

  let signatures = 0
  for (const name of ['cancel-save', 'stream-save', 'stream-fail', 'stream-cancel', 'existing', 'raced']) {
    await invoke('stage', { name })
    const controller = new AbortController(), before = { gets: counts.gets, signatures }
    let race: Promise<unknown> | undefined
    let result: any, failed = false, wrote = false
    try {
      result = await downloadToUserDevice(() => { signatures += 1; return `https://offline.example.test/${name}` }, `${name}.bin`, {
        signal: controller.signal,
        onProgress: () => {
          wrote = true
          if (name === 'stream-cancel') controller.abort()
          if (name === 'raced' && !race) race = invoke('race_target').then(() => releaseRace!())
        },
      })
    } catch { failed = true }
    if (race) await race
    if (name === 'cancel-save') await record('cancel-dialog-no-signature-or-get', result?.status === 'cancelled' && signatures === before.signatures && counts.gets === before.gets)
    if (name === 'stream-save') await record('stream-download-saved', result?.status === 'saved')
    if (name === 'stream-fail') await record('stream-failure-reported', failed && wrote && counts.gets === before.gets + 1)
    if (name === 'stream-cancel') await record('stream-cancellation-reported', result?.status === 'cancelled' && wrote && counts.gets === before.gets + 1)
    if (name === 'existing') await record('existing-target-rejected-before-get', failed && signatures === before.signatures && counts.gets === before.gets)
    if (name === 'raced') await record('raced-target-rejected-at-commit', failed)
  }
  const files = await invoke<any>('verify_files'), native = await invoke<any>('get_test_state')
  await record('binary-ipc-bounded-chunks', native.chunks.length >= 4 && native.chunks.every((size: number) => size > 0 && size <= 128 * 1024))
  await record('saved-bytes-match', files.savedLength === 384 * 1024 + 37 && files.savedPattern)
  await record('failed-and-cancelled-output-absent', files.failedAbsent && files.cancelAbsent)
  await record('native-temporary-files-cleaned', files.parts === 0)
  await record('both-existing-targets-preserved', files.existingKept && files.racedKept)
  await record('no-unexpected-network-before-reload', counts.unexpected === 0)
  await invoke('mark_reload'); await invoke('stage', { name: 'reload' }); location.reload()
}
void run().catch(async () => {
  // A case ID / boolean is sufficient; never serialize URLs, headers or credentials.
  await invoke('report', { name: 'suite-completed', passed: false })
  await invoke('stage', { name: 'failed' }); await invoke('finish_test')
})
