/**
 * FOMC Calendar — hardcoded event times (UTC) for rate decisions and minutes releases.
 *
 * All times are 2:00 PM ET converted to UTC:
 *   EST (Nov–Mar): 19:00 UTC
 *   EDT (Mar–Nov): 18:00 UTC
 *
 * Update this file each year when the Fed publishes the new schedule:
 *   https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 */

interface FomcEvent {
  time: Date;
  description: string; // e.g. "FOMC Rate Decision", "FOMC Minutes"
}

// ---------------------------------------------------------------------------
// 2025 Rate Decisions
// ---------------------------------------------------------------------------
const FOMC_2025_DECISIONS: FomcEvent[] = [
  { time: new Date('2025-01-29T19:00:00Z'), description: 'FOMC Rate Decision' }, // EST
  { time: new Date('2025-03-19T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2025-05-07T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2025-06-18T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2025-07-30T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2025-09-17T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2025-10-29T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT (DST ends Nov 2)
  { time: new Date('2025-12-10T19:00:00Z'), description: 'FOMC Rate Decision' }, // EST
];

// ---------------------------------------------------------------------------
// 2025 Minutes Releases (~3 weeks after each meeting, 2:00 PM ET)
// ---------------------------------------------------------------------------
const FOMC_2025_MINUTES: FomcEvent[] = [
  { time: new Date('2025-02-19T19:00:00Z'), description: 'FOMC Minutes' }, // Jan meeting → EST
  { time: new Date('2025-04-09T18:00:00Z'), description: 'FOMC Minutes' }, // Mar meeting → EDT
  { time: new Date('2025-05-28T18:00:00Z'), description: 'FOMC Minutes' }, // May meeting → EDT
  { time: new Date('2025-07-09T18:00:00Z'), description: 'FOMC Minutes' }, // Jun meeting → EDT
  { time: new Date('2025-08-20T18:00:00Z'), description: 'FOMC Minutes' }, // Jul meeting → EDT
  { time: new Date('2025-10-08T18:00:00Z'), description: 'FOMC Minutes' }, // Sep meeting → EDT
  { time: new Date('2025-11-19T19:00:00Z'), description: 'FOMC Minutes' }, // Oct meeting → EST
  { time: new Date('2026-01-07T19:00:00Z'), description: 'FOMC Minutes' }, // Dec 2025 meeting → EST
];

// ---------------------------------------------------------------------------
// 2026 Rate Decisions (tentative — verify at start of year)
// ---------------------------------------------------------------------------
const FOMC_2026_DECISIONS: FomcEvent[] = [
  { time: new Date('2026-01-28T19:00:00Z'), description: 'FOMC Rate Decision' }, // EST
  { time: new Date('2026-03-18T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT (DST starts Mar 8)
  { time: new Date('2026-04-29T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2026-06-10T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2026-07-29T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2026-09-16T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT
  { time: new Date('2026-10-28T18:00:00Z'), description: 'FOMC Rate Decision' }, // EDT (DST ends Nov 1)
  { time: new Date('2026-12-09T19:00:00Z'), description: 'FOMC Rate Decision' }, // EST
];

// ---------------------------------------------------------------------------
// 2026 Minutes Releases (tentative)
// ---------------------------------------------------------------------------
const FOMC_2026_MINUTES: FomcEvent[] = [
  { time: new Date('2026-02-18T19:00:00Z'), description: 'FOMC Minutes' }, // Jan meeting → EST
  { time: new Date('2026-04-08T18:00:00Z'), description: 'FOMC Minutes' }, // Mar meeting → EDT
  { time: new Date('2026-05-20T18:00:00Z'), description: 'FOMC Minutes' }, // Apr meeting → EDT
  { time: new Date('2026-07-01T18:00:00Z'), description: 'FOMC Minutes' }, // Jun meeting → EDT
  { time: new Date('2026-08-19T18:00:00Z'), description: 'FOMC Minutes' }, // Jul meeting → EDT
  { time: new Date('2026-10-07T18:00:00Z'), description: 'FOMC Minutes' }, // Sep meeting → EDT
  { time: new Date('2026-11-18T19:00:00Z'), description: 'FOMC Minutes' }, // Oct meeting → EST
  { time: new Date('2027-01-06T19:00:00Z'), description: 'FOMC Minutes' }, // Dec 2026 meeting → EST
];

const ALL_FOMC_EVENTS: FomcEvent[] = [
  ...FOMC_2025_DECISIONS,
  ...FOMC_2025_MINUTES,
  ...FOMC_2026_DECISIONS,
  ...FOMC_2026_MINUTES,
];

export interface FomcWindowResult {
  isFomcWindow: boolean;
  minutesToEvent: number; // 999 when no upcoming event within window
  eventDescription: string;
}

/**
 * Returns true if an FOMC event is scheduled within the next `windowMinutes` minutes.
 * Only checks future events (now → now + windowMinutes).
 */
export function checkFomcWindow(windowMinutes = 30): FomcWindowResult {
  const now = new Date();
  const windowMs = windowMinutes * 60_000;

  for (const event of ALL_FOMC_EVENTS) {
    const msToEvent = event.time.getTime() - now.getTime();
    if (msToEvent > 0 && msToEvent <= windowMs) {
      return {
        isFomcWindow: true,
        minutesToEvent: Math.ceil(msToEvent / 60_000),
        eventDescription: event.description,
      };
    }
  }

  return { isFomcWindow: false, minutesToEvent: 999, eventDescription: '' };
}
