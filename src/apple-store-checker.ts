const CDN_BASE = "https://retail-pz.cdn-apple.com/product-zone-prod/availability";

type SlotEntry = {
  storeNumber: string;
  appointmentsAvailable: boolean;
  firstAvailableAppointment?: number;
  errorCode?: string;
};

export type AppleStoreAutoBookConfig = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  slotTier1StartHour: number;
  slotTier1EndHour: number;
  debugDir?: string;
};

export type AppleStoreCheckerConfig = {
  storeId: string;
  storeName: string;
  issueDescription: string;
  notifyEmail: string;
  checkIntervalSeconds: number;
  saturdayMorningIntervalSeconds: number;
  autoBook?: AppleStoreAutoBookConfig;
};

async function fetchSnapshot(dateStr: string, utcHour: number): Promise<SlotEntry[] | null> {
  const h = String(utcHour).padStart(2, "0");
  const url = `${CDN_BASE}/${dateStr}/${h}/availability.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return (await res.json()) as SlotEntry[];
  } catch {
    return null;
  }
}

function isSaturdayMorningMunich(date: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "numeric",
    hour12: false
  }).formatToParts(date);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0");
  return weekday === "Sat" && hour >= 8 && hour < 12;
}

function nextSaturdayDate(): string {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const daysUntilSat = utcDay === 6 ? 7 : (6 - utcDay + 7) % 7 || 7;
  const sat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSat));
  return sat.toISOString().slice(0, 10);
}

export type AvailabilityCheckResult = {
  storeId: string;
  storeName: string;
  checkedAt: string;
  appointmentsAvailable: boolean;
  // Unix timestamp (seconds) from the CDN — the earliest bookable slot
  firstAvailableAppointment: number | null;
  // Whether firstAvailableAppointment falls on next Saturday 08:00-12:00 Munich
  isTargetSaturdayMorning: boolean;
  saturdayDate: string;
};

export async function checkAvailability(config: AppleStoreCheckerConfig): Promise<AvailabilityCheckResult> {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const utcHour = now.getUTCHours();
  const satDate = nextSaturdayDate();

  const snapshot = await fetchSnapshot(todayStr, utcHour);
  const entry = snapshot?.find(s => s.storeNumber === config.storeId);

  const appointmentsAvailable = entry?.appointmentsAvailable === true;
  const firstAvailableAppointment = entry?.firstAvailableAppointment ?? null;

  let isTargetSaturdayMorning = false;
  if (firstAvailableAppointment) {
    const firstAvailDate = new Date(firstAvailableAppointment * 1000);
    isTargetSaturdayMorning = isSaturdayMorningMunich(firstAvailDate)
      && firstAvailDate.toISOString().slice(0, 10) === satDate;
  }

  return {
    storeId: config.storeId,
    storeName: config.storeName,
    checkedAt: now.toISOString(),
    appointmentsAvailable,
    firstAvailableAppointment,
    isTargetSaturdayMorning,
    saturdayDate: satDate,
  };
}

export function startAppleStoreChecker(
  config: AppleStoreCheckerConfig,
  sendNotify: (subject: string, body: string) => Promise<void>
): { stop: () => void } {
  let handledForDate = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const bookingUrl = `https://getsupport.apple.com/locations?locale=de_DE&storeID=${config.storeId}`;

  const fmtMunich = (ts: number) => new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(new Date(ts * 1000));

  const sendAlert = async (satDate: string, timeLabel: string) => {
    await sendNotify(
      `Apple Store Saturday morning slot available — ${satDate}`,
      [
        `Saturday morning slots are available at ${config.storeName}!`,
        ``,
        `Earliest slot: ${timeLabel}`,
        `Issue: ${config.issueDescription}`,
        ``,
        `Book now: ${bookingUrl}`,
        `Slots fill up quickly — act fast!`
      ].join("\n")
    );
    console.log(`[Apple Store] Alert sent for ${satDate} ${timeLabel}`);
  };

  const sendConfirmation = async (satDate: string, timeLabel: string, confirmationNumber?: string) => {
    await sendNotify(
      `Apple Store appointment booked — ${satDate} at ${timeLabel}`,
      [
        `Your Genius Bar appointment has been booked at ${config.storeName}.`,
        ``,
        `Date: ${satDate} (Saturday)`,
        `Time: ${timeLabel} (Munich time)`,
        confirmationNumber ? `Confirmation: ${confirmationNumber}` : "",
        `Issue: ${config.issueDescription}`,
        ``,
        `Manage: https://getsupport.apple.com/`
      ].filter(Boolean).join("\n")
    );
    console.log(`[Apple Store] Confirmation sent for ${satDate} ${timeLabel}`);
  };

  const handleAvailability = async (result: AvailabilityCheckResult) => {
    const { saturdayDate, firstAvailableAppointment } = result;
    if (handledForDate === saturdayDate || !firstAvailableAppointment) return;

    const timeLabel = fmtMunich(firstAvailableAppointment);

    if (config.autoBook) {
      const ab = config.autoBook;
      console.log(`[Apple Store] Saturday morning slot detected for ${saturdayDate} — launching auto-booker…`);
      try {
        const { tryBookAppleStoreSaturdaySlot } = await import("./apple-store-booker.js");
        const bookResult = await tryBookAppleStoreSaturdaySlot({
          storeId: config.storeId,
          storeName: config.storeName,
          saturdayDate,
          personal: { firstName: ab.firstName, lastName: ab.lastName, email: ab.email, phone: ab.phone },
          priority: { tier1StartHour: ab.slotTier1StartHour, tier1EndHour: ab.slotTier1EndHour },
          debugDir: ab.debugDir,
        });

        if (bookResult.success && bookResult.bookedTimeLabel) {
          await sendConfirmation(saturdayDate, bookResult.bookedTimeLabel, bookResult.confirmationNumber);
          handledForDate = saturdayDate;
          return;
        }
        console.error(`[Apple Store] Auto-booking failed: ${bookResult.error} — falling back to alert.`);
      } catch (err) {
        console.error("[Apple Store] Auto-booker threw unexpectedly:", err);
      }
    }

    try {
      await sendAlert(saturdayDate, timeLabel);
      handledForDate = saturdayDate;
    } catch (err) {
      console.error("[Apple Store] Failed to send alert:", err);
    }
  };

  const run = async () => {
    try {
      const result = await checkAvailability(config);
      if (result.appointmentsAvailable && result.isTargetSaturdayMorning) {
        await handleAvailability(result);
      }
    } catch (err) {
      console.error("[Apple Store] Check failed:", err);
    }

    const isSatMorning = isSaturdayMorningMunich(new Date());
    const intervalMs = (isSatMorning
      ? config.saturdayMorningIntervalSeconds
      : config.checkIntervalSeconds) * 1000;
    timer = setTimeout(run, Math.max(30_000, intervalMs));
  };

  timer = setTimeout(run, 5_000);
  return { stop: () => { if (timer) clearTimeout(timer); } };
}
