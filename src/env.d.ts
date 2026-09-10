/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSS_DEFAULT_REGION?: string
  readonly VITE_OSS_DEFAULT_BUCKET?: string
  readonly VITE_OSS_PUBLIC_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
