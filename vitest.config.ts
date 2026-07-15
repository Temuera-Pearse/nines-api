import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/migrated-from-backend/**/*'],
    clearMocks: true,
    restoreMocks: true,
  },
})
