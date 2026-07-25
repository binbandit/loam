import { chromium } from "playwright";

const [url, outDir, prefix, ...actions] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.getByTestId("open-vault").click();
await page.waitForSelector('[data-testid="app-shell"]');
for (const action of actions) {
  const [kind, ...rest] = action.split("|");
  if (kind === "tree")
    await page.getByTestId("file-tree-body").getByText(rest[0], { exact: true }).click();
  else if (kind === "click") await page.locator(rest[0]).click();
  else if (kind === "key") await page.keyboard.press(rest[0]);
  else if (kind === "type") await page.keyboard.type(rest[0]);
  else if (kind === "wait") await page.waitForSelector(rest[0]);
  else if (kind === "sleep") await page.waitForTimeout(Number(rest[0]));
}
await page.waitForTimeout(500);
for (const theme of ["dark", "light"]) {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${prefix}-${theme}.png` });
}
console.log(await page.getByTestId("status-bar").textContent());
await browser.close();
