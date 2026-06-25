import { chromium } from "playwright";

async function run() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  console.log("Loading page...");
  await page.goto("https://getsupport.apple.com/?locale=de_DE", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Dismiss GDPR
  for (const sel of ['button:has-text("Alle Cookies akzeptieren")', '#onetrust-accept-btn-handler']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); await page.waitForTimeout(800); break; }
    } catch {}
  }

  await page.screenshot({ path: "/tmp/apple-step1.png", fullPage: true });
  console.log("Screenshot saved: /tmp/apple-step1.png");

  // Log all visible buttons/links
  const texts = await page.locator('button, a[role="button"], [role="button"]').allTextContents();
  console.log("Visible buttons/roles:", texts.filter(t => t.trim()).slice(0, 40));

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
