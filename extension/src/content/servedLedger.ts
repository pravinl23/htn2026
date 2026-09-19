// What the server (or the per-site cache) said about each field, remembered by signature. The controller
// keeps its own copy for ghosts; learning and metrics read this one, so neither has to touch the controller.
import type { ServedAssignment } from "../lib/messages";
import type { PredictForm } from "./predict";

export interface ServedLedger {
  note(assignments: ServedAssignment[]): void;
  get(signature: string): ServedAssignment | undefined;
  clear(): void;
}

export function createServedLedger(max = 500): ServedLedger {
  const bySignature = new Map<string, ServedAssignment>();
  return {
    note(assignments) {
      if (bySignature.size + assignments.length > max) bySignature.clear(); // a long-lived SPA: start over, never grow
      for (const assignment of assignments.slice(0, max)) bySignature.set(assignment.signature, assignment);
    },
    get: (signature) => bySignature.get(signature),
    clear: () => bySignature.clear(),
  };
}

/** Same predictor, same answers; the ledger just sees them go by. */
export function observePredictions(predict: PredictForm, ledger: ServedLedger): PredictForm {
  return async (request) => {
    const answer = await predict(request);
    if (answer) ledger.note(answer.assignments);
    return answer;
  };
}
