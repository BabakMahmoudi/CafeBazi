import { test, expect } from "@playwright/test";

test("health probe responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("home page renders the MiniApp shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test("game page renders the roulette wheel", async ({ page }) => {
  await page.goto("/game");
  await expect(page.getByTestId("roulette-wheel")).toBeVisible();
});
