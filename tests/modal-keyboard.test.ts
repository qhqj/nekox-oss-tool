import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App, type Component } from 'vue'
import { flushPromises } from '@vue/test-utils'
import ConfigModal from '../src/components/ConfigModal.vue'
import UploadModal from '../src/components/UploadModal.vue'
import ImagePreviewModal from '../src/components/ImagePreviewModal.vue'
import { UploadStoppedError, type UploadOptions } from '../src/utils/upload'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))
let app: App | undefined
afterEach(async () => { app?.unmount(); app = undefined; await nextTick(); document.body.innerHTML = '' })

async function openModal(component: Component, extra: Record<string, unknown>) {
  const trigger = document.createElement('button'); trigger.textContent = 'Open'
  const outside = document.createElement('button'); outside.textContent = 'Background action'
  const host = document.createElement('div'); document.body.append(trigger, outside, host)
  const props = reactive({ open: false, ...extra })
  app = createApp({ render: () => h(component, { ...props, onClose: () => { props.open = false } }) })
  app.mount(host); trigger.focus(); props.open = true; await nextTick()
  return { props, trigger, outside }
}
function key(value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })
  document.activeElement!.dispatchEvent(event)
  return event
}
const config = { accounts: [], activeAccountId: '', connecting: false, error: '' }
function button(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((element) => element.textContent!.trim() === label)!
}
async function selectFile() {
  const picker = document.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(picker, 'files', { value: [new File(['synthetic'], 'file.txt')], configurable: true })
  picker.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
}

describe('actual modal keyboard behavior', () => {
  it('moves focus into account settings, traps Tab and restores the trigger after Escape', async () => {
    const { props, trigger } = await openModal(ConfigModal, config)
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    const last = dialog.querySelector<HTMLButtonElement>('button[type=submit]')!
    const first = dialog.querySelector<HTMLButtonElement>('button')!
    last.focus(); expect(key('Tab').defaultPrevented).toBe(true); expect(document.activeElement).toBe(first)
    first.focus(); key('Tab', true); expect(document.activeElement).toBe(last)
    key('Escape'); await nextTick(); await nextTick()
    expect(props.open).toBe(false); expect(document.activeElement).toBe(trigger)
  })
  it('blocks focus outside a busy account dialog and does not close during connection', async () => {
    const { props, outside } = await openModal(ConfigModal, { ...config, connecting: true })
    outside.focus()
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')!
    expect(document.activeElement).toBe(dialog)
    key('Escape'); await nextTick(); expect(props.open).toBe(true)
    props.connecting = false; await nextTick()
    key('Tab'); expect(dialog.contains(document.activeElement)).toBe(true)
  })
  it('moves focus into upload selection and restores its trigger when idle Escape closes', async () => {
    const { props, trigger } = await openModal(UploadModal, { prefix: '', accountLabel: 'Synthetic', service: {} })
    expect(document.querySelector('[role=dialog]')!.contains(document.activeElement)).toBe(true)
    key('Escape'); await nextTick(); await nextTick()
    expect(props.open).toBe(false); expect(document.activeElement).toBe(trigger)
  })
  it('restores an upload trigger disabled and blurred while its dialog opens', async () => {
    const { props, trigger } = await openModal(UploadModal, { prefix: '', accountLabel: 'Synthetic', service: {} })
    props.open = false; await nextTick()
    trigger.focus(); props.open = true; trigger.disabled = true; trigger.blur(); await nextTick()
    trigger.disabled = false; key('Escape'); await nextTick()
    expect(document.activeElement).toBe(trigger)
  })
  it('limits the nested conflict to safe initial focus, pauses on Escape and returns to the queue', async () => {
    const uploadFile = vi.fn(async (_prefix, _file, _name, options: UploadOptions) => {
      if (await options.resolveConflict!('file.txt') === null) throw new UploadStoppedError()
      throw new Error('Unexpected write')
    })
    const { props, trigger, outside } = await openModal(UploadModal, { prefix: '', accountLabel: 'Synthetic', service: { uploadFile } })
    await selectFile(); button('开始上传').click(); await flushPromises()
    const prompt = document.querySelector<HTMLElement>('[role=alertdialog]')!
    const queue = document.querySelector<HTMLElement>('[role=dialog]')!
    expect(document.activeElement).toBe(button('自动重命名'))
    expect(queue.hasAttribute('inert')).toBe(true)
    button('暂停队列，稍后决定').focus(); key('Tab')
    expect(document.activeElement).toBe(prompt.querySelector('input'))
    outside.focus(); expect(prompt.contains(document.activeElement)).toBe(true)
    key('Escape'); await flushPromises()
    expect(document.querySelector('[role=alertdialog]')).toBeNull()
    expect(props.open).toBe(true); expect(queue.contains(document.activeElement)).toBe(true)
    expect(queue.hasAttribute('inert')).toBe(false); expect(outside.hasAttribute('inert')).toBe(true)
    expect(uploadFile).toHaveBeenCalledOnce()
    key('Escape'); await nextTick()
    expect(props.open).toBe(false); expect(document.activeElement).toBe(trigger)
    expect(outside.hasAttribute('inert')).toBe(false)
  })
  it('ignores duplicate start and late completion when Escape pauses an active upload', async () => {
    let options!: UploadOptions, finish!: (value: unknown) => void
    const uploadFile = vi.fn((_prefix, _file, _name, value: UploadOptions) => { options = value; return new Promise((resolve) => { finish = resolve }) })
    const { props } = await openModal(UploadModal, { prefix: '', accountLabel: 'Synthetic', service: { uploadFile } })
    await selectFile(); const start = button('开始上传'); start.focus(); start.click(); start.click(); await nextTick()
    expect(uploadFile).toHaveBeenCalledOnce()
    key('Escape'); await flushPromises()
    expect(options.signal!.aborted).toBe(true); expect(props.open).toBe(true)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true }))
    await nextTick(); expect(props.open).toBe(true)
    options.onProgress!(100); finish({ status: 'success', result: { key: 'late', publicUrl: 'https://example.test/late', renamed: false } })
    await flushPromises()
    expect(document.querySelector('.item-result')).toBeNull()
    expect(document.body.textContent).toContain('等待 1')
  })
  it('restores background accessibility attributes and focus after preview closes or unmounts', async () => {
    const { props, trigger, outside } = await openModal(ImagePreviewModal, { name: 'Synthetic', url: '', error: '' })
    expect(outside.getAttribute('aria-hidden')).toBe('true')
    key('Escape'); await nextTick()
    expect(document.activeElement).toBe(trigger); expect(outside.hasAttribute('aria-hidden')).toBe(false)
    outside.setAttribute('aria-hidden', 'false'); props.open = true; await nextTick()
    app!.unmount(); app = undefined
    expect(outside.getAttribute('aria-hidden')).toBe('false'); expect(outside.hasAttribute('inert')).toBe(false)
    outside.focus(); expect(document.activeElement).toBe(outside)
  })
  it('starts a fresh queue for another account after closing, ignoring callbacks from the old queue', async () => {
    let oldOptions!: UploadOptions, finishOld!: (value: unknown) => void
    const firstService = { uploadFile: vi.fn((_prefix, _file, _name, options: UploadOptions) => { oldOptions = options; return new Promise((resolve) => { finishOld = resolve }) }) }
    const secondService = { uploadFile: vi.fn(async () => ({ status: 'success', result: { key: 'second/file.txt', publicUrl: 'https://example.test/second', renamed: false } })) }
    const { props, trigger } = await openModal(UploadModal, { prefix: 'first/', accountLabel: 'First', service: firstService })
    await selectFile(); button('开始上传').click(); await nextTick(); key('Escape'); await flushPromises()
    key('Escape'); await nextTick()
    Object.assign(props, { service: secondService, prefix: 'second/', accountLabel: 'Second' })
    trigger.focus(); props.open = true; await nextTick()
    expect(document.querySelectorAll('.queue-item')).toHaveLength(0)
    await selectFile(); button('开始上传').click(); await flushPromises()
    expect(secondService.uploadFile.mock.calls[0][0]).toBe('second/')
    expect((secondService.uploadFile.mock.calls[0][3] as UploadOptions).session).not.toBe(oldOptions.session)
    oldOptions.onProgress!(99); finishOld({ status: 'success', result: { key: 'first/late', publicUrl: 'https://example.test/first', renamed: false } })
    await flushPromises()
    expect(document.querySelector('.item-result code')!.textContent).toBe('/second/file.txt')
    expect(document.body.textContent).not.toContain('first/late')
  })
})
