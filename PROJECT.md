# Project Snapshot

- Name: `nekox-oss-tool`
- Version: `0.2.0`, Windows desktop app plus web development preview
- Stack: Vue 3 / Vite / TypeScript / ali-oss Browser SDK / Tauri 2
- Core: named accounts with notes -> lazy directory list -> recursive batch uploads -> public URL -> explicit download
- Conflict dialog: overwrite / skip / rename, apply to remaining conflicts, retry failures, pause after current
- Upload account and Prefix remain fixed while the dialog is open
- No backend
- No automatic object preview/download
- No OSS object deletion; removing an account affects local configuration only
- Windows credentials use a per-user DPAPI encrypted vault; web credentials are session-only
- Legacy single-account settings migrate before old plaintext storage is removed
- Local tests use mocked OSS and synthetic credentials; real Bucket acceptance is separate
- Public production usage should migrate to STS
