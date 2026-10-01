// The instant a datetime value from `getMetadata` denotes.
//
// One reader for the viewer's selection summary (`ui/SelectionSummary.ts`) and the overlay's
// pre-2.5 axis shim (`renderer/overlayLayer.ts`). Each used to read the value by the declared
// format, and both misread a stored timestamp committed as `unix_*` (#391), so there is one
// copy. Pure and type-only in its imports, so `ui/` and `renderer/` may both import it.
import type { ColumnRoles } from "../generated/column_roles";
import type { MetadataRow } from "./types";

type DatetimeFormat = NonNullable<ColumnRoles["datetime"]>["format"];

/** The largest |epoch milliseconds| a `Date` can hold (ECMAScript's time-value range,
 *  ±100,000,000 days). Past it `new Date(t)` is Invalid, so such a value is no date. */
export const MAX_TIME_VALUE_MS = 8.64e15;

/** A datetime field's instant in epoch milliseconds, or null when it is no date.
 *
 *  Read from the VALUE's type, not the declared format: the API serves a stored timestamp
 *  as an ISO string whatever format the roles declare (`routers/metadata.py`
 *  `_coerce_field`), and a `unix_*`-ingested column as its stored integer. Keyed on the
 *  format, a timestamp column whose committed format is `unix_*` sent every ISO string
 *  through `Number(raw)`, which is NaN (#391). So a string parses as a date, and only a
 *  number is scaled by the declared format: milliseconds for `unix_millis`, seconds
 *  otherwise, which is how the datetime plugin reads an integer under each format
 *  (`datetime_layout._to_epoch`). */
export function datetimeInstant(
  raw: MetadataRow["fields"][string] | undefined,
  format: DatetimeFormat,
): number | null {
  let ms: number;
  if (typeof raw === "number") ms = format === "unix_millis" ? raw : raw * 1000;
  else if (typeof raw === "string") ms = Date.parse(raw);
  else return null;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_VALUE_MS ? ms : null;
}
