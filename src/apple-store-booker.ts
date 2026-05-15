import { chromium, type Browser, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export type BookingPersonalInfo = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

export type SlotPriority = {
  // Munich hour, inclusive (e.g. 9 for 09:00)
  tier1StartHour: number;
  // Munich hour, exclusive (e.g. 10 means up to 09:59)
  tier1EndHour: number;
};

export type BookingResult = {
  success: boolean;
  confirmationNumber?: string;
  bookedDate?: string;
  bookedTimeLabel?: string;
  error?: string;
};

// Scores a Munich hour 4 (best) → 1 (worst) based on user priorities:
//   4 = tier1 window (e.g. 09:00–09:59)
//   3 = before tier1 (e.g. before 09:00)
//   2 = tier1End … 11:59
//   1 = 12:00+
function slotScore(hour: number, p: SlotPriority): number {
  if (hour >= p.tier1StartHour && hour < p.tier1EndHour) return 4;
  if (hour < p.tier1StartHour) return 3;
  if (hour < 12) return 2;
  return 1;
}

function parseHour(text: string): number {
  const m = text.match(/(\d{1,2}):\d{2}/);
  return m ? parseInt(m[1], 10) : -1;
}

async function snap(page: Page, label: string, dir?: string): Promise<void> {
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: resolve(dir, `${label}.png`), fullPage: true });
  } catch { /* ignore */ }
}

// Dismiss GDPR cookie consent banners common on EU Apple pages
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

// Click the first visible locator that matches one of the provided selector strings.
// Tries each in order; throws if none is found within `timeout` ms total.
async function clickFirst(
  page: Page,
  selectors: string[],
  timeout = 15000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click();
          return;
        }
      } catch { /* try next */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`None of the selectors matched within ${timeout}ms:\n  ${selectors.join("\n  ")}`);
}

// Fill an input identified by any of the provided CSS selectors (comma-joined).
async function fillField(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: 4000 });
    await el.fill(value);
    return true;
  } catch {
    console.warn(`[Booker] Could not fill selector: ${selector}`);
    return false;
  }
}

// ── Step implementations ─────────────────────────────────────────────────────

async function goToAppleSupport(page: Page, debugDir?: string): Promise<void> {
  console.log("[Booker] Loading getsupport.apple.com …");
  await page.goto("https://getsupport.apple.com/?locale=de_DE", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await dismissGdprBanner(page);
  await snap(page, "01-home", debugDir);
}

async function clickAirPodsCategory(page: Page, debugDir?: string): Promise<void> {
  console.log("[Booker] Clicking AirPods category …");
  await clickFirst(page, [
    // Exact-text button/link
    'button:has-text("AirPods"), a:has-text("AirPods")',
    // data-analytics attributes Apple commonly uses
    '[data-analytics-title="AirPods"]',
    '[data-autom="AirPods"]',
    // Fallback: any clickable element with exactly "AirPods" text
    ':is(button, a, [role="button"]):text-is("AirPods")',
  ]);
  await page.waitForTimeout(1500);
  await snap(page, "02-airpods", debugDir);
}

async function selectAirPods4ANCModel(page: Page, debugDir?: string): Promise<void> {
  console.log("[Booker] Selecting AirPods 4 with ANC model …");
  await clickFirst(page, [
    // German: "AirPods (4. Generation) mit Active Noise Cancellation"
    ':is(button, li, label, [role="option"]):has-text("4")',
    // Broad match covering various localised strings
    'button:text-matches("4.*(Active|ANC)", "i")',
    '[data-autom*="AirPods4ANC"]',
  ], 15000);
  await page.waitForTimeout(1500);
  await snap(page, "03-model", debugDir);
}

async function selectAudioTopic(page: Page, debugDir?: string): Promise<void> {
  console.log("[Booker] Selecting audio/sound topic …");
  await clickFirst(page, [
    ':is(button, li, label, [role="option"]):text-matches("Lautstärke|Audio|Klang|Sound", "i")',
    'button:has-text("Audio")',
    'li:has-text("Sound")',
  ]);
  await page.waitForTimeout(1500);
  await snap(page, "04-topic", debugDir);
}

async function selectIssueSubtopic(page: Page, debugDir?: string): Promise<void> {
  // This step is optional — not all flows show a sub-topic
  try {
    const subtopic = page.locator(
      ':is(button, li, label, [role="option"])',
    ).filter({
      hasText: /niedrig|leise|quiet|ein.*ohrknopf|one.*airpod|volume.*low|low.*volume/i,
    }).first();
    if (await subtopic.isVisible({ timeout: 3000 })) {
      console.log("[Booker] Selecting issue sub-topic …");
      await subtopic.click();
      await page.waitForTimeout(1500);
      await snap(page, "05-subtopic", debugDir);
    }
  } catch { /* optional */ }
}

async function selectInStoreRepair(page: Page, debugDir?: string): Promise<void> {
  console.log("[Booker] Selecting in-store repair …");
  await clickFirst(page, [
    ':is(button, a, [role="button"]):text-matches("Apple Store|Genius Bar|Reparatur.*Store|Store.*Termin|Bring in|einbringen", "i")',
    // Sometimes shown as a card
    '[data-autom*="genius"], [data-autom*="store"]',
  ], 20000);
  await page.waitForTimeout(2000);
  await snap(page, "06-repair", debugDir);
}

async function selectStore(page: Page, storeSearchTerm: string, debugDir?: string): Promise<void> {
  console.log(`[Booker] Searching for store: ${storeSearchTerm} …`);

  // Try filling a location search box
  const searchInput = page.locator(
    'input[type="text"], input[type="search"], input[placeholder*="Stadt"], input[placeholder*="Ort"], input[placeholder*="Location"]',
  ).first();
  if (await searchInput.isVisible({ timeout: 5000 })) {
    await searchInput.fill(storeSearchTerm);
    await page.waitForTimeout(2000);
  }

  // Click the store result
  await clickFirst(page, [
    ':is(button, li, [role="option"]):has-text("Rosenstraße")',
    ':is(button, li, [role="option"]):has-text("Rosenstrasse")',
    ':is(button, li, [role="option"]):has-text("München")',
  ], 15000);
  await page.waitForTimeout(2000);
  await snap(page, "07-store", debugDir);
}

async function selectSaturdayDate(page: Page, saturdayDate: string, debugDir?: string): Promise<void> {
  console.log(`[Booker] Selecting Saturday ${saturdayDate} …`);
  const dayNum = parseInt(saturdayDate.split("-")[2], 10);

  // Navigate to the correct month if needed
  const targetDate = new Date(saturdayDate);
  const months: Record<number, string> = {
    1: "Januar", 2: "Februar", 3: "März", 4: "April", 5: "Mai",
    6: "Juni", 7: "Juli", 8: "August", 9: "September",
    10: "Oktober", 11: "November", 12: "Dezember",
  };
  const targetMonthName = months[targetDate.getMonth() + 1];

  // Navigate forward until the right month is shown (max 2 months ahead)
  for (let attempt = 0; attempt < 3; attempt++) {
    const header = page.locator(
      '[class*="calendar"] [class*="header"], [class*="month-header"], [aria-label*="Monat"]',
    ).first();
    if (await header.isVisible({ timeout: 3000 })) {
      const headerText = await header.textContent() || "";
      if (headerText.includes(targetMonthName) || headerText.includes(String(targetDate.getFullYear()))) {
        break;
      }
      // Click the "next month" button
      try {
        await clickFirst(page, [
          'button[aria-label*="nächsten Monat"]',
          'button[aria-label*="next month"]',
          'button[aria-label*="Next"]',
          '[class*="calendar"] button:last-child',
        ], 3000);
        await page.waitForTimeout(800);
      } catch { break; }
    } else {
      break;
    }
  }

  // Click the day cell — must be enabled (not aria-disabled)
  const dayCell = page
    .locator('button:not([disabled]):not([aria-disabled="true"]), td:not([aria-disabled="true"]), [role="gridcell"]:not([aria-disabled="true"])')
    .filter({ hasText: new RegExp(`^\\s*${dayNum}\\s*$`) })
    .first();
  await dayCell.waitFor({ timeout: 15000 });
  await dayCell.click();
  await page.waitForTimeout(2000);
  await snap(page, "08-date", debugDir);
}

async function selectBestTimeSlot(
  page: Page,
  priority: SlotPriority,
  debugDir?: string,
): Promise<string> {
  console.log("[Booker] Scanning available time slots …");
  // Wait for at least one time slot to appear
  const slotLocator = page.locator('button:not([disabled]):not([aria-disabled="true"])').filter({
    hasText: /\d{1,2}:\d{2}/,
  });
  await slotLocator.first().waitFor({ timeout: 20000 });

  const all = await slotLocator.all();
  type Scored = { idx: number; label: string; hour: number; score: number };
  const scored: Scored[] = [];

  for (let i = 0; i < all.length; i++) {
    const label = ((await all[i].textContent()) || "").trim();
    const hour = parseHour(label);
    if (hour < 0) continue;
    scored.push({ idx: i, label, hour, score: slotScore(hour, priority) });
  }

  if (!scored.length) throw new Error("No available time slots found");

  // Higher score wins; ties broken by earlier hour
  scored.sort((a, b) => b.score - a.score || a.hour - b.hour);
  const best = scored[0];
  console.log(
    `[Booker] Slots: ${scored.map((s) => s.label).join(", ")} → picking ${best.label} (score ${best.score})`,
  );

  await all[best.idx].click();
  await page.waitForTimeout(1500);
  await snap(page, "09-slot", debugDir);
  return best.label;
}

async function fillCustomerForm(page: Page, info: BookingPersonalInfo, debugDir?: string): Promise<void> {
  console.log("[Booker] Filling customer information …");
  await page.waitForTimeout(1000);

  await fillField(
    page,
    'input[name*="first" i], input[id*="first" i], input[autocomplete="given-name"], input[placeholder*="Vorname" i]',
    info.firstName,
  );
  await fillField(
    page,
    'input[name*="last" i], input[id*="last" i], input[autocomplete="family-name"], input[placeholder*="Nachname" i]',
    info.lastName,
  );
  await fillField(
    page,
    'input[type="email"], input[name*="email" i], input[autocomplete="email"]',
    info.email,
  );
  await fillField(
    page,
    'input[type="tel"], input[name*="phone" i], input[autocomplete="tel"], input[placeholder*="Telefon" i]',
    info.phone,
  );

  await snap(page, "10-form", debugDir);
}

async function submitBooking(page: Page, debugDir?: string): Promise<void> {
  console.log("[Booker] Submitting booking …");
  await clickFirst(page, [
    'button[type="submit"]:has-text("Bestätigen"), button[type="submit"]:has-text("Confirm")',
    'button:has-text("Termin buchen"), button:has-text("Book")',
    'button:has-text("Reservieren"), button:has-text("Weiter")',
    'button[type="submit"]',
  ], 10000);
  await page.waitForTimeout(3000);
  await snap(page, "11-submitted", debugDir);
}

async function extractConfirmation(page: Page): Promise<string | undefined> {
  try {
    const body = (await page.textContent("body")) || "";
    // Apple confirmation numbers: typically alphanumeric, 6–15 chars
    const match = body.match(
      /(?:confirmation|bestätigung|reservierung(?:snummer)?|nr\.?)\s*[:#]?\s*([A-Z0-9]{6,15})/i,
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function tryBookAppleStoreSaturdaySlot(params: {
  storeId: string;
  storeName: string;
  saturdayDate: string;
  personal: BookingPersonalInfo;
  priority: SlotPriority;
  debugDir?: string;
}): Promise<BookingResult> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await goToAppleSupport(page, params.debugDir);
    await clickAirPodsCategory(page, params.debugDir);
    await selectAirPods4ANCModel(page, params.debugDir);
    await selectAudioTopic(page, params.debugDir);
    await selectIssueSubtopic(page, params.debugDir);
    await selectInStoreRepair(page, params.debugDir);
    await selectStore(page, "München", params.debugDir);
    await selectSaturdayDate(page, params.saturdayDate, params.debugDir);
    const bookedTimeLabel = await selectBestTimeSlot(page, params.priority, params.debugDir);
    await fillCustomerForm(page, params.personal, params.debugDir);
    await submitBooking(page, params.debugDir);
    const confirmationNumber = await extractConfirmation(page);

    console.log(
      `[Booker] Done. Time: ${bookedTimeLabel}, confirmation: ${confirmationNumber ?? "not found on page"}`,
    );

    return {
      success: true,
      confirmationNumber,
      bookedDate: params.saturdayDate,
      bookedTimeLabel,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[Booker] Failed:", error);
    return { success: false, error };
  } finally {
    await browser?.close();
  }
}
