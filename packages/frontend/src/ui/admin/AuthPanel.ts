// Sign-up / log-in panel (catalogue ui/admin required capability; R-13).
// Talks to the backend only through ApiClient. The token is handed UP to the
// app shell (which owns the getToken closure) — this component never stores
// it. The JWT is identity-only (D-24): nothing here decodes or inspects it.
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";

export interface AuthPanelProps {
  client: ApiClient;
  onAuthenticated: (token: string, username: string) => void;
  // T2-123 (Fix A): a non-alarming notice shown above the form when the app routed
  // here because the session expired ("Session expired — please log in again"). A
  // null/absent value shows nothing (a normal first-time / explicit-logout visit).
  notice?: string | null;
  // Anonymous public entry (D-34 consumer): the demo front door OFF the auth screen —
  // "browse without logging in" routes back to the anonymous public library. Present
  // whenever anonymous browsing is reachable (App always supplies it); absent renders
  // no such affordance (so an isolated AuthPanel test stays a pure login form).
  onBrowseAnonymously?: () => void;
}

/** Structural ApiError unwrap (components cannot value-import client.ts —
 *  extensionless src specifiers do not resolve under the node test runner). */
function errText(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { detail?: unknown }).detail === "string") {
    return (err as { detail: string }).detail;
  }
  return err instanceof Error ? err.message : String(err);
}

export function AuthPanel(props: AuthPanelProps): ReactElement {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        await props.client.signup({ username, email, password });
      }
      // signup/login send no bearer; the TokenResponse feeds the shell's
      // getToken closure via onAuthenticated.
      const token = await props.client.login({ username, password });
      props.onAuthenticated(token.access_token, username);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    label: string,
    type: string,
    value: string,
    set: (v: string) => void,
    autoComplete: string,
  ): ReactElement =>
    h(
      "label",
      { className: "form-field", key: label },
      h("span", null, label),
      h("input", {
        type,
        value,
        autoComplete,
        onChange: (e: { target: { value: string } }) => set(e.target.value),
      }),
    );

  return h(
    "section",
    { className: "auth-panel" },
    h("h2", { className: "panel-title" }, mode === "login" ? "Log in" : "Create an account"),
    // T2-123 (Fix A): the session-expiry notice — role="status" (informational), not
    // "alert", so it reads as a gentle prompt rather than an error. Shown only in login
    // mode: the copy ("please log in again") is incongruous on the sign-up tab, and an
    // expiry always routes here to re-authenticate an existing account, not create one.
    mode === "login" && props.notice != null && props.notice !== ""
      ? h("p", { className: "auth-notice", role: "status" }, props.notice)
      : null,
    h(
      "form",
      {
        className: "auth-form",
        onSubmit: (e: { preventDefault: () => void }) => {
          e.preventDefault();
          void submit();
        },
      },
      field("Username", "text", username, setUsername, "username"),
      mode === "signup" ? field("Email", "email", email, setEmail, "email") : null,
      field("Password", "password", password, setPassword, mode === "signup" ? "new-password" : "current-password"),
      error !== null ? h("p", { className: "error-text", role: "alert" }, error) : null,
      h(
        "button",
        { type: "submit", className: "primary-btn", disabled: busy },
        busy ? "Working…" : mode === "login" ? "Log in" : "Sign up",
      ),
    ),
    h(
      "button",
      {
        type: "button",
        className: "link-btn",
        onClick: () => {
          setMode(mode === "login" ? "signup" : "login");
          setError(null);
        },
      },
      mode === "login" ? "No account? Sign up" : "Have an account? Log in",
    ),
    // Anonymous public entry (D-34 consumer): the login-less demo front door. When
    // anonymous browsing is reachable, offer a way OUT of the auth screen straight to
    // the public library — so a visitor who landed here (clicked "Log in", or was
    // bounced by an expiry) can still explore the showcase without an account.
    props.onBrowseAnonymously != null
      ? h(
          "button",
          { type: "button", className: "link-btn auth-anon-link", onClick: props.onBrowseAnonymously },
          "Browse without logging in",
        )
      : null,
  );
}
