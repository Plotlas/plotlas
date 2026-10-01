// Create-dataset wizard (catalogue ui/admin required capabilities): upload
// session → parts (native multi-file input, a folder pick, drag-drop, AND/OR a
// single .zip — D-27; optional CSV/TSV) → client-side header parse (§0.5; no
// preview endpoint) → role dropdowns → layout_types gated on roles (grid always
// on) → finalize → createDataset → job-progress polling (jobPoll.ts).
//
// Seam O4 (resilient transport): the strictly-serial `uploadPart` loop is replaced by
// the bounded-parallel, retrying, progress-emitting transport (uploadTransport) over the
// XHR client method (uploadPartWithProgress) — real byte progress, ~4 parts in flight,
// per-part jittered-backoff retry, a 200 already_present counted as success, and terminal
// per-file failures COLLECTED (the run continues, then reports) instead of killing the
// upload. The open session is persisted to localStorage (uploadSession), so a crash/
// refresh can RESUME: re-select the same files, diff against the server (/check), and send
// only what it lacks. A pre-flight caps check refuses an over-cap selection before the
// first byte. Folder pick (webkitdirectory) + drag-drop flatten to basenames (D-25).
//
// Stateful container — composed into App, never imported by node tests (its
// presentational pieces + the pure uploadSelection/uploadTransport/uploadSession modules
// are tested directly; the wizard integration is DOM-tested). All network through the
// injected ApiClient; server cap errors (413) and every other failure surface via the
// thrown ApiError's detail.
import { createElement as h, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import { uploadAlreadyCreated } from "../../api-client/client.ts";
import type { JobStatus } from "../../api-client/types";
import { parseFirstRowFor, parseHeaderFor } from "./csvHeader";
import { availableLayoutTypes, buildColumnRoles, buildPresentation, emptyDraft, validateDraft } from "./roles";
import type { RolesDraft } from "./roles";
import { RoleAssignmentForm } from "./RoleAssignmentForm";
import { JobProgressView } from "./JobProgress";
import { StepRail, stepStates } from "./stepRail";
import { createUnmountGuard, pollJob } from "./jobPoll";
import { useActivityActions } from "../activity/activityContext";
import {
  DEFAULT_UPLOAD_CAPS,
  basenameOf,
  buildImageSelection,
  capsFromServer,
  fingerprintFiles,
  formatBytes,
  preflightCaps,
} from "./uploadSelection";
import type { SelectionPart, UploadCaps } from "./uploadSelection";
import { planResume, runUploadBatch } from "./uploadTransport";
import type { BatchResult, BatchSnapshot, ResumePlan } from "./uploadTransport";
import {
  clearUploadSession,
  describeUploadSession,
  loadUploadSession,
  saveUploadSession,
} from "./uploadSession";
import type { PersistedUploadSession } from "./uploadSession";
import { UploadProgressView } from "./UploadProgressView";

export interface CreateDatasetWizardProps {
  client: ApiClient;
  /** Called when the user leaves the finished/failed job view. */
  onDone: () => void;
  onAuthExpired: () => void;
}

function errText(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { detail?: unknown }).detail === "string") {
    return (err as { detail: string }).detail;
  }
  return err instanceof Error ? err.message : String(err);
}

function errStatus(err: unknown): number | null {
  if (typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

// form: the source/roles/layouts inputs · resume-review: the diff of a re-selected bundle
// against a persisted session · uploading: the transport is running (or settled with
// failures to review) · polling: the enqueued ingest job · adopted: the create found the
// upload already made into a collection with no job left to follow, and says so.
// resume-review/uploading both map to the rail's "uploading" step (source captured,
// progress carrying the flow); adopted maps to a finished "polling" step.
type Phase = "form" | "resume-review" | "uploading" | "polling" | "adopted";

/** What the wizard says when a create is answered `upload_already_created` with no job
 *  to follow. Its own words, not the 409's `message`: that one offers "create with an
 *  explicit dataset_id", which this intake no longer asks for (D-xxviii). */
export const ADOPTED_WITHOUT_JOB_NOTICE =
  "This upload was already made into a collection, so nothing new was created. It is in your Library.";

/** What the run is doing right now, inside `phase === "uploading"`. Set by the code that
 *  ENTERS each stage — never inferred from whether `batch` or a note happens to be null.
 *  Inferring it is precisely what made the finalize window invisible: `batch` is non-null
 *  from the transport's first `emit()` onward and is never cleared, so it was a permanent
 *  "there is nothing else to say", and every note set after the first byte was written
 *  into a state nothing rendered.
 *
 *  One stage drives three things that must never disagree: the narration line, whether the
 *  progress bar is drawn, and whether Cancel can honestly be offered. */
type RunStage =
  | "preparing" // createUpload() — the click has been acknowledged, no session yet
  | "checking" // resume: listUploads + the chunked /check diff
  | "transferring" // runUploadBatch is running and the AbortController reaches it
  | "sealing" // finalizeUpload + getUploadStatus — the bundle is being sealed for ingest
  | "enqueueing"; // createDataset

/** The narration for each stage. `transferring` is deliberately empty: the progress bar
 *  is on screen saying "Uploading — n of m files · x%", and repeating that in prose is
 *  noise. Every other stage has no bytes moving, so this line is the only live thing. */
const RUN_STAGE_NOTE: Record<RunStage, string> = {
  preparing: "Preparing upload…",
  checking: "Checking your previous upload…",
  transferring: "",
  sealing: "Finalizing upload — the server is tallying every file it received.",
  enqueueing: "Starting ingest…",
};

/** Why there is no Cancel, drawn where Cancel was. This map is the single source of truth
 *  for which stages are cancellable: a stage listed here is not, and every other stage
 *  gets the button.
 *
 *  Past `finalizeUpload` the bundle is sealed server-side and `finishUpload` awaits plain
 *  client calls with NO signal and no aborted guard ([[T2-116]] R1) — so a Cancel there
 *  would abort nothing, drop the user on the form, and then be overruled seconds later by
 *  the continuation it failed to stop, having created the dataset. Saying so is the honest
 *  control; a button that lies is not.
 *
 *  `preparing`/`checking` are deliberately absent — nothing is sealed yet, and the run
 *  token is re-checked at every await in that path, so pressing Cancel there stops the
 *  continuation. **Three limits on that, none of them assumed:**
 *
 *  1. The check is an IDENTITY comparison, because a boolean got this wrong — a cancelled
 *     run's continuation woke up inside its replacement's lock (see `runTokenRef`).
 *  2. `checking` stops at a BATCH BOUNDARY, not instantly. `planResume` is one await over
 *     a serial loop of up to 25 `/check` round trips; the token check is injected into the
 *     loop through the client wrapper in `beginResume`, so at most the request already in
 *     flight completes. Aborting that one needs a signal on `checkUploadFiles`, which is
 *     transport-owned.
 *  3. It only covers Cancel. **Closing the wizard does not stop these stages** — the
 *     unmount effect aborts the transport's controller and nothing else, so a run
 *     unmounted during `preparing` still finalizes and creates the dataset. That is
 *     [[T2-116]] R1's mechanism one window earlier, recorded there, not fixed here. */
const RUN_STAGE_NO_CANCEL: Partial<Record<RunStage, string>> = {
  sealing: "This can no longer be cancelled — the bundle is being sealed for ingest.",
  enqueueing:
    "This can no longer be cancelled — the dataset is being created. The ingest job appears here as soon as it starts.",
};

/** Thrown by `beginResume`'s `/check` wrapper to break out of `planResume`'s loop when the
 *  run has been cancelled or superseded. Not a failure: the canceller already owns the
 *  transition, so it is caught and swallowed rather than surfaced as an error. */
class RunAbandoned extends Error {
  constructor() {
    super("run abandoned");
    this.name = "RunAbandoned";
  }
}

/** How many parts the selection panel lists individually. A selection may hold up to
 *  MAX_UPLOAD_ENTRIES = 1 000 000 parts, so it is never a row per file. This is a display
 *  budget, not a limit on anything real, and it binds VISIBLY — the panel says how many
 *  files it is not showing — so it can never silently hide what a user is looking for. */
const MAX_LISTED_PARTS = 12;

/** The selection panel's bounded view: total bytes plus the rows to draw, in ONE pass
 *  (this seam's rider is measuring the per-selection passes; adding an O(n log n) sort of
 *  the whole selection would be adding to exactly what it measures).
 *
 *  **The invariant this exists to hold: every part a cap error can name has a Remove row.**
 *  `preflightCaps` refuses the selection when any part exceeds the per-part cap and tells
 *  the user to "Remove or shrink it" — so if the panel cannot list that part, the message
 *  asks for something the screen cannot do, which is the whole defect this seam closes.
 *
 *  ONE rule delivers it: order strictly by size, descending, across every part. An
 *  over-cap part is by definition larger than every under-cap part, so the over-cap parts
 *  are a true PREFIX of that order and the first `limit` rows always start with them.
 *  (Equal sizes are all over or all under, so ties cannot interleave.) With more than
 *  `limit` offenders the user removes the listed ones and the next batch surfaces — the
 *  message counts them, so this terminates visibly.
 *
 *  It does not read the cap to do this, and must not — not for an ownership reason but
 *  because it does not need one: descending SIZE order alone puts the offenders first,
 *  whatever the cap turns out to be. That keeps this helper correct under a cap the
 *  server supplies at runtime (Seam A2) exactly as it was under a compiled-in one, and
 *  it is why the helper needs no re-test when the caps source changes.
 *
 *  **Archives lost their reserved rows to that invariant, deliberately.** Listing every
 *  `.zip` first was the earlier shape and it broke the guarantee: 12 small archives plus
 *  one 200 MiB image produced twelve archive rows, no `Remove huge.png`, and a cap error
 *  naming a file the panel refused to draw. An archive is usually among the largest parts
 *  anyway, so it usually still gets a row — but that is now a tendency, not a promise, and
 *  the gap is tracked rather than argued away
 *  (`backlog/T2-a-mid-sized-file-in-the-middle-of-a-selection.md`). */
function summarizeSelection(
  parts: readonly SelectionPart<File>[],
  limit: number,
): { totalBytes: number; rows: SelectionPart<File>[]; hidden: number } {
  let totalBytes = 0;
  const rows: SelectionPart<File>[] = [];
  for (const part of parts) {
    totalBytes += part.size;
    insertBySize(rows, part, limit);
  }
  return { totalBytes, rows, hidden: parts.length - rows.length };
}

/** Bounded insertion into a size-descending list — keeps the top `limit` without sorting
 *  (or even materialising) the whole selection. */
function insertBySize(top: SelectionPart<File>[], part: SelectionPart<File>, limit: number): void {
  if (top.length >= limit && part.size <= top[top.length - 1].size) return;
  let i = top.length;
  while (i > 0 && top[i - 1].size < part.size) i -= 1;
  top.splice(i, 0, part);
  if (top.length > limit) top.pop();
}

/** Read a folder/drop selection off a DataTransfer: recurse dropped FOLDERS via the
 *  FileSystem entry API when the browser supports it (Chrome/Edge), else take the flat
 *  file list. Browser-only glue (the pure normalization lives in uploadSelection). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = dt.items;
  const entries: FileSystemEntry[] = [];
  if (items !== undefined && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const getAsEntry = (item as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry;
      if (typeof getAsEntry === "function") {
        const entry = getAsEntry.call(item);
        if (entry !== null && entry !== undefined) entries.push(entry);
      }
    }
  }
  if (entries.length > 0) {
    const out: File[] = [];
    for (const entry of entries) await collectEntry(entry, out);
    return out;
  }
  return dt.files !== undefined ? Array.from(dt.files) : [];
}

async function collectEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File | null>((resolve) =>
      fileEntry.file((f) => resolve(f), () => resolve(null)),
    );
    if (file !== null) out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries((es) => resolve(es), () => resolve([])),
      );
      if (batch.length === 0) break;
      for (const child of batch) await collectEntry(child, out);
    }
  }
}

export function CreateDatasetWizard(props: CreateDatasetWizardProps): ReactElement {
  // D-xxviii: no collection-id field. Plotlas mints the id at create (seam L6) and the
  // response carries it; the user names the collection later, in the designer's Overview.
  // Images + .zip archives chosen via the file input, folder pick, and/or drag-drop.
  // Deduped by name+size on add (so a repeated pick doesn't accumulate); basename-deduped
  // for the actual parts by buildImageSelection.
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [headerFailed, setHeaderFailed] = useState(false);
  const [draft, setDraft] = useState<RolesDraft | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [freeTextColumns, setFreeTextColumns] = useState("");
  const [layoutTypes, setLayoutTypes] = useState<string[]>(["grid"]);
  const [phase, setPhase] = useState<Phase>("form");
  // Muted non-error notice (e.g. "resuming — sending only what's missing").
  const [notice, setNotice] = useState<string | null>(null);
  const [runStage, setRunStage] = useState<RunStage>("preparing");
  const [ignoredNote, setIgnoredNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [imageCount, setImageCount] = useState<number | null>(null);

  // Upload transport state: the live snapshot, the settled result (failures → review), and
  // the id of the session the parts land in.
  const [batch, setBatch] = useState<BatchSnapshot | null>(null);
  const [uploadResult, setUploadResult] = useState<BatchResult | null>(null);
  const [currentUploadId, setCurrentUploadId] = useState<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const lastSentPartsRef = useRef<SelectionPart<File>[]>([]);
  // The IDENTITY of the run in flight, or null when there is none. A ref, not state,
  // because it has to be current for the NEXT click in the same tick and a setState is
  // not. It does two jobs: it makes the submit path non-re-entrant (a second click during
  // the createUpload round trip used to mint a SECOND upload_id and overwrite the resume
  // anchor), and it is the back-out signal every await in the pre-transport path re-checks.
  //
  // An identity rather than a boolean, and that distinction is load-bearing. Cancel →
  // resubmit produces TWO runs whose continuations are both still scheduled, and a boolean
  // answers "is SOME run in flight?" when the question is "is MY run still the one?".
  // Measured against the boolean version: Upload → Cancel → Upload, then let the first
  // createUpload resolve, and the first run woke up inside the second run's lock and ran to
  // completion — two sessions uploaded, two finalized, and createDataset called twice with
  // the same dataset_id (a 409 on a live server), with saveUploadSession racing for the
  // resume anchor. Comparing tokens makes the superseded run return instead.
  const runTokenRef = useRef<object | null>(null);

  // Resume: a persisted open session found at mount, and the diff review before continuing.
  const [resumeSession, setResumeSession] = useState<PersistedUploadSession | null>(null);
  // The upload id a resume found ALREADY SEALED, so the banner can say what Resume will do
  // with it (create the collection) instead of "send only what's missing" — nothing is.
  // Known only once a resume has asked `listUploads`; compared against the CURRENT
  // `resumeSession`, so a discarded or replaced anchor never inherits it.
  const [sealedUploadId, setSealedUploadId] = useState<string | null>(null);
  const [resumeReview, setResumeReview] = useState<{ uploadId: string; plan: ResumePlan<File> } | null>(null);
  const [includeMismatched, setIncludeMismatched] = useState(false);

  // "Stop polling once the wizard unmounts" guard — StrictMode-robust (see jobPoll).
  const [guard] = useState(createUnmountGuard);
  useEffect(() => guard.onMount(), [guard]);
  // Seam O3: register the enqueued job with the global activity tracker.
  const { register: registerJob } = useActivityActions();

  // Rehydrate a persisted, interrupted upload session at mount → offer resume.
  useEffect(() => {
    const persisted = loadUploadSession();
    if (persisted !== null) setResumeSession(persisted);
  }, []);

  // Abort an in-flight upload if the wizard unmounts, so a closed wizard doesn't keep
  // uploading in the background and then finalize + create a dataset behind the user. The
  // persisted session is KEPT (resume covers it). Fires only on a real unmount: StrictMode's
  // dev mount→unmount→mount runs before any upload starts, so the ref is null then (no-op).
  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const availableTypes = useMemo(
    () => availableLayoutTypes(csvFile !== null ? draft : null),
    [csvFile, draft],
  );

  // Seam A2: the deployment's own upload ceilings, read ONCE at mount so the pre-flight
  // below enforces them instead of the compiled-in mirror. Fetched here rather than off
  // the createUpload response because the pre-flight runs on every selection change and
  // gates BOTH submit paths before any network call — and a successful resume never
  // opens a session at all. A failed/absent read leaves DEFAULT_UPLOAD_CAPS in place: it
  // must degrade, never block (the server is still the authority) — which is why that
  // fallback carries NO bundle-byte ceiling since seam L1, only the two caps the server
  // still compiles in. A fallback that invents the missing one blocks instead.
  const [uploadCaps, setUploadCaps] = useState<UploadCaps>(DEFAULT_UPLOAD_CAPS);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const served = await props.client.getUploadCaps();
        if (!cancelled) setUploadCaps(capsFromServer(served));
      } catch (err) {
        // Keep the defaults — an unreadable caps route must not stop an upload. But it
        // must not be SILENT either: this degradation is invisible in the UI, and since
        // the fallback stopped naming a bundle-byte ceiling it is invisible in the
        // pre-flight's answers too — nothing is refused, so nothing looks wrong until a
        // 413 arrives mid-transfer. The console line is the only way to tell "the caps
        // route is down" from "these are the caps".
        console.warn(
          "[uploads] caps read failed; pre-flighting against the compiled-in defaults (no bundle-byte ceiling — the server decides)",
          err,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.client]);

  // Selection derivations (pure): classify/dedupe the images zone, assemble the full part
  // list (images + zips + the one CSV), fingerprint it (resume match key), and pre-flight
  // the caps — all recomputed only when the inputs change.
  const selection = useMemo(() => buildImageSelection(imageFiles), [imageFiles]);
  const csvPart = useMemo<SelectionPart<File> | null>(
    () => (csvFile !== null ? { file: csvFile, name: csvFile.name, size: csvFile.size, isZip: false } : null),
    [csvFile],
  );
  const allParts = useMemo<SelectionPart<File>[]>(
    () => (csvPart !== null ? [...selection.parts, csvPart] : selection.parts),
    [selection, csvPart],
  );
  const fingerprint = useMemo(() => fingerprintFiles(allParts.map((p) => p.file)), [allParts]);
  const caps = useMemo(() => preflightCaps(allParts, uploadCaps), [allParts, uploadCaps]);
  const resumeMatches =
    resumeSession !== null && allParts.length > 0 && resumeSession.fingerprint === fingerprint;
  // The selection panel's bounded rows + byte total. Memoized on `selection` for the same
  // reason the derivations above are: the form re-renders on every keystroke in its text
  // fields, and an O(n) pass per keystroke over a six-figure selection is the cost this
  // seam's rider is measuring, not something to add to.
  const selectionView = useMemo(
    () => summarizeSelection(selection.parts, MAX_LISTED_PARTS),
    [selection],
  );

  function addFiles(incoming: File[]): void {
    if (incoming.length === 0) return;
    setImageFiles((prev) => {
      const seen = new Set(prev.map((f) => `${basenameOf(f)} ${f.size}`));
      const merged = [...prev];
      for (const f of incoming) {
        const key = `${basenameOf(f)} ${f.size}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(f);
        }
      }
      return merged;
    });
  }

  /** Drop ONE part from the selection. The only removal affordance used to be "Clear
   *  selection", which is not what the per-part cap error asks for — it says "Remove or
   *  shrink it", and removing was the one thing the screen could not do, so the user's
   *  only route was to discard a selection often assembled over several drops (`addFiles`
   *  is additive) and re-pick everything from the OS dialog.
   *
   *  Filters by File IDENTITY, not by name: if `buildImageSelection` dropped a
   *  same-basename file as a duplicate, removing the one it kept promotes that file into
   *  the selection rather than silently taking both. */
  function removePart(part: SelectionPart<File>): void {
    setImageFiles((prev) => prev.filter((f) => f !== part.file));
  }

  async function onCsvChosen(file: File | null): Promise<void> {
    setCsvFile(file);
    setHeaderFailed(false);
    setDraft(null);
    setSamples({});
    setLayoutTypes(["grid"]);
    if (file === null) return;
    // §0.5: parse the header CLIENT-SIDE from the local File — the server re-validates
    // the roles at ingest (D-11).
    const text = await file.text();
    const header = parseHeaderFor(file.name, text);
    if (header.length === 0) {
      setHeaderFailed(true);
      setDraft(emptyDraft([]));
      return;
    }
    setDraft(emptyDraft(header));
    setSamples(parseFirstRowFor(file.name, text));
  }

  function applyFreeTextColumns(value: string): void {
    setFreeTextColumns(value);
    const columns = value
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    setDraft(emptyDraft(columns));
  }

  function toggleLayoutType(type: string): void {
    setLayoutTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  function formProblem(): string | null {
    if (selection.parts.length === 0) return "Choose at least one image file, a folder, or a .zip archive.";
    if (csvFile !== null && draft !== null) return validateDraft(draft);
    return null;
  }

  /** Gate before the first byte: form validity, then the client-side caps pre-flight.
   *
   *  `!caps.ok` is a genuine refusal and stays a hard gate — but it is one only for a
   *  ceiling the deployment ACTUALLY STATED. That was not true between seam L1 and this
   *  fix: the fallback's invented 2 GiB reached here and blocked uploads the server would
   *  have taken. The fix is in `DEFAULT_UPLOAD_CAPS`, not in this line — a gate that
   *  ignores its own check would then let a REAL cap breach through to a mid-upload
   *  413. */
  function preSubmitProblem(): string | null {
    const problem = formProblem();
    if (problem !== null) return problem;
    if (!caps.ok) return caps.message;
    return null;
  }

  function resetForRun(): void {
    setError(null);
    setNotice(null);
    setIgnoredNote(null);
    setImageCount(null);
    setUploadResult(null);
    setPollError(null);
    setResumeReview(null);
    setBatch(null); // a previous run's settled bar must not narrate this one
  }

  /** Claim the run slot, returning the new run's identity — or `null` if one is already in
   *  flight, which is the whole of the double-submit guard. Every await before the
   *  transport re-checks the returned token with `isCurrentRun`. */
  function beginRun(): object | null {
    if (runTokenRef.current !== null) return null;
    const token = {};
    runTokenRef.current = token;
    return token;
  }

  /** Is `token` still the run in flight? False once it has been cancelled (slot cleared)
   *  OR superseded by a later run (slot holds a different token) — the two cases a boolean
   *  could not tell apart. */
  function isCurrentRun(token: object): boolean {
    return runTokenRef.current === token;
  }

  /** Release the run slot — but ONLY if `token` still owns it. Symmetric with `beginRun`,
   *  which is the point: release used to be a bare assignment that a call site could get
   *  wrong in either direction (forget it and the submit is dead for the rest of the
   *  session; do it from a superseded run and you hand the slot away from the run that
   *  replaced it). Neither mistake is reachable through this.
   *
   *  The slot is held exactly while an async chain is in flight, so it is released the
   *  moment a run comes to REST on an interactive surface — failure review, resume review,
   *  the job poller — and the actions on those surfaces claim it again like the submit
   *  does. That is what makes them non-re-entrant too. */
  function endRun(token: object): void {
    if (runTokenRef.current === token) runTokenRef.current = null;
  }

  /** The single way back to the form, and the one place that clears the slot WITHOUT a
   *  token: it is the user abandoning whatever is in flight, from the surface that owns
   *  it, so there is no other run whose claim could be stolen. It also clears `batch` —
   *  "a previous run's settled bar must not narrate this one" is the same kind of
   *  invariant as "the submit is reachable iff no run is in flight", and leaving it to
   *  each caller meant the failure-review Back button kept a stale snapshot alive. */
  function returnToForm(): void {
    runTokenRef.current = null;
    setRunStage("preparing");
    setPhase("form");
    setBatch(null);
    // Every notice narrates a RUN ("Resuming — …", "…starting a fresh upload", "Your
    // upload already finished — creating the collection from it."), and the run is over.
    // Left set, the form rendered it under the run's error: after a failed sealed-path
    // create it claimed the collection was still being created (review of PR #375,
    // finding 1).
    setNotice(null);
  }

  /** `token` identifies the run this failure belongs to: a superseded run's error must not
   *  act on the CURRENT run. `null` means the caller had no token to hand, and is treated
   *  as "act".
   *
   *  The token check sits ABOVE the 401 branch on purpose. `onAuthExpired` clears the
   *  session and routes to the auth screen, unmounting the wizard — the most destructive
   *  thing this function can do — so an abandoned run's late 401 arriving underneath it
   *  would kill a live replacement run's upload. A stale run's 401 tells us nothing the
   *  live run will not discover for itself on its own next call. */
  function handleRunError(err: unknown, token: object | null): void {
    if (token !== null && !isCurrentRun(token)) return;
    if (errStatus(err) === 401) {
      props.onAuthExpired();
      return;
    }
    // 413 cap breaches, 409 duplicates, 400s, 503 queue-down — the server's detail is the
    // message (brief §1.6).
    setError(errText(err));
    returnToForm();
  }

  /** Run the transport over `partsToSend`, then either report failures or finalize+create.
   *  `allSelected` is the full selection (for the finalize-time image count). `token` is
   *  the run this chain belongs to — it releases the slot wherever the chain comes to rest,
   *  so the buttons on that resting surface can claim it themselves. */
  async function runUpload(
    uploadId: string,
    partsToSend: SelectionPart<File>[],
    allSelected: SelectionPart<File>[],
    token: object,
  ): Promise<void> {
    setCurrentUploadId(uploadId);
    lastSentPartsRef.current = partsToSend;
    setUploadResult(null);
    setBatch(null);
    setRunStage("transferring");
    setPhase("uploading");
    // Nothing to send (a resume where the server already holds everything) → finalize now.
    if (partsToSend.length === 0) {
      await finishUpload(uploadId, allSelected, token);
      return;
    }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const result = await runUploadBatch(
      partsToSend,
      (part, onProgress, signal) =>
        props.client.uploadPartWithProgress(uploadId, part.file, onProgress, signal),
      { onProgress: setBatch, signal: controller.signal },
    );
    if (controller.signal.aborted) return; // cancelled — the canceller owns the transition
    setUploadResult(result);
    if (result.ignored.length > 0) {
      setIgnoredNote(`Skipped from archives: ${result.ignored.join(", ")}`);
    }
    if (result.failures.length > 0) {
      // At rest in failure review. Release the slot so Retry / Continue anyway can CLAIM
      // it — that claim is what makes them non-re-entrant, rather than relying on the
      // re-render that hides them, which a double click in one tick outruns.
      endRun(token);
      return;
    }
    await finishUpload(uploadId, allSelected, token);
  }

  /** Finalize the bundle, read the authoritative image count, then enqueue ingest + poll. */
  async function finishUpload(
    uploadId: string,
    allSelected: SelectionPart<File>[],
    token: object,
  ): Promise<void> {
    // Past this line the bundle is being sealed and nothing here is abortable — see
    // RUN_STAGE_NO_CANCEL. The stage is what the uploading view narrates for the whole
    // window, alongside (not instead of) the settled progress bar.
    setRunStage("sealing");
    await props.client.finalizeUpload(uploadId);
    await createFromSealedUpload(uploadId, allSelected, token);
  }

  /** The half of a run that comes after the bundle is sealed: read the authoritative image
   *  count, create the collection from `uploadId` (or adopt the one it already backs), and
   *  poll its job. Shared by `finishUpload`, which has just sealed the bundle, and by a
   *  resume that finds the bundle ALREADY sealed — an earlier run finalized it and then
   *  lost, or never got, its create's answer
   *  (T2-resuming-a-sealed-upload-starts-a-fresh-one-so). The request is built here from the
   *  CURRENT form in both cases, so a resume sends exactly what a fresh run would. */
  async function createFromSealedUpload(
    uploadId: string,
    allSelected: SelectionPart<File>[],
    token: object,
  ): Promise<void> {
    // Images detected = the server's finalized part tally minus the one metadata CSV.
    // Honest server-side figure — accurate for a .zip (its extracted entries are counted),
    // unlike the local selection length. Falls back to the plain-part count if the status
    // read fails (non-fatal).
    let received = allSelected.filter((p) => !p.isZip).length;
    try {
      received = (await props.client.getUploadStatus(uploadId)).received_parts;
    } catch {
      // keep the fallback
    }
    setImageCount(Math.max(0, received - (csvFile !== null ? 1 : 0)));
    setRunStage("enqueueing");
    // D-xxviii: no `dataset_id` — the API mints one (seam L6) and returns it, and that
    // returned id is the only one used from here on.
    let created: { dataset_id: string; job_id: string | null };
    try {
      created = await props.client.createDataset({
        upload_id: uploadId,
        column_roles: csvFile !== null && draft !== null ? buildColumnRoles(draft) : undefined,
        // D-xvii: the other half of the same draft. `buildPresentation` returns {} when
        // nothing is marked, and an empty object is still "nothing to record" server-side
        // (every key unset), so this needs no conditional of its own beyond the CSV.
        presentation: csvFile !== null && draft !== null ? buildPresentation(draft) : undefined,
        // Drop any type whose unlocking role was removed after it was checked.
        layout_types: layoutTypes.filter((t) => availableTypes.includes(t)),
      });
    } catch (err) {
      // This upload already backs one of the user's collections: an earlier create from
      // it succeeded and its answer never arrived here (a lost response, a second tab).
      // ADOPT that collection and its job — carry on exactly as if this create had
      // returned them — rather than report a failure for work that exists
      // (T2-a-minted-create-is-not-idempotent-so-a-retried). Every other error is thrown
      // on to the run's error handling, unchanged.
      const adopted = uploadAlreadyCreated(err);
      if (adopted === null) throw err;
      created = { dataset_id: adopted.dataset_id, job_id: adopted.job_id };
    }
    // The bundle is finalized + ingesting — the resume session is consumed; clear it.
    clearUploadSession();
    setResumeSession(null);
    if (created.job_id === null) {
      // Adopted a collection with no job to follow: the API names the job only while it
      // is queued or started, so its bake already finished, failed, or aged out of RQ.
      // Polling would answer 404 or re-report an old failure. The collection exists, so
      // SAY that nothing new was created and where it is, then let the user go — landing
      // on the Library silently left them to wonder where their upload went (review of
      // PR #373, operator finding 2).
      setPhase("adopted");
      endRun(token);
      return;
    }
    setJobId(created.job_id);
    registerJob(created.dataset_id, created.job_id); // Seam O3: track it globally, by the id the API returned
    setPhase("polling");
    endRun(token); // at rest in the job poller; nothing left to guard
    try {
      await pollJob(props.client, created.job_id, setJobStatus, {
        isCancelled: () => guard.isCancelled(),
      });
    } catch (pollErr) {
      setPollError(errText(pollErr));
    }
  }

  /** Open a fresh upload session, persist it as the resume anchor, and send everything.
   *  The shared core of a first upload and the expired-session resume fallback. Throws on
   *  a network/API failure — callers wrap it in handleRunError. */
  async function startFreshSession(token: object): Promise<void> {
    setResumeSession(null);
    const session = await props.client.createUpload();
    // Cancelled or superseded during the round trip: write NOTHING and stop. The session
    // exists server-side either way, but an anchor for it would be a false offer — Cancel
    // at `preparing` is by construction before the first part, so "Resume upload" would
    // re-send everything into an empty session; and this function has already cleared
    // `resumeSession`, so the offer could not even appear until a reload. A superseded run
    // writing the anchor is worse still: it would point resume at a session nobody is
    // filling, over the top of the live run's own. An unused session costs nothing until
    // the 7-day sweep.
    if (!isCurrentRun(token)) return;
    saveUploadSession({
      uploadId: session.upload_id,
      fingerprint,
      // What is being uploaded, so a resume banner can say so (seam L3 — there is no id
      // to name yet: it is minted at create, after the upload).
      fileCount: allParts.length,
      totalBytes: allParts.reduce((sum, p) => sum + p.size, 0),
    });
    await runUpload(session.upload_id, allParts, allParts, token);
  }

  /** Fresh upload: open a session, persist it (resume anchor), send everything. */
  async function beginFresh(): Promise<void> {
    const problem = preSubmitProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    const token = beginRun();
    if (token === null) return; // a run is in flight — never open a second session
    // The transition is driven by the CLICK, not by the response. setPhase used to be the
    // fourth statement of runUpload, i.e. after the createUpload round trip, so the form
    // sat unchanged with a live button for the whole request — the reported "page seems to
    // hang", and the window in which a second click minted a second upload session.
    resetForRun();
    setRunStage("preparing");
    setPhase("uploading");
    try {
      await startFreshSession(token);
    } catch (err) {
      handleRunError(err, token);
    }
  }

  /** Resume the persisted session. `listUploads` decides which of three cases this is:
   *   - OPEN: diff the re-selected files against it (/check) and send only what the server
   *     lacks, then seal and create as a fresh run does;
   *   - already SEALED (`finalized`): send nothing, and create from that same upload
   *     (`createFromSealedUpload`) — a 200 is a normal create, the
   *     `upload_already_created` 409 is adopted;
   *   - GONE (expired / swept): start a fresh session. */
  async function beginResume(): Promise<void> {
    const problem = preSubmitProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (resumeSession === null) {
      void beginFresh(); // claims the run slot itself
      return;
    }
    const token = beginRun();
    if (token === null) return; // a run is in flight — same guard as beginFresh
    resetForRun();
    setRunStage("checking");
    setPhase("uploading");
    try {
      const sessions = await props.client.listUploads();
      if (!isCurrentRun(token)) return; // cancelled or superseded during the check
      const found = sessions.find((s) => s.upload_id === resumeSession.uploadId);
      if (found !== undefined && found.state === "finalized") {
        // ALREADY SEALED: every byte is on the server and the bundle is finalized, so an
        // earlier run got past `finalizeUpload` and then lost — or never received — its
        // create's answer. Re-uploading would make a NEW upload id, which the API's
        // per-upload 409 cannot recognise, so a lost-response retry would build a second
        // collection (T2-resuming-a-sealed-upload-starts-a-fresh-one-so). Instead create
        // from THIS upload: a create that never happened now happens, and one that did
        // answers `upload_already_created`, which `createFromSealedUpload` adopts. No
        // /check and no parts: there is nothing left to send. The anchor is kept until the
        // create succeeds or is adopted, so a failure here can be resumed the same way —
        // and the banner then says so (`sealedUploadId`), not "send only what's missing".
        setSealedUploadId(resumeSession.uploadId);
        setNotice("Your upload already finished — creating the collection from it.");
        // The stage is what hides Cancel for the whole create, the status read included:
        // `enqueueing` is in RUN_STAGE_NO_CANCEL. Left on `checking`, the screen offered
        // Cancel while the create below was still going to be sent.
        setRunStage("enqueueing");
        await createFromSealedUpload(resumeSession.uploadId, allParts, token);
        return;
      }
      if (found === undefined || found.state !== "open") {
        // Expired / swept — start clean (the server sweeps stale sessions anyway; this is
        // best-effort discovery, not a guarantee). Clear the dead pointer eagerly;
        // startFreshSession then opens + persists a new one.
        clearUploadSession();
        setNotice("Your previous upload could not be resumed (it expired) — starting a fresh upload.");
        // The stage has to move with the notice: leaving it on `checking` put "…starting a
        // fresh upload" and "Checking your previous upload…" on screen together for the
        // whole createUpload round trip, which is the narration bug this seam exists to fix.
        setRunStage("preparing");
        await startFreshSession(token);
        return;
      }
      const uploadId = resumeSession.uploadId;
      // `planResume` is ONE await wrapping a serial loop of up to
      // parts.length / UPLOAD_CHECK_BATCH round trips — 100 of them at MAX_UPLOAD_ENTRIES
      // = 1 000 000 parts. Checking the token after it returns would mean Cancel on batch
      // 2 still let ~98 POSTs fire while the screen said the run was over. It takes its
      // client as a structural `UploadCheckClient`, so the token check goes INSIDE the
      // loop by wrapping the one method it calls: the run stops at the next batch boundary
      // instead of the last one. (Genuine cancellation of the request in flight needs a
      // signal parameter on `checkUploadFiles`, which is transport-owned — see
      // `backlog/T2-the-resume-pre-check-is-a-serial-round-trip.md`.)
      const plan = await planResume(
        {
          checkUploadFiles: async (id, files) => {
            if (!isCurrentRun(token)) throw new RunAbandoned();
            return props.client.checkUploadFiles(id, files);
          },
        },
        uploadId,
        allParts,
      );
      if (!isCurrentRun(token)) return; // cancelled or superseded during the /check diff
      if (plan.mismatched.length > 0) {
        // Same-name-different-content files need a user decision (default: skip, keep the
        // server's copy) before continuing. At rest — release the slot so the review's
        // Continue can claim it.
        setResumeReview({ uploadId, plan });
        setIncludeMismatched(false);
        setPhase("resume-review");
        endRun(token);
        return;
      }
      setNotice(
        `Resuming — ${plan.present.length.toLocaleString()} file(s) already uploaded, sending ${plan.needed.length.toLocaleString()}.`,
      );
      await runUpload(uploadId, plan.needed, allParts, token);
    } catch (err) {
      if (err instanceof RunAbandoned) return; // the canceller already owns the transition
      handleRunError(err, token);
    }
  }

  /** Continue a resume from the mismatch review: send `needed` (+ mismatched if opted in). */
  async function continueResume(): Promise<void> {
    if (resumeReview === null) return;
    // The chain that put us on this surface RELEASED the slot when it came to rest here,
    // so these three continuations claim it exactly like the submit does. That claim — not
    // the re-render that hides the button — is what makes them non-re-entrant: two clicks
    // in one tick see the same un-re-rendered DOM and the same state, and only the slot
    // can tell them apart. Without it, two "Continue anyway" clicks finalize twice and
    // call createDataset twice with the same dataset_id.
    const token = beginRun();
    if (token === null) return;
    const { uploadId, plan } = resumeReview;
    const toSend = includeMismatched ? [...plan.needed, ...plan.mismatched] : plan.needed;
    setResumeReview(null);
    try {
      await runUpload(uploadId, toSend, allParts, token);
    } catch (err) {
      handleRunError(err, token);
    }
  }

  /** Retry only the parts that failed terminally in the last run. */
  async function retryFailed(): Promise<void> {
    if (currentUploadId === null || uploadResult === null) return;
    // `uploadResult` is NOT a re-entrancy guard: `runUpload` clears it with setUploadResult
    // and a setState cannot land between two dispatches in the same tick, so a double click
    // used to start two transports on one upload_id — the second overwriting
    // uploadAbortRef and orphaning the first's controller. The slot claim is the guard.
    const token = beginRun();
    if (token === null) return;
    const failedNames = new Set(uploadResult.failures.map((f) => f.name));
    const failedParts = lastSentPartsRef.current.filter((p) => failedNames.has(p.name));
    try {
      await runUpload(currentUploadId, failedParts, allParts, token);
    } catch (err) {
      handleRunError(err, token);
    }
  }

  /** Finalize + ingest despite terminal failures (the dataset will lack those images). */
  async function continueAnyway(): Promise<void> {
    if (currentUploadId === null) return;
    const token = beginRun();
    if (token === null) return;
    try {
      await finishUpload(currentUploadId, allParts, token);
    } catch (err) {
      handleRunError(err, token);
    }
  }

  /** Back out of a run that has not been sealed yet. Two mechanisms, because there are two
   *  kinds of in-flight work: the transport is stopped through its AbortController, and the
   *  pre-transport path (createUpload / listUploads / the chunked /check) is stopped by
   *  releasing the run lock, which every await in that path re-checks before continuing.
   *
   *  The persisted session is KEPT either way, so the user resumes into it rather than
   *  stranding it. Offered only at the stages RUN_STAGE_NO_CANCEL does not name — past
   *  `finalizeUpload` neither mechanism reaches anything. */
  function cancelUpload(): void {
    uploadAbortRef.current?.abort();
    returnToForm();
    setBatch(null);
  }

  /** Discard a persisted, interrupted session (best-effort — the server sweeps stale
   *  sessions anyway; this just clears the local resume offer). */
  function discardResume(): void {
    clearUploadSession();
    setResumeSession(null);
    setNotice(null);
  }

  const hasMetadata = csvFile !== null;
  const formStage: "source" | "roles" = hasMetadata && draft !== null ? "roles" : "source";
  const jobTerminal =
    phase === "adopted" ||
    (jobStatus !== null && ["finished", "failed", "stopped", "canceled"].includes(jobStatus.state));
  // Extended phases collapse onto the rail's three-value phase (resume-review/uploading →
  // "uploading": source captured, Progress carries the flow; adopted → a settled "polling").
  const railPhase: "form" | "uploading" | "polling" =
    phase === "form" ? "form" : phase === "polling" || phase === "adopted" ? "polling" : "uploading";
  const rail = h(StepRail, {
    states: stepStates({ phase: railPhase, hasMetadata, formStage, jobTerminal }),
  });

  // ---- Adopted, with no job to follow — say why nothing new was created -----
  if (phase === "adopted") {
    return h(
      "div",
      { className: "wizard" },
      rail,
      h("p", { className: "muted", role: "status" }, ADOPTED_WITHOUT_JOB_NOTICE),
      h(
        "button",
        { type: "button", className: "btn pri", onClick: () => props.onDone() },
        "Back to Library",
      ),
    );
  }

  // ---- Progress (polling) view — unchanged flow -----------------------------
  if (phase === "polling" && jobId !== null) {
    return h(
      "div",
      { className: "wizard" },
      rail,
      h(JobProgressView, { jobId, status: jobStatus, pollError, imageCount }),
      jobTerminal || pollError !== null
        ? h(
            "button",
            { type: "button", className: "btn pri", onClick: () => props.onDone() },
            "Back to Library",
          )
        : h("p", { className: "muted" }, "You can keep this open — polling backs off to every 10 s."),
    );
  }

  // ---- Uploading view — narration + live byte progress, then finalize OR failure review
  if (phase === "uploading") {
    const failures = uploadResult?.failures ?? [];
    const settledWithFailures = uploadResult !== null && failures.length > 0;
    const noCancelReason = RUN_STAGE_NO_CANCEL[runStage];
    return h(
      "div",
      { className: "wizard" },
      rail,
      notice !== null ? h("p", { className: "muted" }, notice) : null,
      // The narration and the bar are ADDITIVE, never alternatives. Rendering them as a
      // ternary on `batch !== null` made the whole finalize window silent: `batch` is
      // non-null from the transport's first emit and is never cleared, so a settled run
      // showed a frozen 100 % bar and nothing else while the server sealed the bundle.
      // The live region is mounted for the whole phase (it is empty while the bar carries
      // the numbers) so a stage change is a text change inside an existing region, which
      // is the form screen readers actually announce.
      //
      // The "no longer be cancelled" line lives INSIDE it for exactly that reason. It was
      // its own `role="status"` paragraph down in the control slot, i.e. a live region
      // inserted with its text already present — the pattern the paragraph above says is
      // not announced. It is narration, so it belongs with the narration; the control slot
      // then correctly holds nothing, because there is nothing to press.
      h(
        "div",
        { className: "wizard-run-note", role: "status", "aria-live": "polite" },
        RUN_STAGE_NOTE[runStage] !== ""
          ? h("p", { className: "muted wizard-run-line" }, RUN_STAGE_NOTE[runStage])
          : null,
        noCancelReason !== undefined
          ? h("p", { className: "muted wizard-run-line" }, noCancelReason)
          : null,
      ),
      batch !== null ? h(UploadProgressView, { snapshot: batch, failures }) : null,
      ignoredNote !== null ? h("p", { className: "muted" }, ignoredNote) : null,
      error !== null ? h("p", { className: "error-text", role: "alert" }, error) : null,
      // The failure-review actions belong to the SETTLED run, not to the one "Continue
      // anyway" then starts: `uploadResult` still holds the failures while finishUpload
      // runs, so leaving them up offered a Retry that would re-enter the transport
      // alongside an in-flight finalize. Once the bundle is being sealed the honest line
      // below takes the slot, exactly as it does on the clean path.
      settledWithFailures && noCancelReason === undefined
        ? h(
            "div",
            { className: "wizard-actions" },
            h(
              "button",
              { type: "button", className: "btn pri", onClick: () => void retryFailed() },
              `Retry ${failures.length} failed`,
            ),
            h(
              "button",
              { type: "button", className: "btn ghost", onClick: () => void continueAnyway() },
              "Continue anyway",
            ),
            h(
              "button",
              { type: "button", className: "link-btn", onClick: () => returnToForm() },
              "Back",
            ),
          )
        : // A Cancel while one can honestly be offered, and nothing once the bundle is
          // being sealed — where "nothing" is a control slot, not a silent screen: the
          // narration above carries both the stage and the reason there is nothing here.
          noCancelReason !== undefined
          ? null
          : h(
              "div",
              { className: "wizard-actions" },
              h("button", { type: "button", className: "btn ghost", onClick: () => cancelUpload() }, "Cancel"),
            ),
    );
  }

  // ---- Resume review — the /check diff before continuing --------------------
  if (phase === "resume-review" && resumeReview !== null) {
    const { plan } = resumeReview;
    return h(
      "div",
      { className: "wizard" },
      rail,
      h(
        "section",
        { className: "wizard-step", "aria-label": "Resume upload" },
        h("h4", { className: "wizard-step-title" }, "Resume upload"),
        h(
          "p",
          { className: "muted" },
          `${plan.present.length.toLocaleString()} already uploaded · ${plan.needed.length.toLocaleString()} to send · ${plan.mismatched.length.toLocaleString()} changed.`,
        ),
        h(
          "div",
          { className: "resume-mismatch" },
          h(
            "p",
            { className: "error-text" },
            `${plan.mismatched.length} file(s) share a name with a DIFFERENT file already uploaded. By default they are skipped (the server keeps its copy).`,
          ),
          h(
            "ul",
            { className: "resume-mismatch-rows" },
            plan.mismatched.slice(0, 20).map((p) =>
              h("li", { key: p.name, className: "resume-mismatch-name" }, p.name),
            ),
          ),
          h(
            "label",
            { className: "checkbox-label" },
            h("input", {
              type: "checkbox",
              checked: includeMismatched,
              onChange: () => setIncludeMismatched((v) => !v),
            }),
            "Try to re-send them anyway (they may be rejected as name conflicts — rename them if so)",
          ),
        ),
      ),
      h(
        "div",
        { className: "wizard-actions" },
        h(
          "button",
          { type: "button", className: "btn pri", onClick: () => void continueResume() },
          "Continue",
        ),
        h(
          "button",
          {
            type: "button",
            className: "btn ghost",
            onClick: () => {
              setResumeReview(null);
              returnToForm();
            },
          },
          "Cancel",
        ),
      ),
    );
  }

  // ---- Step 1: Source — file input, folder pick, drag-drop, optional CSV -----
  const selectedCount = selection.parts.length;
  const selectionNotes: string[] = [];
  if (selection.droppedDuplicates.length > 0) {
    selectionNotes.push(
      `Skipped ${selection.droppedDuplicates.length} duplicate name(s): ${selection.droppedDuplicates.slice(0, 8).join(", ")}${selection.droppedDuplicates.length > 8 ? "…" : ""}`,
    );
  }
  if (selection.ignored.length > 0) {
    selectionNotes.push(
      `Ignored ${selection.ignored.length} non-image file(s): ${selection.ignored.slice(0, 8).join(", ")}${selection.ignored.length > 8 ? "…" : ""}`,
    );
  }

  // What you actually selected, and a way to drop one piece of it. Previously the screen
  // drew only a count and the aggregate notes, and the only removal was "Clear selection"
  // — which discards a selection `addFiles` let you assemble over several drops, and is
  // not what the per-part cap error asks for ("Remove or shrink it"). The row count is
  // bounded by MAX_LISTED_PARTS and never by the corpus; see `summarizeSelection` for why
  // archives and the largest files are the ones worth a row.
  // The panel appears whenever the user has picked ANYTHING — not only when something
  // survived classification. Gating the whole thing on `selectedCount > 0` (the notes used
  // to have their own `selectionNotes.length > 0` gate) made the Source step render
  // literally nothing for a folder of .heic/.raw/.mp4: every file ignored, no parts, so no
  // note saying they were ignored and no way to clear them. A silent screen, one step
  // earlier than the one this seam was written to fix.
  const selectionPanel =
    selectedCount > 0 || selectionNotes.length > 0
      ? h(
          "div",
          { className: "selection-panel" },
          selectedCount > 0
            ? h(
                "p",
                { className: "muted selection-summary" },
                // Named for exactly the set it sums. It is NOT the bundle figure the cap
                // checks: `preflightCaps` counts only non-zip parts (a .zip's uncompressed
                // size is unknowable client-side, D-27) and this counts every part, and
                // neither includes the metadata CSV. Two honest numbers measuring different
                // things — so this one says which.
                `Images and archives: ${selectedCount.toLocaleString()} file(s) · ${formatBytes(selectionView.totalBytes)}`,
              )
            : null,
          selectionNotes.length > 0
            ? h(
                "div",
                { className: "selection-notes" },
                selectionNotes.map((note, i) => h("p", { key: i, className: "muted selection-note" }, note)),
              )
            : null,
          h(
            "ul",
            { className: "selection-rows", "aria-label": "Selected files" },
            selectionView.rows.map((part) =>
              h(
                "li",
                { key: part.name, className: "selection-row" },
                h("span", { className: "selection-row-name" }, part.name),
                h("span", { className: "selection-row-size" }, formatBytes(part.size)),
                h(
                  "button",
                  {
                    type: "button",
                    className: "link-btn selection-remove",
                    // The glyph is the affordance the operator asked for ("To X it out");
                    // the accessible name says which file, so a screen reader and a
                    // by-name query both resolve one row rather than twelve identical ✕.
                    "aria-label": `Remove ${part.name}`,
                    title: `Remove ${part.name}`,
                    onClick: () => removePart(part),
                  },
                  "✕",
                ),
              ),
            ),
          ),
          selectionView.hidden > 0
            ? h(
                "p",
                { className: "muted selection-note" },
                `…and ${selectionView.hidden.toLocaleString()} more not listed — the largest are listed first.`,
              )
            : null,
          h(
            "button",
            { type: "button", className: "link-btn", onClick: () => setImageFiles([]) },
            "Clear selection",
          ),
        )
      : null;

  const sourceStep = h(
    "section",
    { className: "wizard-step", "aria-label": "Source" },
    h("h4", { className: "wizard-step-title" }, "Source"),
    h(
      "label",
      {
        className: dragActive ? "dropzone dropzone-active" : "dropzone",
        onDragOver: (e: { preventDefault(): void }) => {
          e.preventDefault();
          setDragActive(true);
        },
        onDragLeave: () => setDragActive(false),
        onDrop: (e: { preventDefault(): void; dataTransfer: DataTransfer }) => {
          e.preventDefault();
          setDragActive(false);
          void filesFromDrop(e.dataTransfer).then(addFiles);
        },
      },
      h("span", { className: "dropzone-title" }, "Images"),
      h(
        "span",
        { className: "dropzone-hint muted" },
        "Drop files or a folder here, or select files / one .zip archive",
      ),
      h("input", {
        type: "file",
        multiple: true,
        accept: "image/*,.zip",
        "aria-label": "Select image files",
        onChange: (e: { target: HTMLInputElement }) => {
          const input = e.target;
          addFiles(input.files === null ? [] : Array.from(input.files));
          // Clear the control so re-picking the SAME file fires `change` again. Now that a
          // file can be removed one at a time, "remove it, then change your mind" is a real
          // sequence, and an input still holding that file would emit nothing on re-pick.
          input.value = "";
        },
      }),
      selectedCount > 0
        ? h("span", { className: "detected-count" }, `${selectedCount} file(s) selected`)
        : null,
    ),
    // Folder pick (webkitdirectory set via ref — the attribute is not in React's typings).
    h(
      "label",
      { className: "dropzone dropzone-folder" },
      h("span", { className: "dropzone-title" }, "…or a folder"),
      h("span", { className: "dropzone-hint muted" }, "Selects every image in the folder (flattened by filename)"),
      h("input", {
        type: "file",
        multiple: true,
        "aria-label": "Select a folder of images",
        ref: (el: HTMLInputElement | null) => {
          if (el !== null) {
            el.setAttribute("webkitdirectory", "");
            el.setAttribute("directory", "");
          }
        },
        onChange: (e: { target: HTMLInputElement }) => {
          const input = e.target;
          addFiles(input.files === null ? [] : Array.from(input.files));
          input.value = ""; // same re-pick reason as the images input above
        },
      }),
    ),
    selectionPanel,
    h(
      "label",
      { className: "dropzone" },
      h("span", { className: "dropzone-title" }, "Metadata CSV/TSV"),
      h("span", { className: "dropzone-hint muted" }, "Optional — images alone are a complete dataset"),
      h("input", {
        type: "file",
        accept: ".csv,.tsv",
        "aria-label": "Select a metadata CSV or TSV",
        onChange: (e: { target: HTMLInputElement }) => {
          const input = e.target;
          void onCsvChosen(input.files === null ? null : (input.files[0] ?? null));
          input.value = "";
        },
      }),
      csvFile !== null ? h("span", { className: "detected-count" }, `${csvFile.name} selected`) : null,
    ),
    // Removing the CSV counts as a removal too — nothing offered to take it back out.
    // OUTSIDE the label on purpose: a control nested in a <label> is a click target for
    // the label's own file input.
    csvFile !== null
      ? h(
          "button",
          { type: "button", className: "link-btn", onClick: () => void onCsvChosen(null) },
          `Remove ${csvFile.name}`,
        )
      : null,
  );

  // ---- Step 2: Map roles — unchanged ----------------------------------------
  const rolesStep =
    headerFailed
      ? h(
          "section",
          { className: "wizard-step", "aria-label": "Map roles" },
          h("h4", { className: "wizard-step-title" }, "Map roles"),
          h(
            "label",
            { className: "field" },
            h("span", null, "Could not parse the CSV header — enter column names (comma-separated)"),
            h("input", {
              value: freeTextColumns,
              placeholder: "filename, date, category, tags",
              onChange: (e: { target: { value: string } }) => applyFreeTextColumns(e.target.value),
            }),
          ),
          draft !== null && draft.columns.length > 0
            ? h(RoleAssignmentForm, { draft, onChange: setDraft, samples, unlocks: availableTypes })
            : null,
        )
      : csvFile !== null && draft !== null && draft.columns.length > 0
        ? h(
            "section",
            { className: "wizard-step", "aria-label": "Map roles" },
            h("h4", { className: "wizard-step-title" }, "Map roles"),
            h(RoleAssignmentForm, { draft, onChange: setDraft, samples, unlocks: availableTypes }),
          )
        : null;

  // ---- Layouts selector (grid is the unconditional floor, D-25) -------------
  const layoutsBlock = h(
    "div",
    { className: "field" },
    h("span", null, "Layouts"),
    h(
      "div",
      { className: "layout-checkboxes" },
      availableTypes.map((type) =>
        h(
          "label",
          { key: type, className: "checkbox-label" },
          h("input", {
            type: "checkbox",
            checked: type === "grid" || layoutTypes.includes(type),
            disabled: type === "grid",
            onChange: () => toggleLayoutType(type),
          }),
          type,
        ),
      ),
    ),
  );

  // ---- Resume banner (a persisted, interrupted session was found) -----------
  // Worded around WHAT was uploaded (seam L3): there is no collection id at this point —
  // it is minted at create, after the upload finishes.
  const interrupted =
    resumeSession !== null
      ? (() => {
          const what = describeUploadSession(resumeSession, formatBytes);
          return what !== null ? `An interrupted upload (${what}) was found` : "An interrupted upload was found";
        })()
      : "";
  const resumeBanner =
    resumeSession !== null
      ? h(
          "div",
          { className: "resume-banner panel-float", role: "status" },
          h(
            "span",
            { className: "resume-banner-text" },
            resumeMatches
              ? resumeSession.uploadId === sealedUploadId
                ? `${interrupted} — it is complete. Click "Resume upload" to create the collection from it.`
                : `${interrupted} — the same files are selected. Click "Resume upload" to send only what's missing.`
              : selectedCount > 0
                ? `${interrupted}, but the selected files differ — "Upload & create" will start fresh.`
                : `${interrupted}. Re-select the same files (or folder) to resume.`,
          ),
          h(
            "button",
            { type: "button", className: "link-btn", onClick: () => discardResume() },
            "Discard",
          ),
        )
      : null;

  return h(
    "div",
    { className: "wizard" },
    rail,
    resumeBanner,
    sourceStep,
    rolesStep,
    layoutsBlock,
    error !== null ? h("p", { className: "error-text", role: "alert" }, error) : null,
    !caps.ok && selectedCount > 0
      ? h("p", { className: "error-text", role: "alert" }, caps.message)
      : null,
    notice !== null ? h("p", { className: "muted" }, notice) : null,
    ignoredNote !== null ? h("p", { className: "muted" }, ignoredNote) : null,
    resumeMatches
      ? h(
          "button",
          { type: "button", className: "btn pri", onClick: () => void beginResume() },
          "Resume upload",
        )
      : h(
          "button",
          { type: "button", className: "btn pri", onClick: () => void beginFresh() },
          "Upload & create",
        ),
  );
}
