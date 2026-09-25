// Inquiry messages can be up to 5,000 characters; lists show a short,
// single-line preview and the full text lives on the detail page.
export function messagePreview(message: string, max = 90): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max).trimEnd()}…` : oneLine;
}
