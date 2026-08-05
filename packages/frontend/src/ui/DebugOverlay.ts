// Dev-only renderer debug overlay (O1 round-3 diagnosis tool).
//
// Toggled with the backtick (`) key from the viewer. Reads the shared
// `rendererDebug` state (also mirrored on window.__vizDebug) and repaints a few
// times a second. The headline number is PLACEHOLDER: cells currently showing
// the grey placeholder because their bucket's atlas page has not bound yet. If
// that spikes on a zoom-in and decays as pages arrive, the "grey on zoom-in"
// bug is the migrate-into-empty-bucket path — confirmed by watching, not guessed.
import { createElement as h, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { rendererDebug } from "../renderer/debug.ts";

const panel: CSSProperties = {
  position: "absolute",
  top: "8px",
  left: "8px",
  zIndex: 20,
  pointerEvents: "none",
  font: "11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#e6e6e6",
  background: "rgba(12,14,18,0.82)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: "6px",
  padding: "8px 10px",
  minWidth: "188px",
  whiteSpace: "pre",
};
const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: "16px" };
const dim: CSSProperties = { color: "#8a93a0" };
const title: CSSProperties = { fontWeight: 700, letterSpacing: "0.04em", marginBottom: "4px", color: "#aab4c0" };

function line(label: string, value: string, valueStyle?: CSSProperties): ReactElement {
  return h("div", { style: row, key: label }, h("span", { style: dim }, label), h("span", { style: valueStyle }, value));
}

export function DebugOverlay(): ReactElement {
  const [, setTick] = useState(0);
  const fps = useRef({ frames: 0, last: 0, value: 0 });

  useEffect(() => {
    let raf = 0;
    const loop = (t: number): void => {
      const f = fps.current;
      f.frames += 1;
      if (f.last === 0) f.last = t;
      else if (t - f.last >= 500) {
        f.value = Math.round((f.frames * 1000) / (t - f.last));
        f.frames = 0;
        f.last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
  }, []);

  const d = rendererDebug;
  // Both `placeholderCellsInView` and `placeholderCells` are published together by
  // cells.ts publishCellDebug, so they are logically atomic. The min is a
  // belt-and-suspenders guard against any future divergence in publish cadence.
  const greyInView = Math.min(d.placeholderCellsInView, d.placeholderCells);
  const greyStyle: CSSProperties =
    greyInView > 0 ? { color: "#ffb36b", fontWeight: 700 } : { color: "#7dd98f" };
  const lods = Object.keys(d.byLod)
    .map(Number)
    .sort((a, b) => a - b);

  return h(
    "div",
    { style: panel, "aria-hidden": true },
    h("div", { style: title }, "RENDERER DEBUG  (` to hide)"),
    line(
      "LEVEL z",
      d.selectedZ >= 0 ? `${d.selectedZ} / max ${d.maxZ}  ${d.selectedZ < d.zCap ? "COARSE" : "FINE"}` : "—",
      { fontWeight: 700, color: d.selectedZ < 0 ? "#8a93a0" : d.selectedZ < d.zCap ? "#ffb36b" : "#7dd98f" },
    ),
    line("z_cap", d.zCap >= 0 ? `${d.zCap} (z<cap=coarse)` : "—"),
    line(
      "resident",
      Object.keys(d.residentByZ).length
        ? Object.keys(d.residentByZ)
            .map(Number)
            .sort((a, b) => a - b)
            .map((zz) => `z${zz}:${d.residentByZ[zz]}`)
            .join("  ")
        : "—",
    ),
    line("loading", `${d.loadingTiles} tiles`),
    line("placeholder", `${greyInView} in view / ${d.placeholderCells} total`, greyStyle),
    line("fps", String(fps.current.value)),
    lods.length > 0
      ? h(
          "div",
          { style: { marginTop: "5px", paddingTop: "5px", borderTop: "1px solid rgba(255,255,255,0.12)" } },
          ...lods.map((l) => {
            const s = d.byLod[l];
            return line(`z${l}`, `${s.textured}/${s.cells} cells · ${s.pages}t`);
          }),
        )
      : null,
  );
}
