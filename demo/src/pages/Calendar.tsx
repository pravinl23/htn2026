import { useMemo } from "react";
import {
  DAYS, DAY_DATES, WEEK_LABEL, buildGrid, formatTime, freeSlotName, rangeLabel, sameSlot,
  type GridCell, type PickedSlot,
} from "../data/calendar";
import { backToMailPath, savePickedSlot } from "../data/mailStorage";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import "../styles/calendar.css";
import { MailChrome } from "./mail/MailChrome";
import { useMailState } from "./mail/useMailState";

function PickedBanner({ picked, backHref }: { picked: PickedSlot | null; backHref: string }) {
  return (
    <div className="cal-banner-region" role="status" data-testid="calendar-status">
      {picked && (
        <div className="cal-banner" data-testid="calendar-banner">
          <p>
            <span className="cal-banner-label">Picked time</span>
            <strong data-field="picked-slot">{picked.label}</strong>
          </p>
          <Link className="cal-back" href={backHref}>
            Back to mail
          </Link>
        </div>
      )}
    </div>
  );
}

function SlotCell({ cell, picked }: { cell: GridCell; picked: PickedSlot | null }) {
  if (cell.kind === "busy") {
    const { event, part, offset } = cell;
    const time = rangeLabel(event.start, event.end);
    return (
      <td className={`cal-busy cal-busy-${part} cal-tone-${event.tone}`}>
        {offset === 0 && (
          <span className="cal-event-title">
            {event.title}
            <span className="cal-vh">, busy, {time}</span>
          </span>
        )}
        {offset === 1 && (
          <span className="cal-event-time" aria-hidden="true">
            {time}
          </span>
        )}
        {offset > 0 && <span className="cal-vh">Busy: {event.title}</span>}
      </td>
    );
  }
  const { slot } = cell;
  const isPicked = sameSlot(slot, picked);
  return (
    <td className="cal-free">
      <button
        type="button"
        className="cal-slot"
        aria-label={freeSlotName(slot)}
        aria-pressed={isPicked}
        data-testid="cal-slot"
        data-day={slot.day}
        data-start={slot.start}
        data-end={slot.end}
        data-picked={isPicked ? "true" : undefined}
        onClick={() => savePickedSlot(slot)}
      >
        <span className="cal-slot-time">{formatTime(slot.start)}</span>
        <span className="cal-slot-state">{isPicked ? "Picked" : "Free"}</span>
      </button>
    </td>
  );
}

export function Calendar(_props: { params: RouteParams }) {
  const mail = useMailState();
  const grid = useMemo(() => buildGrid(), []);
  const picked = mail.pickedSlot;

  return (
    <MailChrome app="Calendar" className="cal">
      <main className="page cal-page">
        <div className="cal-heading">
          <div>
            <p className="eyebrow">Calendar</p>
            <h1 data-field="week">{WEEK_LABEL}</h1>
          </div>
          <Link className="cal-inbox" href="/mail">
            Inbox
          </Link>
        </div>
        <p className="lede cal-lede">Pick a free slot to offer it in your reply. Busy blocks cannot be picked.</p>

        <PickedBanner picked={picked} backHref={backToMailPath(mail.lastOpenedId)} />

        <div className="cal-scroll">
          <table className="cal-table" data-testid="calendar-week">
            <caption className="cal-caption">
              {WEEK_LABEL}, Monday to Friday, 9:00 AM to 5:00 PM in 30 minute rows
            </caption>
            <thead>
              <tr>
                <th scope="col" className="cal-corner">
                  Time
                </th>
                {DAYS.map((day) => (
                  <th key={day} scope="col" data-day={day}>
                    <span className="cal-day-name">{day}</span> <span className="cal-day-date">{DAY_DATES[day]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.start} className={row.start.endsWith(":00") ? "cal-row-hour" : "cal-row-half"}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((cell, i) => (
                    <SlotCell key={DAYS[i] ?? i} cell={cell} picked={picked} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </MailChrome>
  );
}
