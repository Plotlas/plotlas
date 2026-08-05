// The React shell (catalogue: ui/App.tsx). Owns:
//  - auth state + the getToken closure the ApiClient reads per request
//    (identity-only JWT, D-24 — held as an OPAQUE string, never decoded);
//  - routing between the admin surface (default when logged in) and the
//    viewer for a chosen dataset;
//  - ★ D-31: the viewer is mounted KEYED ON datasetId — switching datasets
//    unmounts ViewerScreen, whose cleanup disposes the whole renderer stack
//    (world.dispose() releases the lifetime LodManager/LayoutController
//    camera subscriptions). Never recreate those against a surviving World.
//
// All network goes through the single ApiClient created here (brief §1.3);
// baseUrl "" = same-origin through the Caddy dev edge, which serves /api/*
// (FastAPI) and /datasets/* (static versioned assets).
//
// This file is the one UI module not imported by node tests (it is the vite
// composition root), so it may value-import sibling modules freely.
import { createElement as h, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createApiClient } from "../api-client/client";
import { pushUrlForView, routeForUnavailable, viewFromSearch } from "./urlState";
import type { View } from "./urlState";
import { AuthPanel } from "./admin/AuthPanel";
import { AdminScreen } from "./admin/AdminScreen";
import { ViewerScreen } from "./ViewerScreen";
import { ActivityProvider } from "./activity/activityContext";
import { ACTIVITY_STORAGE_KEY } from "./activity/activityStore";
import { PlotlasMark, PLOTLAS_VERSION } from "./PlotlasMark";

// Phase-1 token persistence: localStorage keeps the session across reloads.
// TRADE-OFF (noted per brief §0.4): localStorage is readable by any script on
// the origin, so an XSS hole would leak the token. Acceptable for Phase 1
// (self-hosted, no third-party scripts); an httpOnly-cookie session is the
// hardening path if that posture changes.
const TOKEN_KEY = "plotlas.token";
const USERNAME_KEY = "plotlas.username";

function readStored(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode etc.): in-memory auth still works.
  }
}

// Anonymous public entry (D-34 consumer): the auth screen is now a VIEW you navigate to
// (from the library's "Log in", or a session-expiry bounce), NOT the default gate. An
// unauthenticated visitor lands on `admin` (the public read-only library) — no login wall.
//
// `View` now lives in ./urlState, which owns the ↔ URL translation (deep links, scope
// Part A). It is re-exported nowhere: import it from urlState.

/** Read the view a URL asks for. SSR/test-safe — no `window` ⇒ the library. */
function initialView(): View {
  if (typeof window === "undefined") return { kind: "admin" };
  return viewFromSearch(window.location.search);
}

export function App(): ReactElement {
  // The token lives in a ref so the getToken closure always reads the current
  // value without recreating the client (catalogue: createApiClient).
  const tokenRef = useRef<string | null>(readStored(TOKEN_KEY));
  const [username, setUsername] = useState<string | null>(
    tokenRef.current !== null ? readStored(USERNAME_KEY) : null,
  );
  // Corrupted-storage coherence (PR #178 review LOW-2): a token WITHOUT a stored
  // username would render the anonymous chrome while still transmitting the token
  // (whose staleness then fires the client-tier expiry bounce on an apparently
  // anonymous visitor). Either both halves exist or the session is anonymous.
  if (tokenRef.current !== null && readStored(USERNAME_KEY) === null) {
    tokenRef.current = null;
    writeStored(TOKEN_KEY, null);
  }
  // Deep links (scope Part A): the FIRST view comes from the URL, so `?d=<id>` opens
  // that collection directly instead of the library.
  const [view, setViewState] = useState<View>(initialView);
  // T2-123 (Fix A): a non-alarming notice shown on the auth screen when the app routed
  // there because the session EXPIRED (vs a first-time / explicit-logout visit).
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  // A message shown ON the library when a deep link could not be opened (unknown id, or
  // a private collection this visitor may not read — the API returns the SAME 404 for
  // both, deliberately, so existence is not disclosed and neither can we).
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);

  // The current view, mirrored in a ref. setView needs to compare against it WITHOUT
  // doing the history write inside a state updater: React double-invokes updaters under
  // StrictMode, which would push two identical history entries per navigation and make
  // Back appear to do nothing the first time.
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  // Every navigation writes the URL, so a collection can be linked to and Back works.
  // pushUrlForView owns the dedup rule: it returns null (leave history alone) for an
  // unchanged view, for `auth` (the `?d=` that bounced the visitor to the login screen
  // must survive for the continue-through in handleAuthenticated), AND when the current
  // URL already shows `next` — otherwise the continue-through (auth→viewer{d}, URL
  // unchanged) would push a duplicate entry and make the first Back a silent no-op.
  function setView(next: View): void {
    if (typeof window !== "undefined") {
      const url = pushUrlForView(viewRef.current, next, window.location);
      if (url !== null) window.history.pushState(null, "", url);
    }
    viewRef.current = next;
    setViewState(next);
  }

  // Back/Forward. The browser has already changed the URL by the time this fires, so
  // the URL is the source of truth and we must NOT push another entry (which would trap
  // the visitor — Back would bounce between two entries forever). Hence setViewState
  // directly, never setView.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = (): void => {
      const next = viewFromSearch(window.location.search);
      // Clear BOTH deep-link notices: a back-nav lands on the library or a viewer (never
      // `auth`), so a prior notice is stale — and leaving authNotice set would resurface
      // it on the next explicit "Log in".
      setLibraryNotice(null);
      setAuthNotice(null);
      viewRef.current = next;
      setViewState(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // A deep link that could not be opened. The DECISION (and its security-relevant
  // wording) lives in urlState.routeForUnavailable so it is unit-testable — this file is
  // the vite composition root and is never imported by the node runner. Here we only
  // apply it.
  function handleDatasetUnavailable(datasetId: string): void {
    const route = routeForUnavailable(datasetId, username);
    setAuthNotice(route.authNotice);
    setLibraryNotice(route.libraryNotice);
    setView(route.view);
  }

  // The client is app-lifetime (useMemo []). Its onAuthExpired hook must call the
  // CURRENT handler, so route it through a ref the render keeps fresh (all the setters
  // it uses are stable, but this avoids any staleness and reads clearly).
  const onAuthExpiredRef = useRef<() => void>(() => {});
  const client = useMemo(
    () => createApiClient("", () => tokenRef.current, () => onAuthExpiredRef.current()),
    [],
  );

  function handleAuthenticated(token: string, user: string): void {
    tokenRef.current = token;
    writeStored(TOKEN_KEY, token);
    writeStored(USERNAME_KEY, user);
    // A FRESH login must not inherit a prior session's tracked jobs (a page refresh
    // does NOT run this — it restores from storage on mount — so resume-after-refresh
    // is preserved; only an explicit new login starts clean). Job reads are owner-open
    // (api/routers/jobs.py), so a stale id would surface the previous user's dataset id
    // / ingest.log tail in this user's activity panel.
    writeStored(ACTIVITY_STORAGE_KEY, null);
    setAuthNotice(null); // a successful login clears any prior session-expiry notice
    setUsername(user);
    // Deep links (scope Part A): CONTINUE THROUGH. If a `?d=` link bounced this visitor
    // here because the collection was not readable anonymously, land them on it now
    // rather than on the library — that link is what they were trying to open. With no
    // `?d=` present this is exactly the old behaviour (the library).
    setLibraryNotice(null);
    setView(initialView());
  }

  function handleLogout(): void {
    tokenRef.current = null;
    writeStored(TOKEN_KEY, null);
    writeStored(USERNAME_KEY, null);
    // End the session's activity tracking too (mirrors the token clear): the next user
    // on this browser must not re-poll and see this session's jobs (owner-open reads).
    writeStored(ACTIVITY_STORAGE_KEY, null);
    setAuthNotice(null); // an explicit logout is not an expiry — no notice
    setUsername(null);
    // Anonymous public entry (D-34 consumer): logout returns to the ANONYMOUS library
    // (the public read-only list), NOT the old auth wall — the demo has no login gate.
    setView({ kind: "admin" });
  }

  // T2-123 (Fix A): the app's reaction to an EXPIRED/REVOKED session — a background or
  // foreground API call returned 401 with a token present (the client's onAuthExpired
  // hook, or a component's own 401 path). Clear the session EXACTLY as logout does
  // (token/username + the T2-113 activity key) and route to the auth screen WITH a
  // notice, instead of leaving the user browsing half-alive on a dead token (the
  // static-edge 401 spiral). Idempotent — the client fires it once per expired token.
  function handleSessionExpired(): void {
    tokenRef.current = null;
    writeStored(TOKEN_KEY, null);
    writeStored(USERNAME_KEY, null);
    writeStored(ACTIVITY_STORAGE_KEY, null);
    setAuthNotice("Session expired — please log in again.");
    setUsername(null);
    // A logged-in session expiring still bounces to the LOGIN screen with the notice
    // (unchanged). With the wall gone (anonymous entry, D-34), this route is now
    // EXPLICIT — `auth` — and the login screen offers "browse without logging in" so the
    // visitor can drop into the anonymous library instead of re-authenticating.
    setView({ kind: "auth" });
  }
  // Keep the app-lifetime client pointed at the current handler.
  onAuthExpiredRef.current = handleSessionExpired;

  if (view.kind === "auth") {
    // Auth shell — the stacked lockup (board 3c): the mark above the "Plotlas"
    // wordmark, a mono footer signature below. The one place the name appears on
    // this surface. Anonymous public entry (D-34 consumer): this is now reached only
    // by an EXPLICIT "Log in" from the library or a session-expiry bounce — never as a
    // first-visit wall — and it offers a way back to the anonymous library.
    return h(
      "div",
      { className: "app-shell app-shell-auth" },
      h(
        "div",
        { className: "auth-lockup" },
        h(PlotlasMark, { size: 52 }),
        h("h1", { className: "app-title" }, "Plotlas"),
      ),
      h(AuthPanel, {
        client,
        onAuthenticated: handleAuthenticated,
        notice: authNotice,
        // The login-less demo front door: continue to the public library with no account.
        onBrowseAnonymously: () => {
          setAuthNotice(null);
          setView({ kind: "admin" });
        },
      }),
      h("p", { className: "auth-footer" }, `plotlas · self-hosted · v${PLOTLAS_VERSION}`),
    );
  }

  // Seam O3: the ActivityProvider wraps BOTH the admin and viewer screens so its
  // top-level job poller + pill state survive the admin↔viewer switch (nothing polled
  // above the switch before). It restores the tracked set from localStorage on mount, so
  // a refresh reattaches running jobs. Anonymous public entry (D-34 consumer): it wraps
  // the anonymous screens too, but stays inert for them — a visitor tracks/adopts no
  // jobs (AdminScreen skips adoption when read-only) and the pill is hidden when nothing
  // is tracked, so no activity surface leaks. The `auth` branch above returns first.
  const screen =
    view.kind === "viewer"
      ? h(
          "div",
          { className: "app-shell" },
          // ★ D-31: key=datasetId forces a full remount (and renderer-stack
          // rebuild) per dataset.
          h(ViewerScreen, {
            key: view.datasetId,
            datasetId: view.datasetId,
            client,
            onBack: () => setView({ kind: "admin" }),
            // T2-123: a foreground 401 routes through the same expiry handler (clears +
            // notice) as the client-level background hook — one consistent reaction.
            onAuthExpired: handleSessionExpired,
            // Deep links (scope Part A): a link to a collection that does not exist, or
            // that this visitor may not read.
            onUnavailable: handleDatasetUnavailable,
          }),
        )
      : h(
          "div",
          { className: "app-shell" },
          h(AdminScreen, {
            client,
            // string ⇒ authenticated (today's chrome); null ⇒ ANONYMOUS read-only library
            // (D-34 consumer). AdminScreen derives its read-only mode from this.
            username,
            onOpenDataset: (datasetId: string) => {
              setLibraryNotice(null);
              setView({ kind: "viewer", datasetId });
            },
            onAuthExpired: handleSessionExpired,
            onLogout: handleLogout,
            // Deep links (scope Part A): why we are here and not on the linked collection.
            notice: libraryNotice,
            // Anonymous public entry: the read-only library's "Log in" opens the auth view.
            onLogin: () => setView({ kind: "auth" }),
          }),
        );

  return h(ActivityProvider, { client }, screen);
}
