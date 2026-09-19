import type { ActionCandidate } from "@ghost/shared";

/** Deterministic, side-effect-free demo results. Never used when a real Composio client is configured. */
export function executeSimulated(candidate: ActionCandidate): Record<string, string | boolean | number> {
  switch (candidate.id) {
    case "calendar.check_availability":
      return { availableSlot: "Thursday 2:30 PM to 3:00 PM", start: "2026-09-24T14:30:00-04:00", end: "2026-09-24T15:00:00-04:00", calendarChecked: true };
    case "gmail.create_draft":
      return { draftId: "demo-draft-1001", draftCreated: true, draftPreview: "Thursday at 2:30 PM works for me. Looking forward to it!" };
    case "calendar.create_event":
      return { eventId: "demo-event-1001", eventCreated: true };
    case "github.create_issue":
      return { issueNumber: 42, issueCreated: true };
    case "local.fill_focused_field":
      return { localAction: true };
    default:
      return { completed: true };
  }
}
