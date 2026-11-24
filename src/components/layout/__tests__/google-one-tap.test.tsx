// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@/test/rtl-setup";

// Google's official account suggestion (One Tap) beside the existing "Continue with Google" button. Google's SDK is replaced by a recording fake; what is proven here is WHAT WE ASK
// of it, when we do NOT ask, that every way it can be unavailable leaves the button working, and that the suggestion and the button take the SAME verified path.
const h = vi.hoisted(() => ({
  config: undefined as undefined | Record<string, unknown>,
  prompt: vi.fn(),
  cancel: vi.fn(),
  renderButton: vi.fn(),
  moment: undefined as undefined | ((m: unknown) => void),
  signIn: vi.fn(),
  nonce: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/script", () => ({ default: ({ onReady }: { onReady?: () => void }) => (onReady?.(), null) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => h.toastError(...a) } }));
vi.mock("@/server/actions/google-auth", () => ({ signInWithGoogle: (...a: [string]) => h.signIn(...a), getGoogleLoginNonce: () => h.nonce() }));

const { GoogleSignInButton } = await import("../google-sign-in-button");
const { ONE_TAP_COOLDOWN_MS, ONE_TAP_DISMISSED_KEY } = await import("@/lib/google-one-tap");

function installGoogle(over: { prompt?: unknown; noPrompt?: boolean } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).google = {
    accounts: {
      id: {
        initialize: (config: Record<string, unknown>) => {
          h.config = config;
        },
        renderButton: h.renderButton,
        ...(over.noPrompt ? {} : { prompt: over.prompt ?? h.prompt }),
        cancel: h.cancel,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config = undefined;
  h.moment = undefined;
  h.nonce.mockResolvedValue("nonce-for-this-browser");
  h.prompt.mockImplementation((listener: (m: unknown) => void) => {
    h.moment = listener;
  });
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  installGoogle();
});

const mount = async () => {
  render(<GoogleSignInButton clientId="client-123.apps.googleusercontent.com" />);
  await waitFor(() => expect(h.config).toBeDefined());
};

describe("what we ask Google for", () => {
  it("initialises with the login nonce, no automatic sign-in, FedCM, and the sign-in context - and asks for the suggestion once, AFTER the button is drawn", async () => {
    await mount();
    expect(h.config).toMatchObject({ client_id: "client-123.apps.googleusercontent.com", nonce: "nonce-for-this-browser", auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: true, itp_support: true, context: "signin" });
    expect(h.renderButton).toHaveBeenCalledTimes(1);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.renderButton.mock.invocationCallOrder[0]).toBeLessThan(h.prompt.mock.invocationCallOrder[0]);
  });

  it("the existing 'Continue with Google' button is still drawn (the suggestion is additional, never a replacement)", async () => {
    await mount();
    expect(h.renderButton.mock.calls[0][1]).toMatchObject({ type: "standard", text: "continue_with", shape: "pill" });
  });

  it("nothing is requested until the nonce binding exists (a suggestion without it could never be verified)", async () => {
    let release!: (n: string) => void;
    h.nonce.mockReturnValue(new Promise<string>((r) => (release = r)));
    render(<GoogleSignInButton clientId="c" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.config).toBeUndefined();
    expect(h.prompt).not.toHaveBeenCalled();
    await act(async () => release("n"));
    await waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(1));
  });
});

describe("when we do NOT ask", () => {
  it("not for a day after the person closed it", async () => {
    window.localStorage.setItem(ONE_TAP_DISMISSED_KEY, String(Date.now() - ONE_TAP_COOLDOWN_MS + 60_000));
    await mount();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.renderButton).toHaveBeenCalledTimes(1); // the button is unaffected
  });

  it("again after the cooldown has passed (a returning visitor)", async () => {
    window.localStorage.setItem(ONE_TAP_DISMISSED_KEY, String(Date.now() - ONE_TAP_COOLDOWN_MS - 60_000));
    await mount();
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("not in a background tab", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await mount();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.renderButton).toHaveBeenCalledTimes(1);
  });
});

describe("what happens to the suggestion", () => {
  it("closing it is remembered (so it is not shown again for a day)", async () => {
    await mount();
    act(() => h.moment!({ isDismissedMoment: () => true, isNotDisplayed: () => false, isSkippedMoment: () => false }));
    expect(Number(window.localStorage.getItem(ONE_TAP_DISMISSED_KEY))).toBeGreaterThan(Date.now() - 5_000);
  });

  it.each([
    ["not displayed (no Google account, privacy settings, Google's own cooldown)", { isDismissedMoment: () => false, isNotDisplayed: () => true, isSkippedMoment: () => false }],
    ["skipped", { isDismissedMoment: () => false, isNotDisplayed: () => false, isSkippedMoment: () => true }],
    ["a moment API Google no longer supports under FedCM (methods missing)", {}],
    ["a moment API that throws", { isDismissedMoment: () => { throw new Error("not supported under FedCM"); } }],
  ])("%s: no error is shown, nothing is stored, the button stays", async (_name, moment) => {
    await mount();
    act(() => h.moment!(moment));
    expect(window.localStorage.getItem(ONE_TAP_DISMISSED_KEY)).toBeNull();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.renderButton).toHaveBeenCalledTimes(1);
  });
});

describe("unavailable or restricted environments never break the sign-in page", () => {
  it("an older SDK without prompt(): the button is still drawn", async () => {
    installGoogle({ noPrompt: true });
    await mount();
    expect(h.renderButton).toHaveBeenCalledTimes(1);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("prompt() throwing (FedCM unavailable, blocked by the browser): swallowed, the button works", async () => {
    installGoogle({ prompt: () => { throw new Error("FedCM is disabled"); } });
    await mount();
    expect(h.renderButton).toHaveBeenCalledTimes(1);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("browser storage blocked (private window): the suggestion is still requested, it just has no memory", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    await mount();
    spy.mockRestore();
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("closing it with storage blocked does not throw", async () => {
    await mount();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => act(() => h.moment!({ isDismissedMoment: () => true }))).not.toThrow();
    spy.mockRestore();
  });
});

describe("one verified path for the button and the suggestion", () => {
  it("choosing the suggested account sends ONLY Google's credential to the server (never a name, e-mail or picture), takes the suggestion down, and signs in once", async () => {
    h.signIn.mockResolvedValue({ ok: true });
    await mount();
    await act(async () => {
      (h.config!.callback as (r: unknown) => void)({ credential: "google-id-token", select_by: "user", name: "Mallory", email: "admin@example.com", picture: "https://x" });
    });
    expect(h.signIn).toHaveBeenCalledTimes(1);
    expect(h.signIn).toHaveBeenCalledWith("google-id-token"); // exactly one argument: the credential
    expect(h.cancel).toHaveBeenCalled();
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/dashboard"));
  });

  it("a second credential while the first is being verified (a double tap) is ignored", async () => {
    let finish!: (v: unknown) => void;
    h.signIn.mockReturnValue(new Promise((r) => (finish = r)));
    await mount();
    const callback = h.config!.callback as (r: unknown) => void;
    await act(async () => {
      callback({ credential: "a" });
      callback({ credential: "b" });
    });
    expect(h.signIn).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
  });

  it.each([
    ["an invalid, expired, wrong-audience or replayed credential (the server answers GOOGLE_VERIFICATION_FAILED)", { ok: false, reason: "GOOGLE_VERIFICATION_FAILED" }, /could not be completed/],
    ["a token with the wrong nonce (also GOOGLE_VERIFICATION_FAILED: the server does not say which check failed)", { ok: false, reason: "GOOGLE_VERIFICATION_FAILED" }, /could not be completed/],
    ["too many failed attempts", { ok: false, reason: "RATE_LIMITED", message: "Too many failed sign-in attempts. Please try again in 7 minutes." }, /Too many failed sign-in attempts/],
    ["a server problem", { ok: false, reason: "SERVER_ERROR" }, /could not complete sign-in/],
  ])("%s: an inline, retryable message and no navigation", async (_name, result, message) => {
    h.signIn.mockResolvedValue(result);
    await mount();
    await act(async () => {
      (h.config!.callback as (r: unknown) => void)({ credential: "t" });
    });
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(message)));
    expect(h.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Signing in…")).toBeNull(); // back to a usable state
  });

  it("an authorisation denial (no CRM account for this Google account) goes to the access-denied page, exactly as for the button", async () => {
    h.signIn.mockResolvedValue({ ok: false, reason: "ACCESS_DENIED" });
    await mount();
    await act(async () => {
      (h.config!.callback as (r: unknown) => void)({ credential: "t" });
    });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/access-denied?reason=ACCESS_DENIED"));
  });

  it("leaving the page takes the suggestion down", async () => {
    const { unmount } = render(<GoogleSignInButton clientId="c" />);
    await waitFor(() => expect(h.config).toBeDefined());
    h.cancel.mockClear();
    unmount();
    expect(h.cancel).toHaveBeenCalled();
  });
});
