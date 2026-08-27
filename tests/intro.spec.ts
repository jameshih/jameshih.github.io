import { expect, test, type Browser, type Page } from "@playwright/test";
import { PNG } from "pngjs";

const HANDOFF_URL = /\/blog\/about$/;

async function waitForIntro(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__INTRO_STATE__?.mode));
}

async function waitForPhase(page: Page, phase: string): Promise<void> {
  await page.waitForFunction(
    (expectedPhase) => document.documentElement.dataset.phase === expectedPhase,
    phase
  );
}

test("the full intro is mandatory on every direct root visit", async ({ page }) => {
  for (const path of ["/", "/?skip=1&intro=0"]) {
    const startedAt = Date.now();
    await page.goto(path);
    await page.waitForFunction(() => Boolean(window.__INTRO_STATE__?.mode));

    await expect(page.locator("button, a")).toHaveCount(0);
    await expect(page.getByText("Lv42", { exact: true })).toBeAttached();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.mouse.click(8, 8);
    await page.waitForTimeout(1_000);
    expect(new URL(page.url()).pathname).toBe("/");

    await page.waitForURL(HANDOFF_URL);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6_600);
  }
});

test("hidden time does not advance the cinematic clock", async ({ page }) => {
  const startedAt = Date.now();
  await waitForIntro(page);
  await page.waitForFunction(() => (window.__INTRO_STATE__?.elapsedMs ?? 0) > 300);

  const beforePause = await page.evaluate(() => window.__INTRO_STATE__?.elapsedMs ?? 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1_100);
  const afterPause = await page.evaluate(() => window.__INTRO_STATE__?.elapsedMs ?? 0);
  expect(afterPause - beforePause).toBeLessThan(80);

  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForURL(HANDOFF_URL);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_650);
});

test("reduced motion preserves the complete timed narrative", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const startedAt = Date.now();
  await waitForIntro(page);

  await expect(page.locator("html")).toHaveAttribute("data-mode", "reduced-motion");
  await expect(page.locator("#canvas-host canvas")).toHaveCount(0);
  await waitForPhase(page, "identity");
  await expect(page.getByRole("heading", { name: "James Shih" })).toBeVisible();
  await page.waitForURL(HANDOFF_URL);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6_600);
});

test("WebGL failure uses the CSS renderer without shortening the intro", async ({ page }) => {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (contextId: string, ...args: unknown[]) {
      if (contextId.startsWith("webgl") || contextId === "experimental-webgl") return null;
      return Reflect.apply(originalGetContext, this, [contextId, ...args]);
    } as typeof originalGetContext;
  });

  const startedAt = Date.now();
  await waitForIntro(page);
  await expect(page.locator("html")).toHaveAttribute("data-mode", "css-fallback");
  await expect(page.locator("#canvas-host canvas")).toHaveCount(0);
  await page.waitForURL(HANDOFF_URL);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6_600);
});

test("the WebGL canvas is nonblank and changes during battle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForIntro(page);
  await expect(page.locator("html")).toHaveAttribute("data-mode", "webgl");

  await waitForPhase(page, "reveal");
  await page.waitForTimeout(350);
  const first = await page.locator("#canvas-host canvas").screenshot();

  await waitForPhase(page, "faceoff");
  await page.waitForFunction(() => (window.__INTRO_STATE__?.elapsedMs ?? 0) > 4_050);
  const second = await page.locator("#canvas-host canvas").screenshot();

  await waitForPhase(page, "identity");
  await page.waitForTimeout(180);
  const identity = await page.locator("#canvas-host canvas").screenshot();

  const firstPng = PNG.sync.read(first);
  const secondPng = PNG.sync.read(second);
  const identityPng = PNG.sync.read(identity);
  expect(nonDarkPixelRatio(firstPng)).toBeGreaterThan(0.08);
  expect(nonDarkPixelRatio(secondPng)).toBeGreaterThan(0.08);
  expect(changedPixelRatio(firstPng, secondPng)).toBeGreaterThan(0.025);
  expect(portraitPixelRatio(identityPng)).toBeGreaterThan(0.015);
});

const viewports = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-regular", width: 390, height: 844 },
  { name: "iphone-large", width: 430, height: 932 },
  { name: "tablet", width: 768, height: 1_024 },
  { name: "desktop", width: 1_440, height: 900 }
];

for (const viewport of viewports) {
  test(`identity frame fits ${viewport.name}`, async ({ page }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await waitForIntro(page);
    await waitForPhase(page, "identity");
    await page.waitForTimeout(180);

    const layout = await page.evaluate(() => {
      const identity = document.querySelector<HTMLElement>(".identity")?.getBoundingClientRect();
      const narration = document.querySelector<HTMLElement>("#narration")?.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        identity: identity && { top: identity.top, right: identity.right, bottom: identity.bottom, left: identity.left },
        narration: narration && { top: narration.top, right: narration.right, bottom: narration.bottom, left: narration.left }
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.identity).not.toBeNull();
    expect(layout.narration).not.toBeNull();
    expect(layout.identity!.left).toBeGreaterThanOrEqual(0);
    expect(layout.identity!.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.identity!.bottom).toBeLessThan(layout.narration!.top);
    expect(layout.narration!.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(runtimeErrors).toEqual([]);

    const screenshotPath = testInfo.outputPath(`${viewport.name}-identity.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`${viewport.name} identity`, { path: screenshotPath, contentType: "image/png" });
  });
}

test("the no-JavaScript fallback holds for seven seconds", async ({ browser }) => {
  await assertNoScriptFallback(browser);
});

test("analytics records the complete intro lifecycle", async ({ page }) => {
  const analyticsEvents: unknown[][] = [];
  await page.exposeFunction("__captureGtag", (entry: unknown[]) => analyticsEvents.push(entry));
  await page.addInitScript(() => {
    const layer: unknown[] = [];
    const push = layer.push.bind(layer);
    layer.push = (...entries: unknown[]): number => {
      const capture = (window as unknown as { __captureGtag: (entry: unknown[]) => void }).__captureGtag;
      entries.forEach((entry) => capture(Array.from(entry as ArrayLike<unknown>)));
      return push(...entries);
    };
    window.dataLayer = layer;
  });

  await waitForIntro(page);
  await page.waitForURL(HANDOFF_URL);
  const names = analyticsEvents
    .filter((entry) => entry[0] === "event")
    .map((entry) => entry[1]);
  expect(names).toEqual(expect.arrayContaining(["intro_started", "intro_render_ready", "intro_completed"]));
});

async function assertNoScriptFallback(browser: Browser): Promise<void> {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const startedAt = Date.now();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "James Shih" })).toBeVisible();
  await expect(page.getByText("Lv42", { exact: true })).toBeVisible();
  await page.waitForURL(HANDOFF_URL, { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6_750);
  await context.close();
}

function nonDarkPixelRatio(image: PNG): number {
  let nonDark = 0;
  const total = image.width * image.height;
  for (let index = 0; index < image.data.length; index += 4) {
    const luminance = image.data[index] * 0.2126 + image.data[index + 1] * 0.7152 + image.data[index + 2] * 0.0722;
    if (luminance > 18) nonDark += 1;
  }
  return nonDark / total;
}

function changedPixelRatio(first: PNG, second: PNG): number {
  expect(first.width).toBe(second.width);
  expect(first.height).toBe(second.height);
  let changed = 0;
  const total = first.width * first.height;
  for (let index = 0; index < first.data.length; index += 4) {
    const difference =
      Math.abs(first.data[index] - second.data[index]) +
      Math.abs(first.data[index + 1] - second.data[index + 1]) +
      Math.abs(first.data[index + 2] - second.data[index + 2]);
    if (difference > 42) changed += 1;
  }
  return changed / total;
}

function portraitPixelRatio(image: PNG): number {
  let portraitPixels = 0;
  const total = image.width * image.height;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    if (red > 135 && green > 95 && blue > 85 && red > green + 18 && green > blue + 4) {
      portraitPixels += 1;
    }
  }
  return portraitPixels / total;
}
