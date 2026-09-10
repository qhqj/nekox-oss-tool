export interface OssConfig {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  stsToken: string
  endpoint: string
  publicBaseUrl: string
}

export type OssEntryType = 'folder' | 'file'

export interface OssEntry {
  type: OssEntryType
  name: string
  key: string
  size: number
}

export interface OssListResult {
  entries: OssEntry[]
  nextContinuationToken: string
  isTruncated: boolean
}

export interface UploadResult {
  key: string
  publicUrl: string
  renamed: boolean
}
