import { describe, expect, it } from "vitest";
import {
  BUSY_EVENTS, DAYS, buildGrid, formatTime, freeSlotName, freeSlots, freeSlotsOn, isAfternoon, makeSlot,
  rowStarts, sameSlot, slotLabel, toClock, toMinutes, validateEvents, type BusyEvent,
} from "./calendar";

describe("time helpers", () => {
  it("converts between clock strings and minutes", () => {
    expect(toMinutes("09:00")).toBe(540);
    expect(toMinutes("14:30")).toBe(870);
    expect(toClock(870)).toBe("14:30");
    expect(() => toMinutes("2:30 PM")).toThrow();
  });

  it("formats 12 hour times", () => {
    expect(formatTime("09:00")).toBe("9:00 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatTime("12:30")).toBe("12:30 PM");
    expect(formatTime("14:30")).toBe("2:30 PM");
    expect(formatTime("00:00")).toBe("12:00 AM");
  });
});

describe("slot labels", () => {
  it("builds the label Ghost and the mail page rely on", () => {
    expect(slotLabel("Thursday", "14:30", "15:00")).toBe("Thursday 2:30 PM to 3:00 PM");
    expect(makeSlot("Thursday", "14:30")).toEqual({
      day: "Thursday",
      start: "14:30",
      end: "15:00",
      label: "Thursday 2:30 PM to 3:00 PM",
    });
  });

  it("names a free slot button with a ', free' suffix", () => {
    expect(freeSlotName(makeSlot("Thursday", "14:30"))).toBe("Thursday 2:30 PM to 3:00 PM, free");
    expect(freeSlotName(makeSlot("Monday", "11:30"))).toBe("Monday 11:30 AM to 12:00 PM, free");
  });

  it("compares slots by day and times, never matching null", () => {
    expect(sameSlot(makeSlot("Thursday", "14:30"), makeSlot("Thursday", "14:30"))).toBe(true);
    expect(sameSlot(makeSlot("Thursday", "14:30"), makeSlot("Friday", "14:30"))).toBe(false);
    expect(sameSlot(null, null)).toBe(false);
  });
});

describe("week grid", () => {
  it("has sound event data", () => {
    expect(validateEvents(BUSY_EVENTS)).toEqual([]);
  });

  it("reports overlapping and off-raster events", () => {
    const bad: BusyEvent[] = [
      { day: "Monday", start: "09:00", end: "10:00", title: "A", tone: "work" },
      { day: "Monday", start: "09:30", end: "10:30", title: "B", tone: "work" },
      { day: "Tuesday", start: "09:15", end: "10:00", title: "C", tone: "work" },
      { day: "Tuesday", start: "16:00", end: "18:00", title: "D", tone: "work" },
    ];
    const problems = validateEvents(bad).join("\n");
    expect(problems).toContain('"A" overlaps "B"');
    expect(problems).toContain("C: off the 30 minute raster");
    expect(problems).toContain("D: outside the day");
  });

  it("has 16 half hour rows from 9 AM to 5 PM with one cell per weekday", () => {
    const grid = buildGrid();
    expect(rowStarts()).toHaveLength(16);
    expect(grid.map((row) => row.start)).toEqual(rowStarts());
    expect(grid[0]?.label).toBe("9:00 AM");
    expect(grid.at(-1)?.label).toBe("4:30 PM");
    for (const row of grid) expect(row.cells).toHaveLength(DAYS.length);
  });

  it("marks where each cell sits inside its busy block", () => {
    const grid = buildGrid();
    const thursday = DAYS.indexOf("Thursday");
    const parts = grid.map((row) => {
      const cell = row.cells[thursday];
      return cell?.kind === "busy" ? `${cell.part}${cell.offset}` : "free";
    });
    // 9:00 to 10:30 lecture, free, 11:00 to 12:00 standup, 12:00 to 1:00 lunch, 1:00 to 2:30 lab, FREE, ...
    expect(parts).toEqual([
      "start0", "middle1", "end2", "free", "start0", "end1", "start0", "end1",
      "start0", "middle1", "end2", "free", "start0", "end1", "start0", "end1",
    ]);
    const monday = grid[0]?.cells[0];
    expect(monday?.kind === "busy" && monday.part).toBe("only");
  });

  it("has exactly one free Thursday afternoon slot: 2:30 PM to 3:00 PM", () => {
    const afternoon = freeSlotsOn("Thursday").filter(isAfternoon);
    expect(afternoon).toEqual([
      { day: "Thursday", start: "14:30", end: "15:00", label: "Thursday 2:30 PM to 3:00 PM" },
    ]);
  });

  it("leaves Thursday noon busy, so 'afternoon' is unambiguous however it is read", () => {
    const fromNoon = freeSlotsOn("Thursday").filter((slot) => toMinutes(slot.start) >= toMinutes("12:00"));
    expect(fromNoon).toHaveLength(1);
  });

  it("offers other free slots too, but few enough to stay under Ghost's 60 candidate limit", () => {
    const all = freeSlots();
    expect(freeSlotsOn("Thursday").some((slot) => !isAfternoon(slot))).toBe(true);
    expect(all.length).toBeGreaterThan(5);
    expect(all.length).toBeLessThanOrEqual(24);
    expect(new Set(all.map((slot) => slot.label)).size).toBe(all.length);
  });

  it("treats a week without events as entirely free", () => {
    expect(freeSlots([])).toHaveLength(DAYS.length * 16);
  });
});
