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
- Credentials are session-only on both Windows and web; Windows encrypts nonsecret account metadata with per-user DPAPI
- Old vault credentials are not restored; a successful save strips them, without rewriting on load alone
- Legacy single-account settings migrate before old plaintext storage is removed
- HTTPS endpoint/public URL validation happens before SDK construction; no URL credentials/query/fragment
- PUT and multipart initiate/complete retain the no-overwrite header unless explicitly approved; server conflict writes are bounded to five attempts
- Local tests use mocked OSS and synthetic credentials; real Bucket acceptance is separate
- Public production usage should migrate to STS
