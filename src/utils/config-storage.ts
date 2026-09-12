import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AccountState, OssAccount } from '../types/accounts'
import type { OssConfig } from '../types/oss'

const LEGACY_KEY = 'nekox-oss-tool/config'
const ACCOUNTS_KEY = 'nekox-oss-tool/accounts'
const sessionCredentials = new Map<string, Pick<OssConfig, 'accessKeySecret' | 'stsToken'>>()
const CONFIG_FIELDS: (keyof OssConfig)[] = [
  'region', 'bucket', 'accessKeyId', 'accessKeySecret', 'stsToken', 'endpoint', 'publicBaseUrl',
]

export function createInitialConfig(): OssConfig {
  return {
    region: import.meta.env.VITE_OSS_DEFAULT_REGION || 'oss-cn-beijing',
    bucket: import.meta.env.VITE_OSS_DEFAULT_BUCKET || '',
    accessKeyId: '',
    accessKeySecret: '',
    stsToken: '',
    endpoint: '',
    publicBaseUrl: import.meta.env.VITE_OSS_PUBLIC_BASE_URL || '',
  }
}

function emptyState(): AccountState {
  return { version: 1, accounts: [], activeAccountId: '' }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readConfig(value: unknown, includeSecrets: boolean): OssConfig {
  if (!record(value)) throw new Error('账号配置格式无效。')
  const config = createInitialConfig()
  for (const field of CONFIG_FIELDS) {
    if (!includeSecrets && (field === 'accessKeySecret' || field === 'stsToken')) continue
    const candidate = value[field]
    if (candidate !== undefined && typeof candidate !== 'string') throw new Error('账号配置格式无效。')
    if (typeof candidate === 'string') config[field] = candidate.trim()
  }
  return config
}

function readState(raw: string, includeSecrets: boolean): AccountState {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 100) throw new Error()
    const seen = new Set<string>()
    const accounts = value.accounts.map((candidate: unknown): OssAccount => {
      if (!record(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim() ||
          typeof candidate.name !== 'string' || typeof candidate.notes !== 'string' || seen.has(candidate.id)) {
        throw new Error()
      }
      seen.add(candidate.id)
      return {
        id: candidate.id,
        name: candidate.name.trim() || '未命名账号',
        notes: candidate.notes.trim(),
        config: readConfig(candidate.config, includeSecrets),
      }
    })
    const activeAccountId = typeof value.activeAccountId === 'string' && seen.has(value.activeAccountId)
      ? value.activeAccountId : accounts[0]?.id ?? ''
    return { version: 1, accounts, activeAccountId }
  } catch {
    // Parse errors may quote credentials from the payload; never expose them.
    throw new Error('本机账号数据格式无效，无法读取。请保留原文件并检查，避免覆盖。')
  }
}

function readLegacy(raw: string): OssConfig {
  try {
    return readConfig(JSON.parse(raw), true)
  } catch {
    throw new Error('旧版连接配置格式无效，无法自动迁移。')
  }
}

function addLegacy(state: AccountState, config: OssConfig): AccountState {
  const same = state.accounts.find((account) =>
    CONFIG_FIELDS.every((field) => account.config[field] === config[field]))
  if (same) return state
  let id = 'legacy-default'
  let index = 1
  while (state.accounts.some((account) => account.id === id)) id = `legacy-default-${index++}`
  return {
    version: 1,
    accounts: [...state.accounts, { id, name: config.bucket || '原有账号', notes: '由旧版连接配置迁移', config }],
    activeAccountId: state.activeAccountId || id,
  }
}

function metadataJson(state: AccountState): string {
  return JSON.stringify({
    version: 1,
    activeAccountId: state.activeAccountId,
    accounts: state.accounts.map(({ id, name, notes, config }) => ({
      id, name, notes,
      config: {
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        endpoint: config.endpoint,
        publicBaseUrl: config.publicBaseUrl,
      },
    })),
  })
}

function rememberCredentials(state: AccountState) {
  sessionCredentials.clear()
  for (const account of state.accounts) {
    sessionCredentials.set(account.id, {
      accessKeySecret: account.config.accessKeySecret,
      stsToken: account.config.stsToken,
    })
  }
}

function withSessionCredentials(state: AccountState): AccountState {
  for (const account of state.accounts) {
    Object.assign(account.config, sessionCredentials.get(account.id) ?? {})
  }
  return state
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export async function loadAccounts(): Promise<AccountState> {
  const storage = browserStorage()
  let legacyRaw: string | null = null
  let warning = ''
  try {
    legacyRaw = storage?.getItem(LEGACY_KEY) ?? null
  } catch {
    warning = '无法读取旧版浏览器配置，请检查本机存储权限。'
  }

  if (isTauri()) {
    let raw: string | null
    try {
      raw = await invoke<string | null>('load_account_vault')
    } catch {
      throw new Error('无法解密或读取本机账号库。请确认使用原 Windows 用户，并检查文件权限；原数据未覆盖。')
    }
    let state = raw === null ? emptyState() : readState(raw, true)
    if (legacyRaw !== null) {
      let legacy: OssConfig
      try {
        legacy = readLegacy(legacyRaw)
      } catch {
        return { ...state, storageWarning: '旧版连接配置格式无效，已保留原数据；请手动检查后清理。' }
      }
      state = addLegacy(state, legacy)
      try {
        await invoke('save_account_vault', { data: JSON.stringify(state) })
      } catch {
        throw new Error('旧版账号迁移到加密账号库失败，原配置已保留。请检查文件权限后重新启动。')
      }
      try {
        storage?.removeItem(LEGACY_KEY)
      } catch {
        warning = '账号已存入加密账号库，但旧版明文配置清理失败，请检查本机存储权限。'
      }
    }
    return warning ? { ...state, storageWarning: warning } : state
  }

  let legacy: OssConfig | undefined
  if (legacyRaw !== null) {
    try {
      legacy = readLegacy(legacyRaw)
    } catch {
      warning = '旧版连接配置格式无效，已清理旧版数据，请重新填写账号。'
    }
    // Web credentials must leave persistent browser storage, including on migration failure.
    try {
      storage?.removeItem(LEGACY_KEY)
    } catch {
      throw new Error('无法清理旧版明文凭证，请允许本机存储访问后重试。')
    }
  }

  let raw: string | null = null
  try {
    raw = storage?.getItem(ACCOUNTS_KEY) ?? null
  } catch {
    warning = '无法读取账号列表；浏览器存储不可用。'
  }
  let state = withSessionCredentials(raw === null ? emptyState() : readState(raw, false))
  if (legacy) state = addLegacy(state, legacy)
  rememberCredentials(state)
  if (raw !== null || legacy) {
    try {
      if (!storage) throw new Error()
      // This allowlist also strips credentials left by any older web build.
      storage.setItem(ACCOUNTS_KEY, metadataJson(state))
    } catch {
      warning = '账号已载入本次会话，但账号列表保存失败；关闭页面后需重新填写。'
    }
  }
  if (!storage) warning = '浏览器存储不可用，请允许本机存储访问后保存或连接账号。'
  return warning ? { ...state, storageWarning: warning } : state
}

export async function saveAccounts(state: AccountState): Promise<void> {
  const normalized = readState(JSON.stringify(state), true)
  if (isTauri()) {
    try {
      await invoke('save_account_vault', { data: JSON.stringify(normalized) })
    } catch {
      throw new Error('账号保存失败。请检查本机加密账号库的文件权限后重试。')
    }
    return
  }
  try {
    const storage = browserStorage()
    if (!storage) throw new Error()
    storage.setItem(ACCOUNTS_KEY, metadataJson(normalized))
  } catch {
    throw new Error('账号列表保存失败，请检查浏览器存储权限。凭证未写入浏览器存储。')
  }
  rememberCredentials(normalized)
}

export function canAutoConnect(config: OssConfig): boolean {
  return Boolean(config.region.trim() && config.bucket.trim() && config.accessKeyId.trim() && config.accessKeySecret.trim())
}
