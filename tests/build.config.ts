import { defineConfig } from 'vite'
import appConfig from '../vite.config'

// Use the production configuration without loading any local .env files.
export default defineConfig({ ...appConfig, envDir: false })
