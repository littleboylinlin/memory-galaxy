import { defineConfig } from "@playwright/test";
const configured = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = configured
  ? configured.endsWith("/")
    ? configured
    : configured + "/"
  : "http://127.0.0.1:4173/memory-galaxy/";
const chromiumLaunch = {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
  args: process.env.PLAYWRIGHT_CHROMIUM_ARGS
    ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS)
    : [],
};
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1365, height: 900 },
        launchOptions: chromiumLaunch,
      },
    },
    {
      name: "mobile-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        launchOptions: chromiumLaunch,
      },
    },
    {
      name: "desktop-firefox",
      use: { browserName: "firefox", viewport: { width: 1365, height: 900 } },
    },
    {
      name: "mobile-webkit",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: configured
    ? undefined
    : {
        command:
          "node scripts/serve.mjs --root dist --base-path /memory-galaxy/",
        url: baseURL,
        reuseExistingServer: false,
      },
});
