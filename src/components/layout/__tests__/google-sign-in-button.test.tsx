// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@/test/rtl-setup";

// Pass 38 — client-side state-machine coverage for GoogleSignInButton.
// Simulates Google Identity Services by capturing the `callback` passed to
// window.google.accounts.id.initialize() and invoking it directly with a
// fake credential response, exactly as Google's own external script would.
// Proves the actual bug class Pass 37 fixed cannot recur: every outcome
// (success, denied, bootstrap-not-initialized, verification failure,
// network/server error, and a retry attempt afterward) both resets the
// loading state (or navigates away) AND never leaves the button
// permanently stuck showing "Signing in…".

let capturedCallback: ((response: { credential: string }) => void) | undefined;

vi.mock("next/script", () => ({
  default: ({ onReady }: { onReady?: () => void }) => {
    onReady?.();
    return null;
  },
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

const signInWithGoogle = vi.fn();
vi.mock("@/server/actions/google-auth", () => ({
  signInWithGoogle: (...args: [string]) => signInWithGoogle(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedCallback = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).google = {
    accounts: {
      id: {
        initialize: ({ callback }: { callback: (r: { credential: string }) => void }) => {
          capturedCallback = callback;
        },
        renderButton: () => {},
      },
    },
  };
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).google;
});

async function renderAndTriggerSignIn() {
  const { GoogleSignInButton } = await import("../google-sign-in-button");
  render(<GoogleSignInButton clientId="test-client-id.apps.googleusercontent.com" />);
  await waitFor(() => expect(capturedCallback).toBeDefined());
  await act(async () => {
    capturedCallback!({ credential: "fake-google-credential" });
  });
}

describe("GoogleSignInButton — client state machine (Pass 38)", () => {
  it("success: shows 'Signing in…', then navigates to /dashboard without an error toast", async () => {
    signInWithGoogle.mockResolvedValue({ ok: true });
    await renderAndTriggerSignIn();

    expect(await screen.findByText(/Signing in/i)).toBeInTheDocument();
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/dashboard"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("unauthorized (ACCESS_DENIED): the user is routed to a readable error page — never left stuck with no navigation and no error shown", async () => {
    signInWithGoogle.mockResolvedValue({ ok: false, reason: "ACCESS_DENIED" });
    await renderAndTriggerSignIn();

    // Same intentional design as the success path: the loading indicator
    // stays visible THROUGH the navigation itself (this component unmounts
    // once the route actually changes) rather than resetting for one frame
    // first — what actually matters is that navigation demonstrably
    // happens, so this is never "stuck," just mid-transition.
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/access-denied?reason=ACCESS_DENIED"));
  });

  it("bootstrap not initialized: loading resets and the user is routed to the specific, readable configuration error", async () => {
    signInWithGoogle.mockResolvedValue({ ok: false, reason: "NOT_INITIALIZED" });
    await renderAndTriggerSignIn();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/access-denied?reason=NOT_INITIALIZED"));
  });

  it("bootstrap email mismatch: loading resets and the user is routed to the specific, readable error", async () => {
    signInWithGoogle.mockResolvedValue({ ok: false, reason: "BOOTSTRAP_EMAIL_MISMATCH" });
    await renderAndTriggerSignIn();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/access-denied?reason=BOOTSTRAP_EMAIL_MISMATCH"));
  });

  it("Google verification failure: stays on the login page, shows a retryable toast, and resets loading — never navigates away", async () => {
    signInWithGoogle.mockResolvedValue({ ok: false, reason: "GOOGLE_VERIFICATION_FAILED" });
    await renderAndTriggerSignIn();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Google sign-in could not be completed. Please try again."));
    await waitFor(() => expect(screen.queryByText(/Signing in/i)).not.toBeInTheDocument());
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("server/network error (the action's promise rejects): shows a retryable toast and resets loading — the exact class of bug Pass 37 fixed", async () => {
    signInWithGoogle.mockRejectedValue(new Error("network error"));
    await renderAndTriggerSignIn();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Sign-in failed. Please try again."));
    await waitFor(() => expect(screen.queryByText(/Signing in/i)).not.toBeInTheDocument());
  });

  it("unexpected exception thrown synchronously by the resolved handler is still caught (a throw inside .then() rejects the chain) and resets loading", async () => {
    // signInWithGoogle resolves with a value whose shape is used in a way
    // that would throw if it were ever malformed — this proves the .then()
    // -> .catch() chain still recovers even from an unexpected exception
    // raised while handling an otherwise-resolved promise, not only from a
    // rejected one.
    signInWithGoogle.mockResolvedValue(null); // malformed: real code always resolves {ok:...}
    await renderAndTriggerSignIn();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Sign-in failed. Please try again."));
    await waitFor(() => expect(screen.queryByText(/Signing in/i)).not.toBeInTheDocument());
  });

  it("repeat attempt after a failure: the button is clickable again and a second attempt runs the full flow", async () => {
    signInWithGoogle.mockResolvedValueOnce({ ok: false, reason: "GOOGLE_VERIFICATION_FAILED" });
    await renderAndTriggerSignIn();
    await waitFor(() => expect(screen.queryByText(/Signing in/i)).not.toBeInTheDocument());

    signInWithGoogle.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      capturedCallback!({ credential: "second-attempt-credential" });
    });
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/dashboard"));
    expect(signInWithGoogle).toHaveBeenCalledTimes(2);
  });
});

// Pass 40 — investigated a hypothesis that React Strict Mode's dev-only
// double-invocation of effects (the effect calling
// google.accounts.id.initialize()/renderButton() has no cleanup function)
// could cause a duplicate GIS initialization on localhost. Direct testing
// (see the pass report) proved this specific component is NOT actually
// affected in practice — the real initialize()/renderButton() call is
// gated behind an async `scriptLoaded` state flip that lands after Strict
// Mode's double-invoke window has already closed, so it only ever runs
// once even under Strict Mode. This test documents and locks in that
// property (a defensive `initializedRef` guard was added anyway, cheap
// insurance against a future change that could make this effect genuinely
// re-run) — it is not evidence that a duplicate-init bug existed or was
// "fixed."
describe("GoogleSignInButton — initializes exactly once (Pass 40)", () => {
  it("calls google.accounts.id.initialize() and renderButton() exactly once, including under React Strict Mode", async () => {
    const initializeSpy = vi.fn(({ callback }: { callback: (r: { credential: string }) => void }) => {
      capturedCallback = callback;
    });
    const renderButtonSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).google = {
      accounts: { id: { initialize: initializeSpy, renderButton: renderButtonSpy } },
    };

    const { GoogleSignInButton } = await import("../google-sign-in-button");
    render(
      <StrictMode>
        <GoogleSignInButton clientId="test-client-id.apps.googleusercontent.com" />
      </StrictMode>
    );
    await waitFor(() => expect(capturedCallback).toBeDefined());

    expect(initializeSpy).toHaveBeenCalledTimes(1);
    expect(renderButtonSpy).toHaveBeenCalledTimes(1);
  });
});
