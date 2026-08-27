import { expect, test } from "@playwright/test";

const HANDOFF_URL = /\/blog\/about$/;
const INTRO_MINIMUM_MS = 6_700;

test.beforeEach(async ({ page }) => {
  await page.route("https://www.googletagmanager.com/**", (route) => route.abort());
});

test("the original intro is mandatory on every direct root visit", async ({ page }) => {
  for (const path of ["/", "/?skip=1&intro=0"]) {
    const startedAt = Date.now();
    await page.goto(path);

    await expect(page.locator("a, button")).toHaveCount(0);
    await expect(page.getByText("Lv42", { exact: true })).toBeAttached();
    await expect(page.locator("#main-logo")).toHaveAttribute("src", "js.svg");

    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.mouse.click(8, 8);
    await page.waitForTimeout(750);
    expect(new URL(page.url()).pathname).toBe("/");

    await page.waitForURL(HANDOFF_URL);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(INTRO_MINIMUM_MS);
  }
});

test("the classic battle sequence reaches its final frame", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("A wild JAMES SHIH appeared!", { exact: true })).toBeVisible({ timeout: 3_500 });
  await expect(page.getByText("Entering personal site!", { exact: true })).toBeVisible({ timeout: 5_500 });
  expect(await page.locator("#hp-bar").evaluate((element) => element.style.width)).toBe("100%");
  await expect(page.locator("#main-logo")).toBeVisible();
});

const viewports = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-regular", width: 390, height: 844 },
  { name: "iphone-large", width: 430, height: 932 },
  { name: "tablet", width: 768, height: 1_024 },
  { name: "desktop", width: 1_440, height: 900 }
];

for (const viewport of viewports) {
  test(`the original final frame fits ${viewport.name}`, async ({ page }, testInfo) => {
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByText("Entering personal site!", { exact: true })).toBeVisible({ timeout: 5_500 });

    const layout = await page.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect && { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        health: bounds(".hp-bar-container"),
        narration: bounds(".text-box")
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
    for (const element of [layout.health, layout.narration]) {
      expect(element).not.toBeNull();
      expect(element.left).toBeGreaterThanOrEqual(0);
      expect(element.right).toBeLessThanOrEqual(layout.viewportWidth);
      expect(element.top).toBeGreaterThanOrEqual(0);
      expect(element.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    }
    expect(layout.health.bottom).toBeLessThan(layout.narration.top);
    expect(runtimeErrors).toEqual([]);

    const screenshotPath = testInfo.outputPath(`${viewport.name}-classic.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`${viewport.name} classic intro`, {
      path: screenshotPath,
      contentType: "image/png"
    });
  });
}

test("the no-JavaScript fallback holds for seven seconds", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const startedAt = Date.now();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "James Shih" })).toBeAttached();
  await expect(page.getByText("Lv42", { exact: true })).toBeVisible();
  await page.waitForURL(HANDOFF_URL, { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6_750);
  await context.close();
});

test("analytics records the classic intro lifecycle", async ({ page }) => {
  const analyticsEvents = [];
  await page.exposeFunction("__captureGtag", (entry) => analyticsEvents.push(entry));
  await page.addInitScript(() => {
    const layer = [];
    const push = layer.push.bind(layer);
    layer.push = (...entries) => {
      entries.forEach((entry) => window.__captureGtag(Array.from(entry)));
      return push(...entries);
    };
    window.dataLayer = layer;
  });

  await page.goto("/");
  await page.waitForURL(HANDOFF_URL);
  const names = analyticsEvents
    .filter((entry) => entry[0] === "event")
    .map((entry) => entry[1]);
  expect(names).toEqual(expect.arrayContaining(["landing_intro_started", "landing_intro_completed"]));
});
