import { useRef } from "react";

/**
 * Gives focus back to whatever opened a modal when it closes.
 *
 * Radix returns focus on close ONLY to a <DialogTrigger>. Many of the CRM's dialogs (every confirmation, the input prompt, the
 * recipient pickers …) are controlled — opened from a handler, with no trigger element — so without this focus fell to <body>
 * and a keyboard or screen-reader user lost their place. The element focused at the moment the dialog mounts is remembered and
 * refocused on close. If there is nothing to return to (it was removed from the page meanwhile, e.g. the row it lived in was
 * deleted, or nothing was focused) Radix's own behaviour is left untouched, so a real <DialogTrigger> still works as before.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    /** Call from the content's onOpenAutoFocus — it runs before focus moves into the dialog. */
    remember() {
      const el = typeof document !== "undefined" ? document.activeElement : null;
      opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
    },
    /** Spread on the content's onCloseAutoFocus. */
    onCloseAutoFocus(event: Event) {
      const el = opener.current;
      opener.current = null;
      if (el && el.isConnected) {
        event.preventDefault(); // Radix would focus its (absent) trigger
        el.focus();
      }
    },
  };
}
