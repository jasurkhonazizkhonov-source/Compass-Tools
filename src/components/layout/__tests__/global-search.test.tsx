// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/test/rtl-setup";

// Regression: clicking the topbar search (or pressing Ctrl+K) used to replace the whole page with "This page couldn't load". Root cause: CommandDialog rendered
// cmdk's <CommandInput> without the <Command> that owns its store, so the first render threw ("reading 'subscribe'"). The second half is also covered here:
// results are filtered on the SERVER, so cmdk's own fuzzy filter must be off or it hides every hit that was matched on a field the label does not show
// (an email address, a phone number, an airport).

const globalSearch = vi.fn();
vi.mock("@/server/queries/global-search", () => ({ globalSearch: (q: string) => globalSearch(q) }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { GlobalSearch } from "../global-search";

const EMPTY = { contacts: [], leads: [], quotes: [], bookings: [] };
beforeEach(() => {
  globalSearch.mockReset().mockResolvedValue(EMPTY);
  push.mockReset();
});

const input = () => screen.findByPlaceholderText(/search customer name/i);

describe("GlobalSearch", () => {
  it("opens from the button without throwing, and focuses the input", async () => {
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    const el = await input();
    expect(el).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(el));
    expect(screen.getByText(/type at least 2 characters/i)).toBeTruthy();
  });

  it("opens with Ctrl+K and with Cmd+K, and Escape closes it", async () => {
    render(<GlobalSearch />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(await input()).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText(/search customer name/i)).toBeNull());
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await input()).toBeTruthy();
  });

  it("shows every returned group with the right heading, even when the typed text is not in the label (matched on email/phone/route)", async () => {
    globalSearch.mockResolvedValue({
      contacts: [{ id: "c1", label: "Ada Lovelace", sublabel: "ada@example.com" }],
      leads: [{ id: "l1", label: "Grace Hopper", sublabel: "JFK → LHR" }],
      quotes: [{ id: "q1", label: "Q-1001", sublabel: "Alan Turing" }],
      bookings: [{ id: "b1", label: "BK-77", sublabel: "Edsger Dijkstra" }],
    });
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(await input(), { target: { value: "ada@example" } });
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    // none of these labels contain the typed text - a client-side filter would have removed them
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("Q-1001")).toBeTruthy();
    expect(screen.getByText("BK-77")).toBeTruthy();
    for (const heading of ["Leads", "Contacts", "Quotes", "Bookings"]) expect(screen.getByText(heading)).toBeTruthy();
    expect(globalSearch).toHaveBeenLastCalledWith("ada@example");
  });

  it("selecting a result opens the right record and closes the dialog", async () => {
    globalSearch.mockResolvedValue({
      ...EMPTY,
      leads: [{ id: "l1", label: "Grace Hopper", sublabel: "JFK → LHR" }],
      quotes: [{ id: "q1", label: "Q-1001", sublabel: "Alan Turing" }],
    });
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(await input(), { target: { value: "gr" } });
    fireEvent.click(await screen.findByText("Q-1001"));
    expect(push).toHaveBeenCalledWith("/quotes/q1");
    await waitFor(() => expect(screen.queryByPlaceholderText(/search customer name/i)).toBeNull());
  });

  it("no results is handled", async () => {
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(await input(), { target: { value: "zzzz" } });
    expect(await screen.findByText(/no results found/i)).toBeTruthy();
  });

  it("a rejected search shows a message inside the dialog instead of crashing the page, and the next search works", async () => {
    globalSearch.mockRejectedValueOnce(new Error("network"));
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(await input(), { target: { value: "ada" } });
    expect(await screen.findByText(/search is unavailable/i)).toBeTruthy();
    globalSearch.mockResolvedValue({ ...EMPTY, contacts: [{ id: "c1", label: "Ada Lovelace", sublabel: "" }] });
    fireEvent.change(await input(), { target: { value: "adal" } });
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByText(/search is unavailable/i)).toBeNull();
  });

  it("a slow answer to an old query never overwrites the newer one", async () => {
    let releaseOld: (v: unknown) => void = () => {};
    globalSearch.mockImplementation((q: string) =>
      q === "ad" ? new Promise((r) => (releaseOld = r)) : Promise.resolve({ ...EMPTY, contacts: [{ id: "c2", label: "Newer Result", sublabel: "" }] })
    );
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.change(await input(), { target: { value: "ad" } });
    await waitFor(() => expect(globalSearch).toHaveBeenCalledWith("ad"));
    fireEvent.change(await input(), { target: { value: "ada" } });
    expect(await screen.findByText("Newer Result")).toBeTruthy();
    releaseOld({ ...EMPTY, contacts: [{ id: "c1", label: "Stale Result", sublabel: "" }] });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Stale Result")).toBeNull();
  });
});
