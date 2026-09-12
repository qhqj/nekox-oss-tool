import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import type { OssAccount } from '../src/types/accounts'
import ConfigModal from '../src/components/ConfigModal.vue'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))

function profile(id: string): OssAccount {
  return {
    id, name: `账号 ${id}`, notes: `用途 ${id}`,
    config: {
      region: 'oss-cn-beijing', bucket: `bucket-${id}`, accessKeyId: `mock-id-${id}`,
      accessKeySecret: `mock-secret-${id}`, stsToken: `mock-token-${id}`, endpoint: '', publicBaseUrl: '',
    },
  }
}

let app: App | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

function mount(selection?: { activeAccountId: string; initialSelectedAccountId: string }) {
  const events = { save: vi.fn(), connect: vi.fn(), remove: vi.fn() }
  const props = reactive({ open: true, accounts: [profile('a'), profile('b')], activeAccountId: 'a', initialSelectedAccountId: '', connecting: false, error: '', ...selection })
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(ConfigModal, { ...props, onSave: events.save, onConnect: events.connect, onRemove: events.remove }) })
  app.mount(root)
  return { props, events }
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === text)
  if (!found) throw new Error(`Button missing: ${text}`)
  return found
}

function input(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll('label')].find((element) => element.firstElementChild?.textContent?.trim().startsWith(label))?.querySelector('input')
  if (!found) throw new Error(`Input missing: ${label}`)
  return found
}

async function fill(label: string, value: string) {
  const element = input(label)
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function select(id: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('.account-item')].find((candidate) => candidate.textContent?.includes(`账号 ${id}`))!
  element.click()
  await nextTick()
}

describe('account profile dialog', () => {
  it('edits a failed switch target while labeling only the actual connected account', () => {
    const { props } = mount({ activeAccountId: 'a', initialSelectedAccountId: 'b' })
    props.error = '模拟连接失败'
    expect(input('AccessKey Secret').value).toBe('mock-secret-b')
    expect(document.querySelector('.current-badge')?.closest('.account-item')?.textContent).toContain('账号 a')
    expect(document.querySelector('.account-item.selected')?.textContent).toContain('账号 b')
    expect(document.querySelector('.account-item.selected .current-badge')).toBeNull()
  })

  it('shows no connection badge when a remembered profile is selected but disconnected', () => {
    mount({ activeAccountId: '', initialSelectedAccountId: 'b' })
    expect(input('AccessKey Secret').value).toBe('mock-secret-b')
    expect(document.querySelector('.current-badge')).toBeNull()
  })

  it('preserves edits across selections and connects the selected profile credentials', async () => {
    const { events } = mount()
    await fill('AccessKey Secret', 'changed-mock-secret')
    await select('b')
    expect(input('AccessKey Secret').value).toBe('mock-secret-b')
    await select('a')
    expect(input('AccessKey Secret').value).toBe('changed-mock-secret')
    button('保存并连接').click()
    await nextTick()
    expect(events.connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', config: expect.objectContaining({ accessKeySecret: 'changed-mock-secret' }) }))
    expect(input('AccessKey Secret').type).toBe('password')
    expect(input('STS Token').type).toBe('password')
  })

  it('starts new accounts without copying another profile credentials or notes', async () => {
    const { events } = mount()
    button('＋ 新增账号').click()
    await nextTick()
    expect(input('AccessKey ID').value).toBe('')
    expect(input('AccessKey Secret').value).toBe('')
    expect(input('STS Token').value).toBe('')
    expect(document.querySelector('textarea')?.value).toBe('')
    await fill('账号名称', '新账号名称')
    button('仅保存').click()
    expect(events.save).toHaveBeenCalledWith(expect.objectContaining({ name: '新账号名称', notes: '', config: expect.objectContaining({ accessKeySecret: '' }) }))
    expect(events.connect).not.toHaveBeenCalled()
  })

  it('requires an explicit local removal confirmation and selects a remaining profile', async () => {
    const { props, events } = mount()
    button('移除本机账号').click()
    await nextTick()
    expect(events.remove).not.toHaveBeenCalled()
    expect(document.querySelector('.remove-confirmation')?.textContent).toContain('Bucket 内的文件不受影响')
    button('确认移除本机账号').click()
    expect(events.remove).toHaveBeenCalledWith('a')
    props.accounts = [profile('b')]
    props.activeAccountId = 'b'
    await nextTick()
    expect(input('AccessKey Secret').value).toBe('mock-secret-b')
  })

  it('retains the attempted account draft after a failed connection and discards edits on close', async () => {
    const { props } = mount()
    await select('b')
    await fill('AccessKey Secret', 'attempted-mock-secret')
    props.activeAccountId = 'b'
    props.error = '模拟连接失败'
    await nextTick()
    expect(input('AccessKey Secret').value).toBe('attempted-mock-secret')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('模拟连接失败')
    props.open = false
    await nextTick()
    props.open = true
    await nextTick()
    expect(input('AccessKey Secret').value).toBe('mock-secret-b')
  })
})
