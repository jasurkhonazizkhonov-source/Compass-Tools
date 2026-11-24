// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The REAL editor (TipTap in jsdom): it must actually appear (a version that rendered nothing passed every test that mocked it), show the toolbar, reflect the formatting at the cursor,
// and insert what the dialogs ask for.
// jsdom has no layout: ProseMirror asks for rectangles and the element under a point when it scrolls the cursor into view.
const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect;
Element.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
document.elementFromPoint = () => null;

const { RichTextEditor } = await import("../rich-text-editor");

const VARS = [
  { token: "{{contact_first_name}}", label: "Contact First Name", group: "Customer" },
  { token: "{{arrival_city}}", label: "Arrival City", group: "Travel" },
];

async function mount(value = "<p>Hello</p>", variables = VARS) {
  const onChange = vi.fn();
  render(<RichTextEditor value={value} onChange={onChange} variables={variables} />);
  await screen.findByTestId("email-editor");
  return { onChange };
}

describe("the editor appears and works", () => {
  it("renders the toolbar and an editable area with the starting content", async () => {
    await mount("<p>Hello <strong>world</strong></p>");
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough", "Text colour", "Highlight colour", "Align left", "Align centre", "Align right", "Bulleted list", "Numbered list", "Indent", "Outdent", "Quote", "Add or edit link", "Add image", "Add button", "Add divider", "Add space", "Undo", "Redo"]) {
      expect(within(toolbar).getByRole(name === "Text colour" || name === "Highlight colour" || name === "Add space" ? "button" : "button", { name }), name).toBeInTheDocument();
    }
    for (const name of ["Text style", "Font size", "Line spacing"]) expect(within(toolbar).getByRole("combobox", { name })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /Insert variable/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email content" }).textContent).toContain("Hello world");
  });

  it("the variable menu is only there when variables are supplied (campaigns have their own)", async () => {
    await mount("<p>x</p>", []);
    expect(screen.queryByRole("button", { name: /Insert variable/ })).toBeNull();
  });

  it("bold toggles on the selection and is reported as HTML; the button shows its state", async () => {
    const user = userEvent.setup();
    const { onChange } = await mount("<p>Hello</p>");
    const area = screen.getByRole("textbox", { name: "Email content" });
    await user.click(area);
    await user.keyboard("{Control>}a{/Control}");
    await user.click(screen.getByRole("button", { name: "Bold" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toContain("<strong>Hello</strong>");
    await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("the heading selector changes the block, and font size is applied as an inline style", async () => {
    const user = userEvent.setup();
    const { onChange } = await mount("<p>Title</p>");
    await user.click(screen.getByRole("textbox", { name: "Email content" }));
    await user.keyboard("{Control>}a{/Control}");
    await user.selectOptions(screen.getByRole("combobox", { name: "Text style" }), "h2");
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).toContain("<h2>Title</h2>"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Font size" }), "22px");
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).toMatch(/font-size:\s*22px/));
  });

  it("the Add button dialog validates, then inserts a call-to-action block", async () => {
    const user = userEvent.setup();
    const { onChange } = await mount("<p>Hi</p>");
    await user.click(screen.getByRole("textbox", { name: "Email content" }));
    await user.click(screen.getByRole("button", { name: "Add button" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Add button" })); // no address yet
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Enter a URL|full address/);
    await user.type(within(dialog).getByLabelText("Where it goes"), "javascript:alert(1)");
    await user.click(within(dialog).getByRole("button", { name: "Add button" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/full address starting with https/);
    await user.clear(within(dialog).getByLabelText("Where it goes"));
    await user.type(within(dialog).getByLabelText("Where it goes"), "https://example.com/book");
    await user.click(within(dialog).getByRole("button", { name: "Add button" }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).toContain('data-compass-block="button"'));
    expect(onChange.mock.calls.at(-1)![0]).toContain('href="https://example.com/book"');
  });

  it("the Add image dialog refuses a picture recipients could not see, asks for a description, and inserts a sized picture", async () => {
    const user = userEvent.setup();
    const { onChange } = await mount("<p>Hi</p>");
    await user.click(screen.getByRole("textbox", { name: "Email content" }));
    await user.click(screen.getByRole("button", { name: "Add image" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Image address"), "C:\\Users\\me\\a.png");
    await user.type(within(dialog).getByLabelText(/Description/), "A beach");
    await user.click(within(dialog).getByRole("button", { name: "Add image" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/public address starting with https/);
    await user.clear(within(dialog).getByLabelText("Image address"));
    await user.type(within(dialog).getByLabelText("Image address"), "https://cdn.example/a.png");
    await user.clear(within(dialog).getByLabelText(/Description/));
    await user.click(within(dialog).getByRole("button", { name: "Add image" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Describe the picture/);
    await user.type(within(dialog).getByLabelText(/Description/), "A beach");
    await user.type(within(dialog).getByLabelText(/Width/), "320");
    await user.click(within(dialog).getByRole("button", { name: "Add image" }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).toContain('src="https://cdn.example/a.png"'));
    const html = onChange.mock.calls.at(-1)![0] as string;
    expect(html).toContain('alt="A beach"');
    expect(html).toContain('width="320"');
  });

  it("the variable menu inserts the token at the cursor", async () => {
    const user = userEvent.setup();
    const { onChange } = await mount("<p>Hi </p>");
    await user.click(screen.getByRole("textbox", { name: "Email content" }));
    await user.click(screen.getByRole("button", { name: /Insert variable/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Contact First Name" }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).toContain("{{contact_first_name}}"));
  });

  it("the spacer menu inserts a spacer block", async () => {
    const user = userEvent.setup();
    const { onChange } = await mount("<p>Hi</p>");
    await user.click(screen.getByRole("textbox", { name: "Email content" }));
    await user.click(screen.getByRole("button", { name: "Add space" }));
    await user.click(await screen.findByRole("menuitem", { name: /Medium/ }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).toContain('data-compass-block="spacer"'));
  });
});
