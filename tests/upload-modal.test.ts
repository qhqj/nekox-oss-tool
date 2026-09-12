import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UploadModal from '../src/components/UploadModal.vue'
import type { OssBrowserService } from '../src/services/oss'
import { UploadStoppedError } from '../src/utils/upload'
import type { UploadOptions } from '../src/utils/upload'

const uploadFile = vi.fn()
const start = () => mount(UploadModal, { props: {
  open: true, prefix: 'current/', accountLabel: '测试账号', service: { uploadFile } as unknown as OssBrowserService,
} })
const success = (relativePath: string) => ({ status: 'success', result: {
  key: `current/${relativePath}`, publicUrl: `https://example.test/current/${relativePath}`, renamed: false,
} })
const click = async (wrapper: VueWrapper, text: string) => {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === text)
  expect(button, `button ${text}`).toBeDefined()
  await button!.trigger('click')
}
const select = async (wrapper: VueWrapper, files: File[], folder = false) => {
  const input = wrapper.findAll('input[type="file"]')[folder ? 1 : 0]
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
}
const files = () => [new File(['first'], 'a.txt'), new File(['second'], 'b.txt')]

beforeEach(() => {
  vi.resetAllMocks()
  uploadFile.mockImplementation(async (_prefix: string, _file: File, path: string) => success(path))
})

describe('batch upload modal', () => {
  it('uploads sequentially and emits one completion for a successful batch', async () => {
    let finishFirst: (() => void) | undefined
    uploadFile.mockImplementationOnce((_prefix: string, _file: File, path: string) => new Promise((resolve) => {
      finishFirst = () => resolve(success(path))
    }))
    const wrapper = start()
    await select(wrapper, files())
    await click(wrapper, '开始上传')
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('上传中')
    finishFirst!()
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('completed')).toHaveLength(1)
    expect(wrapper.emitted('busy')).toEqual([[true], [false]])
    expect(wrapper.findAll('.item-result code').map((item) => item.text())).toEqual(['/current/a.txt', '/current/b.txt'])
    expect(wrapper.findAll('input[aria-label="公共 URL"]')).toHaveLength(2)
    wrapper.unmount()
  })
  it('preserves folder root and recursive paths', async () => {
    const wrapper = start()
    const picked = new File(['child'], 'photo.png')
    Object.defineProperty(picked, 'webkitRelativePath', { value: '旅行/杭州/photo.png' })
    await select(wrapper, [picked], true)
    await click(wrapper, '开始上传')
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledWith('current/', picked, '旅行/杭州/photo.png', expect.any(Object))
    wrapper.unmount()
  })
  it('rejects a picker path containing traversal and manual slashes', async () => {
    const wrapper = start()
    const picked = new File(['bad'], 'file.txt')
    Object.defineProperty(picked, 'webkitRelativePath', { value: 'root/../file.txt' })
    await select(wrapper, [picked], true)
    expect(wrapper.text()).toContain('1 个文件的相对路径无效')
    await select(wrapper, [files()[0]])
    await wrapper.get('input[aria-label="上传文件名"]').setValue('../file.txt')
    await click(wrapper, '开始上传')
    await flushPromises()
    expect(uploadFile).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('文件名不能包含')
    wrapper.unmount()
  })
  it('removes a pending file while the current file is in flight', async () => {
    let finishFirst: (() => void) | undefined
    uploadFile.mockImplementationOnce((_prefix: string, _file: File, path: string) => new Promise((resolve) => { finishFirst = () => resolve(success(path)) }))
    const wrapper = start()
    await select(wrapper, files())
    await click(wrapper, '开始上传')
    await wrapper.get('button[aria-label="移除 b.txt"]').trigger('click')
    finishFirst!()
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('b.txt')
    wrapper.unmount()
  })
  it('stops after the current file and can resume the remaining queue', async () => {
    let finishFirst: (() => void) | undefined
    uploadFile.mockImplementationOnce((_prefix: string, _file: File, path: string) => new Promise((resolve) => { finishFirst = () => resolve(success(path)) }))
    const wrapper = start()
    await select(wrapper, files())
    await click(wrapper, '开始上传')
    await click(wrapper, '当前文件完成后停止')
    finishFirst!()
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('等待 1')
    await click(wrapper, '继续上传')
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('completed')).toHaveLength(2)
    wrapper.unmount()
  })
  it('continues after a failure and can retry that failed item only', async () => {
    uploadFile.mockRejectedValueOnce(new Error('请求超时，请检查网络后重试。'))
    const wrapper = start()
    await select(wrapper, files())
    await click(wrapper, '开始上传')
    await flushPromises()
    expect(wrapper.text()).toContain('成功 1 · 跳过 0 · 失败 1')
    await click(wrapper, '重试')
    await flushPromises()
    expect(uploadFile).toHaveBeenCalledTimes(3)
    expect(uploadFile.mock.lastCall?.[2]).toBe('a.txt')
    expect(wrapper.text()).toContain('成功 2 · 跳过 0 · 失败 0')
    wrapper.unmount()
  })
  it.each([
    ['覆盖', 'overwrite'], ['不上传', 'skip'], ['自动重命名', 'rename'],
  ])('passes the %s conflict choice and applies it to remaining conflicts', async (label, action) => {
    const decisions: unknown[] = []
    uploadFile.mockImplementation(async (_prefix: string, _file: File, path: string, options: UploadOptions) => {
      const choice = await options.resolveConflict!(`current/${path}`)
      decisions.push(choice)
      return choice === 'skip' ? { status: 'skipped', key: `current/${path}` } : success(path)
    })
    const wrapper = start()
    await select(wrapper, files())
    await click(wrapper, '开始上传')
    await flushPromises()
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true)
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await click(wrapper, label)
    await flushPromises()
    expect(decisions).toEqual([action, action])
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.emitted('completed')?.length ?? 0).toBe(action === 'skip' ? 0 : 1)
    wrapper.unmount()
  })
  it('pauses a pending conflict and leaves its file waiting', async () => {
    uploadFile.mockImplementation(async (_prefix: string, _file: File, path: string, options: UploadOptions) => {
      if (await options.resolveConflict!(`current/${path}`) === null) throw new UploadStoppedError()
      return success(path)
    })
    const wrapper = start()
    await select(wrapper, files())
    await click(wrapper, '开始上传')
    await flushPromises()
    await click(wrapper, '暂停队列，稍后决定')
    await flushPromises()
    expect(wrapper.text()).toContain('等待 2')
    expect(wrapper.emitted('busy')).toEqual([[true], [false]])
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
