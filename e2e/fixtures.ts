// Playwright harness that loads the built Ghost extension (extension/dist) into Chromium.
//
// Working launch configuration (verified on macOS, Playwright 1.63, bundled Chromium):
//   chromium.launchPersistentContext("", {
//     channel: "chromium",          // full Chromium build: its new headless mode supports extensions
//     headless: true,               // the default headless shell does NOT load extensions; channel fixes that
//     args: ["--disable-extensions-except=<dist>", "--load-extension=<dist>"],
//   })
// Set GHOST_HEADED=1 to watch a run in a real window.
import { test as base, chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIST = path.resolve(E2E_DIR, "../extension/dist");
export const VIDEO_DIR = path.resolve(E2E_DIR, "test-results/videos");
export const MEDIA_DIR = path.resolve(E2E_DIR, "../docs/media");
export const VIEWPORT = { width: 1280, height: 800 } as const;
export const DEMO_URL = "http://localhost:5173";

interface VideoRequest {
  page: Page;
  fileName: string;
}

export type SaveVideo = (page: Page, fileName: string) => void;

interface GhostFixtures {
  context: BrowserContext;
  extensionId: string;
  /** Registers a page whose recording is copied to docs/media/<fileName> once the context has closed. */
  saveVideo: SaveVideo;
  videoRequests: VideoRequest[];
}

async function assertExtensionBuilt(): Promise<void> {
  const manifest = path.join(EXTENSION_DIST, "manifest.json");
  const found = await stat(manifest).then(() => true, () => false);
  if (!found) throw new Error(`Missing ${manifest}. Run "pnpm build" at the repo root first.`);
}

// Videos are only finalized when the context closes, so copying happens after close().
async function copyVideos(requests: VideoRequest[]): Promise<void> {
  if (requests.length === 0) return;
  await mkdir(MEDIA_DIR, { recursive: true });
  for (const { page, fileName } of requests) {
    const source = await page.video()?.path();
    if (!source) throw new Error(`No video was recorded for ${fileName}`);
    await copyFile(source, path.join(MEDIA_DIR, path.basename(fileName)));
  }
}

export const test = base.extend<GhostFixtures>({
  videoRequests: async ({}, use) => {
    await use([]);
  },

  context: async ({ videoRequests }, use) => {
    await assertExtensionBuilt();
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: process.env.GHOST_HEADED !== "1",
      viewport: VIEWPORT,
      recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
      args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
    });
    await use(context);
    await context.close();
    await copyVideos(videoRequests);
  },

  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    if (!id) throw new Error(`Could not parse an extension id from ${worker.url()}`);
    await use(id);
  },

  saveVideo: async ({ videoRequests }, use) => {
    await use((page, fileName) => {
      videoRequests.push({ page, fileName });
    });
  },
});

export { expect };
