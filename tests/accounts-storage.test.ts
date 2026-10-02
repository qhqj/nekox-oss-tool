import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountState } from '../src/types/accounts'

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }))
vi.mock('@tauri-apps/api/core', () => tauri)

const LEGACY_KEY = 'nekox-oss-tool/config'
const ACCOUNTS_KEY = 'nekox-oss-tool/accounts'

function accountState(): AccountState {
  return {
    version: 1,
    activeAccountId: 'account-1',
    accounts: [{
      id: 'account-1', name: '测试图床', notes: '仅使用模拟凭证',
      config: {
        region: 'oss-cn-beijing', bucket: 'example-bucket', accessKeyId: 'simulated-id',
        accessKeySecret: 'simulated-secret', stsToken: 'simulated-token', endpoint: '', publicBaseUrl: '',
      },
    }],
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  localStorage.clear()
  tauri.invoke.mockReset()
  tauri.isTauri.mockReturnValue(false)
})

describe('web account storage', () => {
  it('persists only metadata and keeps credentials in the current module session', async () => {
    const storage = await import('../src/utils/config-storage')
    const state = accountState()
    await storage.saveAccounts(state)
    const raw = localStorage.getItem(ACCOUNTS_KEY)!
    expect(raw).not.toContain('simulated-secret')
    expect(raw).not.toContain('simulated-token')
    expect(raw).not.toContain('accessKeySecret')
    expect(raw).not.toContain('stsToken')
    expect(JSON.parse(raw).accounts[0].notes).toBe('仅使用模拟凭证')
    expect((await storage.loadAccounts()).accounts[0].config.accessKeySecret).toBe('simulated-secret')

    vi.resetModules()
    const restarted = await import('../src/utils/config-storage')
    const restored = await restarted.loadAccounts()
    expect(restored.accounts[0].config.accessKeySecret).toBe('')
    expect(restored.accounts[0].config.stsToken).toBe('')
    expect(restarted.canAutoConnect(restored.accounts[0].config)).toBe(false)
  })

  it('migrates legacy credentials into session memory and removes plaintext storage', async () => {
    const state = accountState()
    localStorage.setItem(LEGACY_KEY, JSON.stringify(state.accounts[0].config))
    const storage = await import('../src/utils/config-storage')
    const migrated = await storage.loadAccounts()
    expect(migrated.accounts).toHaveLength(1)
    expect(migrated.accounts[0].config.accessKeySecret).toBe('simulated-secret')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(ACCOUNTS_KEY)).not.toContain('simulated-secret')
    expect(localStorage.getItem(ACCOUNTS_KEY)).not.toContain('simulated-token')
    expect((await storage.loadAccounts()).accounts).toHaveLength(1)
  })

  it('does not reuse persisted secret fields from account metadata and strips them', async () => {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accountState()))
    const storage = await import('../src/utils/config-storage')
    const state = await storage.loadAccounts()
    expect(state.accounts[0].config.accessKeySecret).toBe('')
    expect(state.accounts[0].config.stsToken).toBe('')
    expect(localStorage.getItem(ACCOUNTS_KEY)).not.toContain('simulated-secret')
  })

  it('removes credentials from memory when a profile is removed', async () => {
    const storage = await import('../src/utils/config-storage')
    await storage.saveAccounts(accountState())
    await storage.saveAccounts({ version: 1, accounts: [], activeAccountId: '' })
    const metadata = accountState()
    metadata.accounts[0].config.accessKeySecret = ''
    metadata.accounts[0].config.stsToken = ''
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(metadata))
    expect((await storage.loadAccounts()).accounts[0].config.accessKeySecret).toBe('')
  })

  it('clears malformed legacy payloads without displaying their contents', async () => {
    localStorage.setItem(LEGACY_KEY, '{"accessKeySecret":"simulated-secret"')
    const storage = await import('../src/utils/config-storage')
    const state = await storage.loadAccounts()
    expect(state.accounts).toEqual([])
    expect(state.storageWarning).toContain('格式无效')
    expect(state.storageWarning).not.toContain('simulated-secret')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('keeps migrated credentials usable in the returned session when metadata persistence fails', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(accountState().accounts[0].config))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const storage = await import('../src/utils/config-storage')
    const state = await storage.loadAccounts()
    expect(state.accounts[0].config.accessKeySecret).toBe('simulated-secret')
    expect(state.storageWarning).toContain('保存失败')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it.each([
    '{"accounts":"simulated-secret"',
    JSON.stringify({ version: 9, accounts: [], activeAccountId: '' }),
    JSON.stringify({ ...accountState(), accounts: [...accountState().accounts, ...accountState().accounts] }),
    JSON.stringify({ ...accountState(), accounts: [{ ...accountState().accounts[0], config: { bucket: 123 } }] }),
  ])('rejects malformed or unsupported account payloads without echoing data', async (raw) => {
    localStorage.setItem(ACCOUNTS_KEY, raw)
    const storage = await import('../src/utils/config-storage')
    await expect(storage.loadAccounts()).rejects.toThrow('本机账号数据格式无效')
    expect(localStorage.getItem(ACCOUNTS_KEY)).toBe(raw)
  })
})

describe('desktop encrypted account vault', () => {
  beforeEach(() => tauri.isTauri.mockReturnValue(true))

  it('saves encrypted metadata while retaining credentials only in session memory', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    const storage = await import('../src/utils/config-storage')
    await storage.saveAccounts(accountState())
    expect(tauri.invoke).toHaveBeenCalledWith('save_account_vault', { data: expect.any(String) })
    const raw = tauri.invoke.mock.calls[0][1].data
    const expected = accountState()
    expected.accounts[0].config.accessKeySecret = ''
    expected.accounts[0].config.stsToken = ''
    expect(JSON.parse(raw)).toEqual(expected)
    expect(raw).not.toContain('simulated-secret')
    expect(raw).not.toContain('simulated-token')
    tauri.invoke.mockResolvedValue(raw)
    expect((await storage.loadAccounts()).accounts[0].config.accessKeySecret).toBe('simulated-secret')
    vi.resetModules()
    const restarted = await import('../src/utils/config-storage')
    const restored = await restarted.loadAccounts()
    expect(restored.accounts[0].config.accessKeySecret).toBe('')
    expect(restored.accounts[0].config.stsToken).toBe('')
    expect(restarted.canAutoConnect(restored.accounts[0].config)).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('does not restore credentials from an older vault or rewrite it during a normal load', async () => {
    tauri.invoke.mockResolvedValue(JSON.stringify(accountState()))
    const storage = await import('../src/utils/config-storage')
    const restored = await storage.loadAccounts()
    expect(restored.accounts[0].config.accessKeySecret).toBe('')
    expect(restored.accounts[0].config.stsToken).toBe('')
    expect(restored.accounts[0].notes).toBe(accountState().accounts[0].notes)
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith('load_account_vault')
  })

  it('does not replace session credentials when saving encrypted metadata fails', async () => {
    const storage = await import('../src/utils/config-storage')
    const original = accountState()
    tauri.invoke.mockResolvedValue(undefined)
    await storage.saveAccounts(original)
    const edited = accountState()
    edited.accounts[0].config.accessKeySecret = 'changed-synthetic-secret'
    tauri.invoke.mockRejectedValueOnce(new Error('simulated failure'))
    await expect(storage.saveAccounts(edited)).rejects.toThrow('账号保存失败')
    tauri.invoke.mockResolvedValue(JSON.stringify(original))
    expect((await storage.loadAccounts()).accounts[0].config.accessKeySecret).toBe('simulated-secret')
  })

  it('removes legacy plaintext only after encrypted migration succeeds', async () => {
    const state = accountState()
    localStorage.setItem(LEGACY_KEY, JSON.stringify(state.accounts[0].config))
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_account_vault') return null
      expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull()
    })
    const storage = await import('../src/utils/config-storage')
    const migrated = await storage.loadAccounts()
    expect(migrated.accounts[0].config.accessKeySecret).toBe('simulated-secret')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(tauri.invoke.mock.calls.map((call) => call[0])).toEqual(['load_account_vault', 'save_account_vault'])
    const migratedPayload = tauri.invoke.mock.calls[1][1].data
    expect(migratedPayload).not.toContain('simulated-secret')
    expect(migratedPayload).not.toContain('simulated-token')
  })

  it('preserves legacy data and sanitizes native migration errors on save failure', async () => {
    const raw = JSON.stringify(accountState().accounts[0].config)
    localStorage.setItem(LEGACY_KEY, raw)
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_account_vault') return null
      throw new Error('simulated-secret')
    })
    const storage = await import('../src/utils/config-storage')
    await expect(storage.loadAccounts()).rejects.toThrow('旧版账号迁移到加密账号库失败')
    expect(localStorage.getItem(LEGACY_KEY)).toBe(raw)
    expect(localStorage.getItem(ACCOUNTS_KEY)).toBeNull()
  })

  it('does not duplicate a legacy account after restart when plaintext cleanup failed', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(accountState().accounts[0].config))
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    let saved: string | null = null
    tauri.invoke.mockImplementation(async (command: string, args?: { data: string }) => {
      if (command === 'load_account_vault') return saved
      saved = args!.data
    })
    const firstModule = await import('../src/utils/config-storage')
    const first = await firstModule.loadAccounts()
    expect(first.storageWarning).toContain('清理失败')
    vi.resetModules()
    const restarted = await import('../src/utils/config-storage')
    const second = await restarted.loadAccounts()
    expect(second.accounts).toHaveLength(1)
    expect(second.accounts[0].id).toBe(first.accounts[0].id)
    expect(second.accounts[0].config.accessKeySecret).toBe('simulated-secret')
    expect(saved).not.toContain('simulated-secret')
    expect(saved).not.toContain('simulated-token')
  })

  it('does not overwrite a malformed encrypted vault or fall back to browser credentials', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(accountState().accounts[0].config))
    tauri.invoke.mockResolvedValue('{"accessKeySecret":"simulated-secret"')
    const storage = await import('../src/utils/config-storage')
    await expect(storage.loadAccounts()).rejects.toThrow('本机账号数据格式无效')
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull()
  })

  it('rejects decrypt failure with a safe actionable message', async () => {
    tauri.invoke.mockRejectedValue(new Error('simulated-secret'))
    const storage = await import('../src/utils/config-storage')
    await expect(storage.loadAccounts()).rejects.toThrow('无法解密或读取本机账号库')
    expect(localStorage.length).toBe(0)
  })
})
