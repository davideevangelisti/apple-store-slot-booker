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

// Returns today's date if today (UTC) is Saturday, otherwise next Saturday
function currentOrNextSaturdayDate(): string {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const daysUntilSat = utcDay === 6 ? 0 : 6 - utcDay;
  const sat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSat));
  return sat.toISOString().slice(0, 10);
}

// Find which UTC hours correspond to 8am-11am Munich time on the given date
function saturdayMorningUtcHours(satDateStr: string): number[] {
  const result: number[] = [];
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hour: "numeric",
    hour12: false
  });
  for (let utcH = 0; utcH < 24; utcH++) {
    const d = new Date(`${satDateStr}T${String(utcH).padStart(2, "0")}:00:00Z`);
    const munichHour = parseInt(fmt.format(d));
    if (munichHour >= 8 && munichHour < 12) result.push(utcH);
  }
  return result;
}

function formatMunichHour(satDateStr: string, utcHour: number): string {
  const d = new Date(`${satDateStr}T${String(utcHour).padStart(2, "0")}:00:00Z`);
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

export type AvailabilityCheckResult = {
  storeId: string;
  storeName: string;
  checkedAt: string;
  currentlyAvailable: boolean;
  isSaturdayMorningNow: boolean;
  saturdayDate: string;
  // UTC hours for which Saturday-specific CDN files already exist with availability
  saturdayAdvanceSlotUtcHours: number[];
};

export async function checkAllSaturdaySlotHours(config: AppleStoreCheckerConfig, satDateStr: string): Promise<number[]> {
  const available: number[] = [];
  for (let utcH = 6; utcH <= 21; utcH++) {
    const slots = await fetchSnapshot(satDateStr, utcH);
    const entry = slots?.find(s => s.storeNumber === config.storeId);
    if (entry?.appointmentsAvailable) available.push(utcH);
  }
  return available;
}

export async function checkAvailability(config: AppleStoreCheckerConfig): Promise<AvailabilityCheckResult> {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const utcHour = now.getUTCHours();
  const satDate = currentOrNextSaturdayDate();

  const currentSlots = await fetchSnapshot(todayStr, utcHour);
  const currentEntry = currentSlots?.find(s => s.storeNumber === config.storeId);
  const currentlyAvailable = currentEntry?.appointmentsAvailable === true;
  const isSatMorning = isSaturdayMorningMunich(now);

  const saturdayAdvanceSlotUtcHours: number[] = [];
  // Only try advance Saturday check when today is NOT already Saturday
  if (satDate !== todayStr) {
    const morningHours = saturdayMorningUtcHours(satDate);
    for (const h of morningHours) {
      const slots = await fetchSnapshot(satDate, h);
      const entry = slots?.find(s => s.storeNumber === config.storeId);
      if (entry?.appointmentsAvailable) saturdayAdvanceSlotUtcHours.push(h);
    }
  }

  return {
    storeId: config.storeId,
    storeName: config.storeName,
    checkedAt: now.toISOString(),
    currentlyAvailable,
    isSaturdayMorningNow: isSatMorning,
    saturdayDate: satDate,
    saturdayAdvanceSlotUtcHours
  };
}

export function startAppleStoreChecker(
  config: AppleStoreCheckerConfig,
  sendEmail: (subject: string, body: string) => Promise<void>
): { stop: () => void } {
  let handledForDate = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const bookingUrl = `https://getsupport.apple.com/locations?locale=de_DE&storeID=${config.storeId}`;

  const sendNotification = async (satDate: string, reason: string, slots?: string) => {
    const subject = `Apple Store Saturday morning slot available - ${satDate}`;
    const body = [
      `Saturday morning appointment slots are now available at ${config.storeName}!`,
      ``,
      `Date: ${satDate} (Saturday)`,
      `Time window: 08:00-12:00 Munich time`,
      slots ? `Detected hours: ${slots}` : "",
      `Reason: ${reason}`,
      ``,
      `Issue: ${config.issueDescription}`,
      ``,
      `Book your appointment now:`,
      bookingUrl,
      ``,
      `Slots fill up quickly - act fast!`
    ].filter(Boolean).join("\n");

    await sendEmail(subject, body);
    console.log(`[Apple Store] Notified for ${satDate}: ${reason}`);
  };

  const sendConfirmation = async (
    satDate: string,
    timeLabel: string,
    confirmationNumber?: string
  ) => {
    const subject = `Apple Store appointment booked for ${satDate} at ${timeLabel}`;
    const body = [
      `Your Genius Bar appointment has been booked at ${config.storeName}.`,
      ``,
      `Date: ${satDate} (Saturday)`,
      `Time: ${timeLabel} (Munich time)`,
      confirmationNumber ? `Confirmation number: ${confirmationNumber}` : "",
      ``,
      `Issue: ${config.issueDescription}`,
      ``,
      `Manage your appointment: https://getsupport.apple.com/`,
    ].filter(Boolean).join("\n");

    await sendEmail(subject, body);
    console.log(`[Apple Store] Confirmation sent for ${satDate} ${timeLabel}`);
  };

  const handleAvailability = async (satDate: string, reason: string, slots?: string) => {
    if (handledForDate === satDate) return;

    if (config.autoBook) {
      const ab = config.autoBook;
      console.log(`[Apple Store] Availability detected for ${satDate} — launching auto-booker …`);
      try {
        const { tryBookAppleStoreSaturdaySlot } = await import("./apple-store-booker.js");
        const result = await tryBookAppleStoreSaturdaySlot({
          storeId: config.storeId,
          storeName: config.storeName,
          saturdayDate: satDate,
          personal: {
            firstName: ab.firstName,
            lastName: ab.lastName,
            email: ab.email,
            phone: ab.phone,
          },
          priority: {
            tier1StartHour: ab.slotTier1StartHour,
            tier1EndHour: ab.slotTier1EndHour,
          },
          debugDir: ab.debugDir,
        });

        if (result.success && result.bookedTimeLabel) {
          await sendConfirmation(satDate, result.bookedTimeLabel, result.confirmationNumber);
          handledForDate = satDate;
          return;
        }

        console.error(`[Apple Store] Auto-booking failed: ${result.error}. Falling back to email notification.`);
      } catch (err) {
        console.error("[Apple Store] Auto-booker threw unexpectedly:", err);
      }
    }

    try {
      await sendNotification(satDate, reason, slots);
      handledForDate = satDate;
    } catch (err) {
      console.error("[Apple Store] Failed to send notification email:", err);
    }
  };

  const run = async () => {
    try {
      const result = await checkAvailability(config);

      if (result.currentlyAvailable && result.isSaturdayMorningNow) {
        await handleAvailability(result.saturdayDate, "Store has same-day Saturday morning availability");
      }

      if (result.saturdayAdvanceSlotUtcHours.length > 0) {
        const slotStr = result.saturdayAdvanceSlotUtcHours
          .map(h => formatMunichHour(result.saturdayDate, h))
          .join(", ");
        await handleAvailability(result.saturdayDate, "Advance Saturday morning slots detected", slotStr);
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
