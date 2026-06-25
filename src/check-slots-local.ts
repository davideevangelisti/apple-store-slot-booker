/**
 * Diagnostic: navigate the getsupport.apple.com booking wizard for AirPods 4 ANC
 * at Apple Rosenstrasse Munich, intercept the /api/v1/facade/timeslots API response,
 * and print all available appointment slots.
 *
 * Run: npx tsx src/check-slots-local.ts
 */
import { chromium, type Page } from "playwright";

const STORE_SEARCH = "München";
const STORE_NAME_MATCH = /Rosenstra/i;
const TARGET_SATURDAY = nextSaturdayDate();

function nextSaturdayDate(): string {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const daysUntilSat = utcDay === 6 ? 7 : (6 - utcDay + 7) % 7 || 7;
  const sat = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSat),
  );
  return sat.toISOString().slice(0, 10);
}

function fmtMunich(ts: number): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts * 1000));
}

async function dismissGdprBanner(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Alle Cookies akzeptieren")',
    'button:has-text("Accept All Cookies")',
    "#onetrust-accept-btn-handler",
    '[data-trigger="privacy-cookie-accept"]',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* not present */ }
  }
}

async function clickFirst(page: Page, selectors: string[], timeout = 15000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          const text = (await el.textContent() || "").trim();
          await el.click();
          return text;
        }
      } catch { /* try next */ }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`None matched within ${timeout}ms: ${selectors.join(", ")}`);
}

async function run(): Promise<void> {
  console.log(`Target Saturday: ${TARGET_SATURDAY}`);
  console.log("Launching Chromium…\n");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Capture all facade API responses
  const apiLog: { path: string; status: number; body: unknown }[] = [];
  let timeslotsPayload: unknown = null;

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/v1/facade/")) return;
    const path = url.replace("https://getsupport.apple.com", "").split("?")[0];
    try {
      const body = await response.json();
      apiLog.push({ path, status: response.status(), body });
      if (path === "/api/v1/facade/timeslots") {
        timeslotsPayload = body;
        console.log(`\n>>> timeslots API hit (${response.status()}) <<<`);
      } else {
        console.log(`  [api] ${response.status()} ${path}`);
      }
    } catch { /* binary or non-JSON */ }
  });

  // Step 1 — home
  console.log("[1] Loading getsupport.apple.com…");
  await page.goto("https://getsupport.apple.com/?locale=de_DE", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(1500);
  await dismissGdprBanner(page);

  // Step 2 — navigate to product list ("Produkt auswählen")
  console.log("[2] Opening product list…");
  await clickFirst(page, [
    'a:has-text("Produkt auswählen")',
    'a:has-text("Alle Produkte")',
    'button:has-text("Produkt auswählen")',
    '[href*="product"]',
  ]);
  await page.waitForTimeout(2000);

  // Step 3 — AirPods category
  console.log("[3] Clicking AirPods…");
  await clickFirst(page, [
    ':is(button,a,[role="button"]):text-is("AirPods")',
    'button:has-text("AirPods")',
    'a:has-text("AirPods")',
    '[data-analytics-title="AirPods"]',
  ]);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/apple-step3-after-airpods.png", fullPage: true });
  console.log("  Screenshot → /tmp/apple-step3-after-airpods.png");

  // Step 4 — AirPods model (optional — page may go straight to topic)
  console.log("[4] Selecting AirPods 4 ANC model (optional)…");
  try {
    await clickFirst(page, [
      ':is(button,li,label,[role="option"]):has-text("AirPods 4"):has-text("Noise")',
      ':is(button,li,label,[role="option"]):has-text("AirPods 4"):has-text("ANC")',
      ':is(button,li,label,[role="option"]):text-matches("AirPods.*4.*Active|AirPods.*4.*ANC", "i")',
      ':is(button,li,label,[role="option"]):has-text("Active Noise")',
      ':is(button,li,label,[role="option"]):has-text("Active Noise Cancellation")',
    ], 5000);
    await page.waitForTimeout(1500);
  } catch {
    console.log("  (no model selection shown — page went straight to topic)");
  }

  // Step 5 — physical damage topic (ensures in-store/Genius Bar option appears)
  console.log("[5] Selecting topic (physical damage)…");
  {
    const candidates = [
      page.getByText("Physischer oder Flüssigkeitsschaden", { exact: true }),
      page.getByText("Physical or Liquid Damage", { exact: true }),
      page.locator(':is(button,div,article,[role="option"]):has-text("Physischer")').first(),
      page.locator(':is(button,div,article,[role="option"]):has-text("Physical")').first(),
    ];
    let clicked = false;
    const deadline = Date.now() + 15000;
    while (!clicked && Date.now() < deadline) {
      for (const loc of candidates) {
        try {
          if (await loc.isVisible({ timeout: 500 })) {
            await loc.click();
            clicked = true;
            break;
          }
        } catch { /* try next */ }
      }
      if (!clicked) await page.waitForTimeout(400);
    }
    if (!clicked) throw new Error("Could not find physical damage topic after 15 s");
  }
  await page.waitForTimeout(2500);

  // Step 6 — select subtopic (physical damage sub-type)
  console.log("[6] Selecting physical damage subtopic…");
  {
    const candidates = [
      page.getByText("Beschädigte AirPods austauschen", { exact: true }),
      page.getByText("Replace Damaged AirPods", { exact: true }),
      page.locator(':is(button,div,article,[role="option"]):has-text("Beschädigte AirPods aus")').first(),
      page.locator(':is(button,div,article,[role="option"]):has-text("Replace Damaged AirPods")').first(),
    ];
    let clicked = false;
    const deadline = Date.now() + 10000;
    while (!clicked && Date.now() < deadline) {
      for (const loc of candidates) {
        try {
          if (await loc.isVisible({ timeout: 500 })) {
            await loc.click();
            clicked = true;
            break;
          }
        } catch { /* try next */ }
      }
      if (!clicked) await page.waitForTimeout(400);
    }
    if (!clicked) console.log("  (no subtopic cards found — skipping)");
    else await page.waitForTimeout(1000);
  }

  // Step 7 — click "Weiter" to show support options
  console.log("[7] Clicking Weiter (Continue)…");
  await clickFirst(page, [
    'button:has-text("Weiter")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Weiter")',
  ], 12000);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/apple-step7-support-options.png", fullPage: true });
  console.log("  Screenshot → /tmp/apple-step7-support-options.png");

  // Step 8 — in-store repair: click inner "Store finden suchen" button (avoids login redirect)
  console.log("[8] Selecting in-store / Genius Bar…");
  {
    const candidates = [
      // Inner "Store finden suchen" button first — avoids triggering login redirect
      page.locator('button:has-text("Store finden")').first(),
      page.locator('a:has-text("Store finden")').first(),
      page.locator('button:has-text("Find a Store")').first(),
      page.locator('button:has-text("Genius Bar")').first(),
      // Fallback: card heading
      page.getByText("Termin vereinbaren", { exact: true }),
      page.getByText("Schedule a Repair", { exact: true }),
    ];
    let clicked = false;
    const deadline = Date.now() + 20000;
    while (!clicked && Date.now() < deadline) {
      for (const loc of candidates) {
        try {
          if (await loc.isVisible({ timeout: 500 })) {
            await loc.click();
            clicked = true;
            break;
          }
        } catch { /* try next */ }
      }
      if (!clicked) await page.waitForTimeout(400);
    }
    if (!clicked) throw new Error("Could not find in-store / Genius Bar option after 20 s");
  }
  await page.waitForTimeout(2000);

  // Step 9 — store search + select Rosenstrasse
  console.log("[9] Searching for store…");
  await page.screenshot({ path: "/tmp/apple-step9-store-search.png", fullPage: true });
  console.log("  Screenshot → /tmp/apple-step9-store-search.png");
  const searchInput = page
    .locator('input[type="text"], input[type="search"], input[placeholder*="Stadt"], input[placeholder*="Location"], input[placeholder*="city"], input[placeholder*="Suchen"]')
    .first();
  if (await searchInput.isVisible({ timeout: 8000 })) {
    await searchInput.fill(STORE_SEARCH);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "/tmp/apple-step9-after-search.png", fullPage: true });
    console.log("  Screenshot after search → /tmp/apple-step9-after-search.png");
    const resultsText = await page.locator('li, [role="option"], [role="listitem"]').allTextContents();
    console.log("  Search results:", resultsText.filter(t => t.trim()).slice(0, 10));
  } else {
    console.log("  (no search input found)");
  }
  await clickFirst(page, [
    `:is(button,li,div,[role="option"]):has-text("Rosenstraße")`,
    `:is(button,li,div,[role="option"]):has-text("Rosenstrasse")`,
    `:is(button,li,div,[role="option"]):has-text("München")`,
    `:is(button,li,div,[role="option"]):has-text("Munich")`,
  ], 15000);
  await page.waitForTimeout(2000);

  // Step 9 — select target Saturday on the calendar
  console.log(`[9] Selecting Saturday ${TARGET_SATURDAY} on calendar…`);
  const dayNum = parseInt(TARGET_SATURDAY.split("-")[2], 10);
  const months: Record<number, string> = {
    1: "Januar", 2: "Februar", 3: "März", 4: "April", 5: "Mai",
    6: "Juni", 7: "Juli", 8: "August", 9: "September",
    10: "Oktober", 11: "November", 12: "Dezember",
  };
  const targetDate = new Date(TARGET_SATURDAY);
  const targetMonthName = months[targetDate.getMonth() + 1];

  for (let attempt = 0; attempt < 3; attempt++) {
    const header = page.locator('[class*="calendar"] [class*="header"], [class*="month"]').first();
    if (await header.isVisible({ timeout: 3000 })) {
      const headerText = await header.textContent() || "";
      if (headerText.includes(targetMonthName)) break;
      try {
        await clickFirst(page, [
          'button[aria-label*="nächsten Monat"]',
          'button[aria-label*="next month"]',
          'button[aria-label*="Next"]',
        ], 3000);
        await page.waitForTimeout(800);
      } catch { break; }
    }
  }

  const dayCell = page
    .locator('button:not([disabled]):not([aria-disabled="true"]), [role="gridcell"]:not([aria-disabled="true"])')
    .filter({ hasText: new RegExp(`^\\s*${dayNum}\\s*$`) })
    .first();
  await dayCell.waitFor({ timeout: 15000 });
  await dayCell.click();

  // Wait for timeslots API to fire (up to 15 s after clicking the date)
  console.log("[10] Waiting for timeslots API response…");
  const deadline = Date.now() + 15000;
  while (!timeslotsPayload && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  await browser.close();

  // ── Print results ────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log(`  Apple Store Rosenstraße — ${TARGET_SATURDAY}`);
  console.log("══════════════════════════════════════════════\n");

  if (!timeslotsPayload) {
    console.log("No timeslots API response captured.");
    console.log("API calls captured:", apiLog.map(e => `${e.status} ${e.path}`).join("\n  "));
    return;
  }

  const payload = timeslotsPayload as Record<string, unknown>;

  // The response structure can vary; try common shapes
  const slots: Array<{ startAt?: number; time?: string; available?: boolean }> =
    (payload.timeslots as typeof slots) ||
    (payload.slots as typeof slots) ||
    ((payload.data as Record<string, unknown>)?.timeslots as typeof slots) ||
    [];

  if (!slots.length) {
    console.log("Timeslots payload received but no slots array found.");
    console.log("Top-level keys:", Object.keys(payload));
    console.log("Raw payload:", JSON.stringify(payload, null, 2).slice(0, 2000));
    return;
  }

  console.log(`Found ${slots.length} slots:\n`);
  for (const slot of slots) {
    const ts = slot.startAt;
    const timeLabel = ts ? fmtMunich(ts) : (slot.time ?? "?");
    const avail = slot.available !== false ? "available" : "unavailable";
    console.log(`  ${timeLabel}  [${avail}]`);
  }
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
