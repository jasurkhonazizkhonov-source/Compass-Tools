// First focusable element on every page with repeated navigation: lets keyboard and screen-reader users jump past the sidebar / header.
// Invisible until focused. The target is the <main id="main-content" tabIndex={-1}> of the layout.
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
  );
}
