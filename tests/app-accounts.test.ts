import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/App.vue'

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), connect: vi.fn(), list: vi.fn(), disconnect: vi.fn(),
}))
vi.mock('../src/utils/config-storage', () => ({
  createInitialConfig: () => ({ region: 'oss-cn-beijing', bucket: '', accessKeyId: '', accessKeySecret: '', stsToken: '', endpoint: '', publicBaseUrl: '' }),
  canAutoConnect: (config: { accessKeySecret: string }) => Boolean(config.accessKeySecret),
  loadAccounts: mocks.load,
  saveAccounts: mocks.save,
}))
vi.mock('../src/services/oss', () => ({
  OssBrowserService: class {
    connect = mocks.connect
    list = mocks.list
    disconnect = mocks.disconnect
  },
}))
vi.mock('../src/utils/windowControls', () => ({
  isDesktopShell: () => false, startWindowDrag: vi.fn(), toggleMaximizeWindow: vi.fn(),
}))
const account = (id: string) => ({
  id, name: `账号 ${id}`, notes: `备注 ${id}`,
  config: { region: 'oss-cn-beijing', bucket: `bucket-${id}`, accessKeyId: `id-${id}`, accessKeySecret: 'synthetic-secret', stsToken: '', endpoint: '', publicBaseUrl: '' },
})
const result = (name: string) => ({ entries: [{ type: 'file', name, key: name, size: 12 }], isTruncated: false, nextContinuationToken: '' })
const start = () => mount(App, { global: { stubs: {
  ConfigModal: { name: 'ConfigModal', props: ['open', 'accounts', 'activeAccountId', 'error'], template: '<div />' },
  UploadModal: { name: 'UploadModal', props: ['open', 'prefix', 'service', 'accountLabel'], template: '<div />' },
  ImagePreviewModal: true, WindowControls: true,
} } })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.load.mockResolvedValue({ version: 1, accounts: [account('a'), account('b')], activeAccountId: 'a' })
  mocks.save.mockResolvedValue(undefined)
  mocks.connect.mockResolvedValue(undefined)
  mocks.list.mockResolvedValue(result('first.txt'))
})

describe('account and upload isolation', () => {
  it('labels saved edits while continuing to identify the actual connected bucket', async () => {
    const wrapper = start()
    await flushPromises()
    const edited = account('a')
    edited.config.bucket = 'new-saved-bucket'
    wrapper.findComponent({ name: 'ConfigModal' }).vm.$emit('save', edited)
    await flushPromises()
    expect(wrapper.get('#account-switch').text()).toContain('bucket-a（修改待重连）')
    expect(wrapper.findComponent({ name: 'UploadModal' }).props('accountLabel')).toBe('账号 a · bucket-a')
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not advance pagination twice while a page request is pending', async () => {
    mocks.list.mockResolvedValueOnce({ ...result('first.txt'), isTruncated: true, nextContinuationToken: 'page-two' })
    const wrapper = start()
    await flushPromises()
    let finish: (value: ReturnType<typeof result>) => void = () => {}
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const next = wrapper.findAll('button').find((button) => button.text() === '下一页')!
    await next.trigger('click')
    await next.trigger('click')
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('第 2 页')
    finish(result('second.txt'))
    await flushPromises()
    expect(wrapper.text()).toContain('second.txt')
    wrapper.unmount()
  })

  it('keeps the existing connection and files when switching fails', async () => {
    const wrapper = start()
    await flushPromises()
    mocks.connect.mockRejectedValueOnce(new Error('连接失败'))
    await wrapper.get('#account-switch').setValue('b')
    await flushPromises()
    expect(wrapper.text()).toContain('bucket-a')
    expect(wrapper.text()).toContain('first.txt')
    expect(wrapper.findComponent({ name: 'ConfigModal' }).props('error')).toBe('连接失败')
    expect(mocks.save).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps the current connection if a successfully checked profile cannot be saved', async () => {
    const wrapper = start()
    await flushPromises()
    mocks.save.mockRejectedValueOnce(new Error('无法保存'))
    await wrapper.get('#account-switch').setValue('b')
    await flushPromises()
    expect(wrapper.text()).toContain('bucket-a')
    expect(wrapper.findComponent({ name: 'ConfigModal' }).props('error')).toBe('无法保存')
    wrapper.unmount()
  })

  it('switches to the new account only after connect and persistence succeed', async () => {
    const wrapper = start()
    await flushPromises()
    mocks.list.mockResolvedValueOnce(result('second.txt'))
    await wrapper.get('#account-switch').setValue('b')
    await flushPromises()
    expect(wrapper.text()).toContain('bucket-b')
    expect(wrapper.text()).toContain('second.txt')
    expect(wrapper.text()).not.toContain('first.txt')
    expect(mocks.save.mock.lastCall?.[0].activeAccountId).toBe('b')
    wrapper.unmount()
  })

  it('blocks profile changes for the lifetime of an upload dialog', async () => {
    const wrapper = start()
    await flushPromises()
    const upload = wrapper.findAll('button').find((button) => button.text() === '上传文件 / 文件夹')!
    await upload.trigger('click')
    expect(wrapper.get('#account-switch').attributes('disabled')).toBeDefined()
    wrapper.findComponent({ name: 'ConfigModal' }).vm.$emit('connect', account('b'))
    await flushPromises()
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'UploadModal' }).props('accountLabel')).toBe('账号 a · bucket-a')
    wrapper.unmount()
  })

  it('disconnects when removing the current local account', async () => {
    const wrapper = start()
    await flushPromises()
    wrapper.findComponent({ name: 'ConfigModal' }).vm.$emit('remove', 'a')
    await flushPromises()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('first.txt')
    expect(mocks.save.mock.lastCall?.[0].accounts.map((item: { id: string }) => item.id)).toEqual(['b'])
    wrapper.unmount()
  })

  it('does not overwrite account storage after a vault load error', async () => {
    mocks.load.mockRejectedValueOnce(new Error('无法读取账号'))
    const wrapper = start()
    await flushPromises()
    wrapper.findComponent({ name: 'ConfigModal' }).vm.$emit('save', account('c'))
    await flushPromises()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'ConfigModal' }).props('error')).toContain('避免覆盖原有账号')
    wrapper.unmount()
  })
})
