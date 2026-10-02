import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadToUserDevice, safeDownloadFileName } from '../src/utils/download'

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }))
vi.mock('@tauri-apps/api/core', () => tauri)

const MAX_CHUNK = 128 * 1024
const url = 'https://synthetic.example.test/object?signature=synthetic%2Bvalue&security-token=synthetic-token'
const sign = vi.fn(() => url)
const fetchMock = vi.fn()
let reader: {
  read: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  releaseLock: ReturnType<typeof vi.fn>
}

function stream(chunks: Uint8Array[]) {
  const values = [...chunks]
  reader = {
    read: vi.fn(async () => values.length ? { done: false, value: values.shift()! } : { done: true }),
    cancel: vi.fn(async () => {}), releaseLock: vi.fn(),
  }
  return { ok: true, status: 200, body: { getReader: () => reader }, arrayBuffer: vi.fn(() => { throw new Error('Whole-file buffering forbidden') }) }
}

beforeEach(() => {
  vi.resetAllMocks()
  tauri.isTauri.mockReturnValue(true)
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'begin_download') return 'synthetic-task'
    if (command === 'finish_download') return 'C:\\synthetic\\saved.bin'
  })
  sign.mockReturnValue(url)
  fetchMock.mockResolvedValue(stream([new Uint8Array([1, 2, 3])]))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('safe filename hints', () => {
  it.each([
    ['a/b\\c:*.txt', 'a_b_c__.txt'], ['CON.txt', '_CON.txt'], ['lpt¹.bin', '_lpt¹.bin'],
    ['..', 'download'], ['a. ', 'a'], ['图 片.jpg', '图 片.jpg'], ['\u0000file', '_file'], ['a\u0085.bin', 'a_.bin'],
  ])('normalizes %j without using it as a native path', (input, expected) => {
    expect(safeDownloadFileName(input)).toBe(expected)
  })
  it('bounds long Unicode names', () => { expect(Array.from(safeDownloadFileName('😀'.repeat(300)))).toHaveLength(120) })
})

describe('desktop streaming', () => {
  it('does not sign or fetch when the user cancels the save dialog', async () => {
    tauri.invoke.mockResolvedValueOnce(null)
    expect(await downloadToUserDevice(sign, 'file.bin')).toEqual({ status: 'cancelled' })
    expect(sign).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith('begin_download', { filename: 'file.bin' })
  })
  it('does nothing for an already cancelled task', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await downloadToUserDevice(sign, 'file.bin', { signal: controller.signal })).toEqual({ status: 'cancelled' })
    expect(tauri.invoke).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it('waits for the dialog, then creates a fresh signature and streams bounded binary chunks', async () => {
    const response = stream([new Uint8Array(MAX_CHUNK * 2 + 7), new Uint8Array(9)])
    fetchMock.mockResolvedValue(response)
    const progress = vi.fn()
    expect(await downloadToUserDevice(sign, 'file.bin', { onProgress: progress })).toEqual({ status: 'saved', path: 'C:\\synthetic\\saved.bin' })
    expect(tauri.invoke.mock.invocationCallOrder[0]).toBeLessThan(sign.mock.invocationCallOrder[0]!)
    expect(sign.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!)
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal) }))
    const writes = tauri.invoke.mock.calls.filter(([command]) => command === 'write_download_chunk')
    expect(writes.map(([, chunk]) => chunk.byteLength)).toEqual([MAX_CHUNK, MAX_CHUNK, 7, 9])
    for (const [, chunk, options] of writes) {
      expect(chunk).toBeInstanceOf(Uint8Array)
      expect(options).toEqual({ headers: { 'x-nekox-download': 'synthetic-task' } })
    }
    expect(progress.mock.calls.map(([bytes]) => bytes)).toEqual([MAX_CHUNK, MAX_CHUNK * 2, MAX_CHUNK * 2 + 7, MAX_CHUNK * 2 + 16])
    expect(response.arrayBuffer).not.toHaveBeenCalled()
    expect(reader.cancel).toHaveBeenCalledOnce(); expect(reader.releaseLock).toHaveBeenCalledOnce()
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'cancel_download')).toBe(false)
  })
  it('does not read the next network chunk while a disk write is pending', async () => {
    fetchMock.mockResolvedValue(stream([new Uint8Array(5), new Uint8Array(7)]))
    let finishWrite!: () => void
    tauri.invoke.mockImplementationOnce(async () => 'synthetic-task')
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    const task = downloadToUserDevice(sign, 'file.bin')
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'))
    expect(reader.read).toHaveBeenCalledOnce()
    finishWrite(); await task
    expect(reader.read).toHaveBeenCalledTimes(3)
  })
  it('cancels a target selected after cancellation without generating a URL', async () => {
    let select!: (id: string) => void
    tauri.invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { select = resolve }))
    const controller = new AbortController()
    const task = downloadToUserDevice(sign, 'file.bin', { signal: controller.signal })
    controller.abort(); select('synthetic-task')
    expect(await task).toEqual({ status: 'cancelled' })
    expect(sign).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
  })
  it('aborts transport and cleans its task when cancelled during transfer', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async (_url, options) => {
      controller.abort()
      expect(options.signal.aborted).toBe(true)
      throw new Error('synthetic-token')
    })
    expect(await downloadToUserDevice(sign, 'file.bin', { signal: controller.signal })).toEqual({ status: 'cancelled' })
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'finish_download')).toBe(false)
  })
  it.each(['network', 'read', 'write', 'finish'])('sanitizes %s failures and cleans only the task ID', async (stage) => {
    if (stage === 'network') fetchMock.mockRejectedValue(new Error(`synthetic-token ${url}`))
    if (stage === 'read') reader.read.mockRejectedValue(new Error('synthetic-token'))
    if (stage === 'write' || stage === 'finish') {
      const failedCommand = stage === 'write' ? 'write_download_chunk' : 'finish_download'
      tauri.invoke.mockImplementation(async (command) => {
        if (command === 'begin_download') return 'synthetic-task'
        if (command === failedCommand) throw new Error(`synthetic-token ${url}`)
      })
    }
    const error = await downloadToUserDevice(sign, 'file.bin').catch((reason: Error) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('synthetic')
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
  })
  it('reports safe HTTP status and closes the pending task', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 })
    await expect(downloadToUserDevice(sign, 'file.bin')).rejects.toThrow('HTTP 403')
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
  })
  it('rejects environments without a response stream without buffering fallback', async () => {
    const response = { ok: true, body: null, arrayBuffer: vi.fn() }; fetchMock.mockResolvedValue(response)
    await expect(downloadToUserDevice(sign, 'file.bin')).rejects.toThrow('WebView2')
    expect(response.arrayBuffer).not.toHaveBeenCalled()
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
  })
  it('reports unconfirmed cleanup without exposing native errors', async () => {
    fetchMock.mockRejectedValue(new Error('synthetic-token'))
    tauri.invoke.mockImplementation(async (command) => {
      if (command === 'begin_download') return 'synthetic-task'
      if (command === 'cancel_download') throw new Error('synthetic-token')
    })
    await expect(downloadToUserDevice(sign, 'file.bin')).rejects.toThrow('清理未确认')
  })
  it('still cleans the native task if reader teardown throws', async () => {
    reader.read.mockRejectedValue(new Error('synthetic-token'))
    reader.releaseLock.mockImplementation(() => { throw new Error('synthetic-token') })
    const error = await downloadToUserDevice(sign, 'file.bin').catch((reason: Error) => reason)
    expect((error as Error).message).not.toContain('synthetic')
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
  })
  it.each(['http://example.test/file', 'https://user:password@example.test/file', 'https://example.test/file#fragment', 'https://example.test/file#', 'https://example.test/\\file'])('rejects unsafe signed addresses %s', async (value) => {
    sign.mockReturnValue(value)
    await expect(downloadToUserDevice(sign, 'file.bin')).rejects.toThrow('HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tauri.invoke).toHaveBeenLastCalledWith('cancel_download', { id: 'synthetic-task' })
  })
})

describe('browser download ownership', () => {
  it('hands an exact HTTPS attachment URL to the browser without fetch, buffering or native commands', async () => {
    tauri.isTauri.mockReturnValue(false)
    let clicked: HTMLAnchorElement | null = null
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked = this })
    expect(await downloadToUserDevice(sign, 'CON.txt')).toEqual({ status: 'started' })
    const anchor = clicked as unknown as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe(url)
    expect(anchor.download).toBe('_CON.txt'); expect(sign).toHaveBeenCalledWith('_CON.txt')
    expect(anchor.target).toBe('_blank'); expect(anchor.rel).toBe('noopener noreferrer')
    expect(anchor.referrerPolicy).toBe('no-referrer'); expect(anchor.isConnected).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled(); expect(tauri.invoke).not.toHaveBeenCalled()
  })
  it('sanitizes URL-generation errors and does not leave links behind', async () => {
    tauri.isTauri.mockReturnValue(false); sign.mockImplementation(() => { throw new Error('synthetic-token') })
    await expect(downloadToUserDevice(sign, 'file.bin')).rejects.toThrow('HTTPS')
    expect(document.querySelector('a')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled()
  })
})
