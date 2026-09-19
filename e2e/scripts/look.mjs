import { chromium } from "@playwright/test";
import path from "node:path";
const dist = path.resolve("../extension/dist");
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/apply");
await page.waitForSelector('#ghost-overlay-host[data-ghost-state="ready"]', { state: "attached" });
await page.waitForTimeout(600);
await page.screenshot({ path: "test-results/look/1-start.png" });
for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); await page.waitForTimeout(350); }
await page.screenshot({ path: "test-results/look/2-mid.png" });
for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); await page.waitForTimeout(250); }
await page.screenshot({ path: "test-results/look/3-end.png" });
await ctx.close();
