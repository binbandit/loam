import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// AC3 (LOA-36): the EXACT production CSP from tauri.conf.json must block
// unapproved external network requests while still letting the app boot.
// Tauri injects this policy into the shipped HTML at build time; here the same
// policy is applied as a response header over the built app in a real browser
// engine. The in-shell counterpart lands with the tauri-driver harness (LOA-49).

const conf = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"),
);
const csp = Object.entries(conf.app.security.csp as Record<string, string>)
  .map(([directive, value]) => `${directive} ${value}`)
  .join("; ");

test("the production CSP blocks external fetches but boots the app", async ({ page }) => {
  let externalRequestLeft = false;
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:4173")) {
      const response = await route.fetch();
      const isDocument = route.request().resourceType() === "document";
      await route.fulfill({
        response,
        headers: isDocument
          ? { ...response.headers(), "content-security-policy": csp }
          : response.headers(),
      });
      return;
    }
    // If CSP ever fails, this makes the leak loud instead of a network error.
    externalRequestLeft = true;
    await route.fulfill({ status: 200, body: "leaked" });
  });

  await page.goto("/");
  // The app boots under the production policy (script-src 'self' allows the bundle).
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");

  const result = await page.evaluate(() =>
    fetch("https://example.com/probe")
      .then(() => "fetched")
      .catch((error: unknown) => `blocked:${error instanceof Error ? error.name : "unknown"}`),
  );
  expect(result).toBe("blocked:TypeError");
  expect(externalRequestLeft).toBe(false);

  // Sanity: the policy under test is the real default-deny one.
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
});
