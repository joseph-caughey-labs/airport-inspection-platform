import { expect, test } from "@playwright/test";
import { seedAuth } from "../fixtures/auth-fixture";

test.describe("smoke", () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
  });

  test("index page renders airport list with link to map", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Live Ops" })).toBeVisible();
    await expect(page.getByText("San Francisco International")).toBeVisible();
    await expect(page.getByText("John F. Kennedy International")).toBeVisible();
  });

  test("airport page mounts the live board sections", async ({ page }) => {
    await page.goto("/airports/11111111-1111-1111-1111-aaaaaaaaaaaa");
    // Wait for the airport header to confirm the seed data resolved.
    await expect(page.getByRole("heading", { name: /San Francisco International/i })).toBeVisible();
    // The sensor legend, health panel, and presence + alert feed are
    // all aria-labeled landmarks that don't depend on WebGL succeeding,
    // unlike the map itself (which renders into a <div role="region">
    // that headless Chromium can't reliably initialize via SwiftShader).
    await expect(page.getByLabel("Sensor legend")).toBeVisible();
    await expect(page.getByLabel("Sensor health")).toBeVisible();
    await expect(page.getByLabel("Active subscribers")).toBeVisible();
    await expect(page.getByLabel("Live alert feed")).toBeVisible();
  });
});
