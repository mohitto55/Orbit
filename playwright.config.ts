import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: 'test-results/ui',
  reporter: [['list'], ['html', { outputFolder: 'test-results/ui-report', open: 'never' }], ['junit', { outputFile: 'test-results/ui-junit.xml' }]]
})
