import { expect, test } from "playwright/test";

// Exercise the actual server-rendered room and its production CSS. No cloth
// simulation or hydration is needed to catch a canvas stealing a tab's hits.
test.use({ javaScriptEnabled: false });

for (const viewport of [{ width: 1280, height: 832 }, { width: 390, height: 844 }]) {
  test(`cabinet tab receives pointer hits at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "load" });
    const tab = page.locator(".material-cabinet__flip");
    await expect(tab).toBeVisible();
    await expect(tab).toHaveCSS("width", "44px");
    await expect(tab).toHaveCSS("height", "44px");
    const hits = await tab.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      // Cover the whole target, not just the small central SVG icon.
      return [0.15, 0.5, 0.85].flatMap((x) =>
        [0.15, 0.5, 0.85].map((y) => {
          const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
          return hit === button || (hit !== null && button.contains(hit));
        }),
      );
    });
    expect(hits).toEqual(Array(9).fill(true));
  });
}
