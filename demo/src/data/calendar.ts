/**
 * The fictional week shown on /calendar. Fixed dates (never the real clock) so the demo and e2e runs are deterministic.
 * Times are "HH:MM" 24 hour strings on a 30 minute raster between 9 AM and 5 PM.
 */
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
export type DayName = (typeof DAYS)[number];

export const WEEK_LABEL = "Week of Sep 21, 2026";
export const DAY_DATES: Record<DayName, string> = {
  Monday: "Sep 21",
  Tuesday: "Sep 22",
  Wednesday: "Sep 23",
  Thursday: "Sep 24",
  Friday: "Sep 25",
};

export const DAY_START = "09:00";
export const DAY_END = "17:00";
export const SLOT_MINUTES = 30;
const AFTERNOON_START = "13:00";

export interface BusyEvent {
  day: DayName;
  start: string;
  end: string;
  title: string;
  tone: "class" | "work" | "personal";
}

/** What /calendar stores when a free slot is clicked, and what /mail/:id reads back. */
export interface PickedSlot {
  day: DayName;
  start: string;
  end: string;
  /** "Thursday 2:30 PM to 3:00 PM" */
  label: string;
}

export const BUSY_EVENTS: readonly BusyEvent[] = [
  { day: "Monday", start: "09:00", end: "09:30", title: "Team standup", tone: "work" },
  { day: "Monday", start: "10:00", end: "11:30", title: "Lecture: Distributed Systems", tone: "class" },
  { day: "Monday", start: "12:00", end: "13:00", title: "Lunch", tone: "personal" },
  { day: "Monday", start: "13:30", end: "15:00", title: "Capstone team sync", tone: "work" },
  { day: "Monday", start: "15:30", end: "17:00", title: "Robotics club build night", tone: "personal" },

  { day: "Tuesday", start: "09:00", end: "10:30", title: "Lecture: Algorithms", tone: "class" },
  { day: "Tuesday", start: "11:00", end: "12:00", title: "TA office hours", tone: "class" },
  { day: "Tuesday", start: "12:00", end: "13:00", title: "Lunch with Jordan", tone: "personal" },
  { day: "Tuesday", start: "13:00", end: "14:30", title: "Lab: Operating Systems", tone: "class" },
  { day: "Tuesday", start: "15:00", end: "17:00", title: "Hackathon planning", tone: "work" },

  { day: "Wednesday", start: "09:30", end: "11:00", title: "Lecture: Distributed Systems", tone: "class" },
  { day: "Wednesday", start: "11:00", end: "12:00", title: "Study group", tone: "class" },
  { day: "Wednesday", start: "12:30", end: "13:30", title: "Lunch", tone: "personal" },
  { day: "Wednesday", start: "14:00", end: "15:30", title: "Capstone design review", tone: "work" },
  { day: "Wednesday", start: "16:00", end: "17:00", title: "Gym", tone: "personal" },

  { day: "Thursday", start: "09:00", end: "10:30", title: "Lecture: Algorithms", tone: "class" },
  { day: "Thursday", start: "11:00", end: "12:00", title: "Project standup", tone: "work" },
  { day: "Thursday", start: "12:00", end: "13:00", title: "Lunch", tone: "personal" },
  { day: "Thursday", start: "13:00", end: "14:30", title: "Lab: Operating Systems", tone: "class" },
  { day: "Thursday", start: "15:00", end: "16:00", title: "Advisor meeting", tone: "work" },
  { day: "Thursday", start: "16:00", end: "17:00", title: "Robotics club", tone: "personal" },

  { day: "Friday", start: "09:00", end: "09:30", title: "Team standup", tone: "work" },
  { day: "Friday", start: "10:00", end: "11:30", title: "Lecture: Distributed Systems", tone: "class" },
  { day: "Friday", start: "12:00", end: "13:00", title: "Lunch", tone: "personal" },
  { day: "Friday", start: "13:00", end: "14:00", title: "Career centre workshop", tone: "work" },
  { day: "Friday", start: "15:00", end: "16:30", title: "Capstone demo rehearsal", tone: "work" },
];

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClock(value: unknown): value is string {
  return typeof value === "string" && CLOCK.test(value);
}

export function isDayName(value: unknown): value is DayName {
  return typeof value === "string" && (DAYS as readonly string[]).includes(value);
}

export function toMinutes(clock: string): number {
  const match = CLOCK.exec(clock);
  if (!match) throw new Error(`Not a HH:MM time: ${clock}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "14:30" -> "2:30 PM" */
export function formatTime(clock: string): string {
  const total = toMinutes(clock);
  const h24 = Math.floor(total / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(total % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

export function rangeLabel(start: string, end: string): string {
  return `${formatTime(start)} to ${formatTime(end)}`;
}

/** "Thursday 2:30 PM to 3:00 PM" */
export function slotLabel(day: DayName, start: string, end: string): string {
  return `${day} ${rangeLabel(start, end)}`;
}

/** Accessible name of a free slot button: "Thursday 2:30 PM to 3:00 PM, free" */
export function freeSlotName(slot: PickedSlot): string {
  return `${slot.label}, free`;
}

export function makeSlot(day: DayName, start: string): PickedSlot {
  const end = toClock(toMinutes(start) + SLOT_MINUTES);
  return { day, start, end, label: slotLabel(day, start, end) };
}

export function isAfternoon(slot: Pick<PickedSlot, "start">): boolean {
  return toMinutes(slot.start) >= toMinutes(AFTERNOON_START);
}

export function sameSlot(a: PickedSlot | null, b: PickedSlot | null): boolean {
  return a !== null && b !== null && a.day === b.day && a.start === b.start && a.end === b.end;
}

/** Start times of every 30 minute row, "09:00" through "16:30". */
export function rowStarts(): string[] {
  const starts: string[] = [];
  for (let t = toMinutes(DAY_START); t < toMinutes(DAY_END); t += SLOT_MINUTES) starts.push(toClock(t));
  return starts;
}

/** Problems with an event list: off the raster, outside the day, or overlapping. Empty when the data is sound. */
export function validateEvents(events: readonly BusyEvent[]): string[] {
  const problems: string[] = [];
  for (const e of events) {
    const name = `${e.day} ${e.start} ${e.title}`;
    if (!isClock(e.start) || !isClock(e.end)) {
      problems.push(`${name}: bad time`);
      continue;
    }
    const start = toMinutes(e.start);
    const end = toMinutes(e.end);
    if (start % SLOT_MINUTES !== 0 || end % SLOT_MINUTES !== 0) problems.push(`${name}: off the 30 minute raster`);
    if (end <= start) problems.push(`${name}: ends before it starts`);
    if (start < toMinutes(DAY_START) || end > toMinutes(DAY_END)) problems.push(`${name}: outside the day`);
  }
  for (const day of DAYS) {
    const sorted = events.filter((e) => e.day === day).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      if (toMinutes(next.start) < toMinutes(prev.end)) problems.push(`${day}: "${prev.title}" overlaps "${next.title}"`);
    }
  }
  return problems;
}

/** Where a 30 minute cell sits inside its busy block, so neighbouring cells can be drawn as one block. */
export type BusyPart = "only" | "start" | "middle" | "end";

/**
 * Every row has one cell per day (no rowspans): the table stays a regular grid, so a cell's column index
 * always matches its day header for assistive tech and for Shabang's table detection.
 */
export type GridCell =
  | { kind: "free"; slot: PickedSlot }
  /** `offset` is the cell's 0-based row inside its block. */
  | { kind: "busy"; event: BusyEvent; part: BusyPart; offset: number };

export interface GridRow {
  start: string;
  /** "9:00 AM" */
  label: string;
  /** One cell per entry of DAYS, in order. */
  cells: GridCell[];
}

function cellAt(day: DayName, start: string, events: readonly BusyEvent[]): GridCell {
  const at = toMinutes(start);
  for (const event of events) {
    if (event.day !== day) continue;
    const from = toMinutes(event.start);
    const to = toMinutes(event.end);
    if (at < from || at >= to) continue;
    const first = at === from;
    const last = at + SLOT_MINUTES >= to;
    const part: BusyPart = first && last ? "only" : first ? "start" : last ? "end" : "middle";
    return { kind: "busy", event, part, offset: (at - from) / SLOT_MINUTES };
  }
  return { kind: "free", slot: makeSlot(day, start) };
}

export function buildGrid(events: readonly BusyEvent[] = BUSY_EVENTS): GridRow[] {
  return rowStarts().map((start) => ({
    start,
    label: formatTime(start),
    cells: DAYS.map((day) => cellAt(day, start, events)),
  }));
}

/** Every free slot of the week, day by day, earliest first. */
export function freeSlots(events: readonly BusyEvent[] = BUSY_EVENTS): PickedSlot[] {
  const grid = buildGrid(events);
  return DAYS.flatMap((_, dayIndex) =>
    grid.flatMap((row) => {
      const cell = row.cells[dayIndex];
      return cell?.kind === "free" ? [cell.slot] : [];
    }),
  );
}

export function freeSlotsOn(day: DayName, events: readonly BusyEvent[] = BUSY_EVENTS): PickedSlot[] {
  return freeSlots(events).filter((slot) => slot.day === day);
}
