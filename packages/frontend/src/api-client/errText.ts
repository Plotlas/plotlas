// The user-facing text for a failed API call.
//
// The API surfaces its reason in the `detail` field of the error body (FastAPI's
// convention); everything else falls back to the Error message, then the raw value. One
// shared copy so a change to the server's error envelope is edited in ONE place — the
// UI grew several verbatim copies of this (AdminScreen, the wizards, AuthPanel,
// activityContext, DatasetList); new call sites import this instead of adding another.

/** The server's `detail`, else the Error message, else the stringified value. */
export function errText(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { detail?: unknown }).detail === "string"
  ) {
    return (err as { detail: string }).detail;
  }
  return err instanceof Error ? err.message : String(err);
}
