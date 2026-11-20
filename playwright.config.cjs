const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test',
  timeout: 30000,
  expect: { timeout: 8000 },
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 412, height: 915 },
  },
  webServer: {
    command: 'python3 -m http.server 8765 --bind 127.0.0.1',
    port: 8765,
    reuseExistingServer: true,
  },
});
