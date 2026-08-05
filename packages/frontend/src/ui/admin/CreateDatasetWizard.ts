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
import type { JobStatus } from "../../api-client/types";
import { parseFirstRowFor, parseHeaderFor } from "./csvHeader";
import { availableLayoutTypes, buildColumnRoles, emptyDraft, validateDraft } from "./roles";
import type { RolesDraft } from "./roles";
import { RoleAssignmentForm } from "./RoleAssignmentForm";
import { JobProgressView } from "./JobProgress";
import { StepRail, stepStates } from "./stepRail";
import { createUnmountGuard, pollJob } from "./jobPoll";
import { useActivityActions } from "../activity/activityContext";
import {
  basenameOf,
  buildImageSelection,
  fingerprintFiles,
  preflightCaps,
} from "./uploadSelection";
import type { SelectionPart } from "./uploadSelection";
import { planResume, runUploadBatch } from "./uploadTransport";
import type { BatchResult, BatchSnapshot, ResumePlan } from "./uploadTransport";
import {
  clearUploadSession,
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

const DATASET_ID_RE = /^[A-Za-z0-9._-]+$/;

// form: the source/roles/layouts inputs · resume-review: the diff of a re-selected bundle
// against a persisted session · uploading: the transport is running (or settled with
// failures to review) · polling: the enqueued ingest job. resume-review/uploading both map
// to the rail's "uploading" step (source captured, progress carrying the flow).
type Phase = "form" | "resume-review" | "uploading" | "polling";

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
  const [datasetId, setDatasetId] = useState("");
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
  const [statusNote, setStatusNote] = useState<string | null>(null); // Checking… / Finalizing…
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

  // Resume: a persisted open session found at mount, and the diff review before continuing.
  const [resumeSession, setResumeSession] = useState<PersistedUploadSession | null>(null);
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
  const caps = useMemo(() => preflightCaps(allParts), [allParts]);
  const resumeMatches =
    resumeSession !== null && allParts.length > 0 && resumeSession.fingerprint === fingerprint;

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
    if (!DATASET_ID_RE.test(datasetId)) {
      return "Dataset id must be non-empty and use only letters, digits, '.', '_' or '-'.";
    }
    if (selection.parts.length === 0) return "Choose at least one image file, a folder, or a .zip archive.";
    if (csvFile !== null && draft !== null) return validateDraft(draft);
    return null;
  }

  /** Gate before the first byte: form validity, then the client-side caps pre-flight. */
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
  }

  function handleRunError(err: unknown): void {
    if (errStatus(err) === 401) {
      props.onAuthExpired();
      return;
    }
    // 413 cap breaches, 409 duplicates, 400s, 503 queue-down — the server's detail is the
    // message (brief §1.6).
    setError(errText(err));
    setPhase("form");
    setStatusNote(null);
    setBatch(null);
  }

  /** Run the transport over `partsToSend`, then either report failures or finalize+create.
   *  `allSelected` is the full selection (for the finalize-time image count). */
  async function runUpload(
    uploadId: string,
    partsToSend: SelectionPart<File>[],
    allSelected: SelectionPart<File>[],
  ): Promise<void> {
    setCurrentUploadId(uploadId);
    lastSentPartsRef.current = partsToSend;
    setUploadResult(null);
    setBatch(null);
    setStatusNote(null);
    setPhase("uploading");
    // Nothing to send (a resume where the server already holds everything) → finalize now.
    if (partsToSend.length === 0) {
      await finishUpload(uploadId, allSelected);
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
    if (result.failures.length > 0) return; // stay put; the failure-review actions render
    await finishUpload(uploadId, allSelected);
  }

  /** Finalize the bundle, read the authoritative image count, then enqueue ingest + poll. */
  async function finishUpload(uploadId: string, allSelected: SelectionPart<File>[]): Promise<void> {
    setStatusNote("Finalizing upload…");
    await props.client.finalizeUpload(uploadId);
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
    setStatusNote("Starting ingest…");
    const created = await props.client.createDataset({
      dataset_id: datasetId,
      upload_id: uploadId,
      column_roles: csvFile !== null && draft !== null ? buildColumnRoles(draft) : undefined,
      // Drop any type whose unlocking role was removed after it was checked.
      layout_types: layoutTypes.filter((t) => availableTypes.includes(t)),
    });
    // The bundle is finalized + ingesting — the resume session is consumed; clear it.
    clearUploadSession();
    setResumeSession(null);
    setJobId(created.job_id);
    registerJob(datasetId, created.job_id); // Seam O3: track it globally
    setPhase("polling");
    setStatusNote(null);
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
  async function startFreshSession(): Promise<void> {
    setResumeSession(null);
    const session = await props.client.createUpload();
    saveUploadSession({ uploadId: session.upload_id, datasetId, fingerprint });
    await runUpload(session.upload_id, allParts, allParts);
  }

  /** Fresh upload: open a session, persist it (resume anchor), send everything. */
  async function beginFresh(): Promise<void> {
    const problem = preSubmitProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    resetForRun();
    try {
      await startFreshSession();
    } catch (err) {
      handleRunError(err);
    }
  }

  /** Resume: confirm the persisted session still exists + is open, diff the re-selected
   *  files against it (/check), and send only what the server lacks. Falls back to a fresh
   *  session if the old one expired / was sealed. */
  async function beginResume(): Promise<void> {
    const problem = preSubmitProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (resumeSession === null) {
      void beginFresh();
      return;
    }
    resetForRun();
    setStatusNote("Checking your previous upload…");
    setPhase("uploading");
    try {
      const sessions = await props.client.listUploads();
      const found = sessions.find((s) => s.upload_id === resumeSession.uploadId);
      if (found === undefined || found.state !== "open") {
        // Expired / swept / already sealed — start clean (the server sweeps stale sessions
        // anyway; this is best-effort discovery, not a guarantee). Clear the dead pointer
        // eagerly; startFreshSession then opens + persists a new one.
        clearUploadSession();
        setNotice("Your previous upload could not be resumed (it expired or was sealed) — starting a fresh upload.");
        await startFreshSession();
        return;
      }
      const uploadId = resumeSession.uploadId;
      const plan = await planResume(props.client, uploadId, allParts);
      if (plan.mismatched.length > 0) {
        // Same-name-different-content files need a user decision (default: skip, keep the
        // server's copy) before continuing.
        setResumeReview({ uploadId, plan });
        setIncludeMismatched(false);
        setStatusNote(null);
        setPhase("resume-review");
        return;
      }
      setNotice(
        `Resuming — ${plan.present.length.toLocaleString()} file(s) already uploaded, sending ${plan.needed.length.toLocaleString()}.`,
      );
      await runUpload(uploadId, plan.needed, allParts);
    } catch (err) {
      handleRunError(err);
    }
  }

  /** Continue a resume from the mismatch review: send `needed` (+ mismatched if opted in). */
  async function continueResume(): Promise<void> {
    if (resumeReview === null) return;
    const { uploadId, plan } = resumeReview;
    const toSend = includeMismatched ? [...plan.needed, ...plan.mismatched] : plan.needed;
    setResumeReview(null);
    try {
      await runUpload(uploadId, toSend, allParts);
    } catch (err) {
      handleRunError(err);
    }
  }

  /** Retry only the parts that failed terminally in the last run. */
  async function retryFailed(): Promise<void> {
    if (currentUploadId === null || uploadResult === null) return;
    const failedNames = new Set(uploadResult.failures.map((f) => f.name));
    const failedParts = lastSentPartsRef.current.filter((p) => failedNames.has(p.name));
    try {
      await runUpload(currentUploadId, failedParts, allParts);
    } catch (err) {
      handleRunError(err);
    }
  }

  /** Finalize + ingest despite terminal failures (the dataset will lack those images). */
  async function continueAnyway(): Promise<void> {
    if (currentUploadId === null) return;
    try {
      await finishUpload(currentUploadId, allParts);
    } catch (err) {
      handleRunError(err);
    }
  }

  /** Cancel an in-flight upload (abort the transport). The persisted session is KEPT so the
   *  user can resume later. */
  function cancelUpload(): void {
    uploadAbortRef.current?.abort();
    setPhase("form");
    setStatusNote(null);
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
    jobStatus !== null && ["finished", "failed", "stopped", "canceled"].includes(jobStatus.state);
  // Extended phases collapse onto the rail's three-value phase (resume-review/uploading →
  // "uploading": source captured, Progress carries the flow).
  const railPhase: "form" | "uploading" | "polling" =
    phase === "form" ? "form" : phase === "polling" ? "polling" : "uploading";
  const rail = h(StepRail, {
    states: stepStates({ phase: railPhase, hasMetadata, formStage, jobTerminal }),
  });

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

  // ---- Uploading view — live byte progress, then finalize OR failure review --
  if (phase === "uploading") {
    const failures = uploadResult?.failures ?? [];
    const settledWithFailures = uploadResult !== null && failures.length > 0;
    return h(
      "div",
      { className: "wizard" },
      rail,
      notice !== null ? h("p", { className: "muted" }, notice) : null,
      batch !== null
        ? h(UploadProgressView, { snapshot: batch, failures })
        : h(
            "p",
            { className: "muted", role: "status", "aria-live": "polite" },
            statusNote ?? "Preparing upload…",
          ),
      ignoredNote !== null ? h("p", { className: "muted" }, ignoredNote) : null,
      error !== null ? h("p", { className: "error-text", role: "alert" }, error) : null,
      settledWithFailures
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
              { type: "button", className: "link-btn", onClick: () => setPhase("form") },
              "Back",
            ),
          )
        : batch !== null && statusNote === null
          ? h(
              "div",
              { className: "wizard-actions" },
              h("button", { type: "button", className: "btn ghost", onClick: () => cancelUpload() }, "Cancel"),
            )
          : null,
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
              setPhase("form");
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
        onChange: (e: { target: { files: FileList | null } }) =>
          addFiles(e.target.files === null ? [] : Array.from(e.target.files)),
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
        onChange: (e: { target: { files: FileList | null } }) =>
          addFiles(e.target.files === null ? [] : Array.from(e.target.files)),
      }),
    ),
    selectionNotes.length > 0
      ? h(
          "div",
          { className: "selection-notes" },
          selectionNotes.map((note, i) => h("p", { key: i, className: "muted selection-note" }, note)),
          h(
            "button",
            { type: "button", className: "link-btn", onClick: () => setImageFiles([]) },
            "Clear selection",
          ),
        )
      : selectedCount > 0
        ? h(
            "button",
            { type: "button", className: "link-btn", onClick: () => setImageFiles([]) },
            "Clear selection",
          )
        : null,
    h(
      "label",
      { className: "dropzone" },
      h("span", { className: "dropzone-title" }, "Metadata CSV/TSV"),
      h("span", { className: "dropzone-hint muted" }, "Optional — images alone are a complete dataset"),
      h("input", {
        type: "file",
        accept: ".csv,.tsv",
        "aria-label": "Select a metadata CSV or TSV",
        onChange: (e: { target: { files: FileList | null } }) =>
          void onCsvChosen(e.target.files === null ? null : (e.target.files[0] ?? null)),
      }),
      csvFile !== null ? h("span", { className: "detected-count" }, `${csvFile.name} selected`) : null,
    ),
    h(
      "label",
      { className: "field wizard-datasetid" },
      h("span", null, "Dataset id"),
      h("input", {
        value: datasetId,
        placeholder: "my_dataset",
        onChange: (e: { target: { value: string } }) => setDatasetId(e.target.value),
      }),
    ),
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
  const resumeBanner =
    resumeSession !== null
      ? h(
          "div",
          { className: "resume-banner panel-float", role: "status" },
          h(
            "span",
            { className: "resume-banner-text" },
            resumeMatches
              ? `Interrupted upload to "${resumeSession.datasetId}" found — the same files are selected. Click "Resume upload" to send only what's missing.`
              : selectedCount > 0
                ? `Interrupted upload to "${resumeSession.datasetId}" found, but the selected files differ — "Upload & create" will start fresh.`
                : `Interrupted upload to "${resumeSession.datasetId}" found. Re-select the same files (or folder) to resume.`,
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
