// The Data view's FREE EDITS — a column's display label, `hidden` and `render` (D-xx) — as
// a small store with one subscription per field (seam L4; second review of #384, #1/#2/#5/#8).
//
// Why a store and not table state:
//   - INTENT. A field's value is what the user last ASKED for: the value in flight while its
//     PATCH is, else the value that landed. Every save compares against that, and every
//     carry reads it. Comparing against what had LANDED lost a label typed away and back
//     while its first save was in flight (#1), sent `hidden: true` twice for two quick
//     clicks (#2), and — for `render` — re-enabled a link the user had just switched off
//     (round-2 N1, which this generalises).
//   - LOCALITY. Each field subscribes to its own value and status, so "Saving…" / "Saved"
//     redraws that field, not every row: status held as table state re-rendered all ~500
//     rows twice per save at 500 columns (#8).
//   - RELOAD. A record the shell hands down from elsewhere (a reload, a version bump,
//     Overview) is ADOPTED, and every field not mid-edit follows it (#5).
//
// No React in the store; `useField` is the one hook, over `useSyncExternalStore`.
import { useSyncExternalStore } from "react";
import type { Presentation } from "../../generated/presentation";

export type FieldKey = "label" | "hidden" | "render";
export type FieldValue = string | boolean | null;
export interface FieldStatus {
  state: "idle" | "saving" | "saved" | "error";
  error: string | null;
}
export interface FieldSnapshot {
  value: FieldValue;
  status: FieldStatus;
}

const IDLE: FieldStatus = { state: "idle", error: null };

/** What a record stores for one key, normalised the way the API stores it: a blank label
 *  is no label, `hidden` is `true` or absent, `render` is `"url"` or absent. */
export function storedValue(record: Presentation, column: string, key: FieldKey): FieldValue {
  const entry = record.columns?.[column];
  if (key === "label") {
    const label = entry?.label;
    return label === undefined || label.trim() === "" ? null : label;
  }
  if (key === "hidden") return entry?.hidden === true ? true : null;
  return entry?.render === "url" ? "url" : null;
}

/** The record with one column key set (or removed, for null), as the server now stores it.
 *  An emptied entry is KEPT, as `presentation.apply_updates` keeps it — the tombstone that
 *  says the owner has spoken about this column. */
export function withColumnKey(presentation: Presentation, column: string, key: FieldKey, value: FieldValue): Presentation {
  const columns = { ...(presentation.columns ?? {}) } as Record<string, Record<string, unknown>>;
  const entry = { ...(columns[column] ?? {}) };
  if (value === null) delete entry[key];
  else entry[key] = value;
  columns[column] = entry;
  return { ...presentation, columns: columns as Presentation["columns"] };
}

export interface FreeEditsDeps {
  /** Send `{columns: {[column]: entry}}`. */
  patch: (column: string, entry: Record<string, unknown>) => Promise<unknown>;
  /** A save landed: ONE key of one column, as the server now stores it. The caller applies
   *  it to the shell's CURRENT record — never hands over this store's copy, which knows
   *  nothing of what changed elsewhere since (final review of #384). */
  landed: (column: string, key: FieldKey, value: FieldValue) => void;
  authExpired: () => void;
  errorText: (err: unknown) => string;
}

export interface FreeEdits {
  /** The record as the last save that LANDED left it. */
  record(): Presentation;
  /** Take the shell's record as it now stands; fields not mid-save now read it. */
  adopt(record: Presentation): void;
  /** The value as last asked for: in flight if a save is, else landed. */
  current(column: string, key: FieldKey): FieldValue;
  save(column: string, key: FieldKey, value: FieldValue): void;
  snapshot(column: string, key: FieldKey): FieldSnapshot;
  subscribe(column: string, key: FieldKey, listener: () => void): () => void;
}

export function createFreeEdits(initial: Presentation, deps: FreeEditsDeps): FreeEdits {
  let record = initial;
  const inFlight = new Map<string, FieldValue>();
  const statuses = new Map<string, FieldStatus>();
  const snapshots = new Map<string, FieldSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  const idOf = (column: string, key: FieldKey): string => `${column}\u0000${key}`;
  const notify = (id: string): void => {
    for (const listener of listeners.get(id) ?? []) listener();
  };
  const setStatus = (id: string, status: FieldStatus): void => {
    statuses.set(id, status);
    notify(id);
  };

  // ONE PATCH IN FLIGHT PER FIELD (round-4 review of #384, #2). A value asked for while one is
  // in flight WAITS, and only the newest waiting value is sent when it settles. So every
  // success is applied to `record` — an overtaken save's success used to be discarded, and a
  // later failure then left the store believing a value the server no longer held — and the
  // outcome no longer depends on the server applying two writes to one key in order.
  const waiting = new Map<string, FieldValue>();

  function current(column: string, key: FieldKey): FieldValue {
    const id = idOf(column, key);
    if (waiting.has(id)) return waiting.get(id) as FieldValue;
    return inFlight.has(id) ? (inFlight.get(id) as FieldValue) : storedValue(record, column, key);
  }

  function save(column: string, key: FieldKey, value: FieldValue): void {
    const id = idOf(column, key);
    if (value === current(column, key)) {
      if (!inFlight.has(id)) setStatus(id, IDLE);
      return;
    }
    if (inFlight.has(id)) {
      // Asking again for what is already on the wire cancels the wait; anything else waits.
      if (value === inFlight.get(id)) waiting.delete(id);
      else waiting.set(id, value);
      notify(id);
      return;
    }
    send(column, key, value);
  }

  /** What to do once a field's PATCH has settled: send the newest value asked for since, if
   *  the server does not already hold it; else settle the status. */
  function next(column: string, key: FieldKey, settled: FieldStatus): void {
    const id = idOf(column, key);
    const value = waiting.get(id);
    waiting.delete(id);
    if (value !== undefined && value !== storedValue(record, column, key)) send(column, key, value);
    else setStatus(id, value !== undefined ? IDLE : settled);
  }

  function send(column: string, key: FieldKey, value: FieldValue): void {
    const id = idOf(column, key);
    // Partial by key presence at every level: this column, this key — plus, for a column
    // drawn as a link AS LAST ASKED FOR, `render: "url"` again. A link from a pre-2.9
    // manifest's `column_roles.url` is served only while the stored record has NO entry for
    // the column (`presentation.effective_columns`); this PATCH may be the one that creates
    // the entry, and without `render` the link would be gone for good (review of #384, F1).
    const entry: Record<string, unknown> = { [key]: value };
    if (key !== "render" && current(column, "render") === "url") entry.render = "url";
    inFlight.set(id, value);
    setStatus(id, { state: "saving", error: null });
    deps.patch(column, entry).then(
      () => {
        record = withColumnKey(record, column, key, value);
        inFlight.delete(id);
        deps.landed(column, key, value);
        next(column, key, { state: "saved", error: null });
      },
      (err: unknown) => {
        // The server kept what it had: the landed record is the truth again.
        inFlight.delete(id);
        if ((err as { status?: unknown } | null)?.status === 401) {
          waiting.delete(id);
          deps.authExpired();
          setStatus(id, IDLE);
          return;
        }
        next(column, key, { state: "error", error: deps.errorText(err) });
      },
    );
  }

  function snapshot(column: string, key: FieldKey): FieldSnapshot {
    const id = idOf(column, key);
    const value = current(column, key);
    const status = statuses.get(id) ?? IDLE;
    const prev = snapshots.get(id);
    if (prev !== undefined && prev.value === value && prev.status === status) return prev;
    const next = { value, status };
    snapshots.set(id, next);
    return next;
  }

  return {
    record: () => record,
    adopt(next) {
      if (next === record) return;
      record = next;
      for (const id of listeners.keys()) notify(id);
    },
    current,
    save,
    snapshot,
    subscribe(column, key, listener) {
      const id = idOf(column, key);
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(id, set);
      return () => {
        set.delete(listener);
      };
    },
  };
}

/** One field's value (as last asked for) and save status, re-rendering only its caller. */
export function useField(store: FreeEdits, column: string, key: FieldKey): FieldSnapshot {
  return useSyncExternalStore(
    (listener) => store.subscribe(column, key, listener),
    () => store.snapshot(column, key),
  );
}
