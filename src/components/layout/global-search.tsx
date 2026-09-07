"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { globalSearch, type GlobalSearchResult } from "@/server/queries/global-search";

const EMPTY: GlobalSearchResult = { contacts: [], leads: [], quotes: [], bookings: [] };

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult>(EMPTY);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      startTransition(async () => {
        const r = await globalSearch(query);
        setResults(r);
      });
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open]);

  function go(path: string) {
    setOpen(false);
    setQuery("");
    router.push(path);
  }

  const hasResults =
    results.contacts.length + results.leads.length + results.quotes.length + results.bookings.length > 0;

  return (
    <>
      <Button
        variant="outline"
        className="w-full min-w-0 max-w-sm justify-start text-muted-foreground font-normal h-9 gap-2"
        onClick={() => setOpen(true)}
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">
          <span className="sm:hidden">Search...</span>
          <span className="hidden sm:inline">Search leads, contacts, quotes...</span>
        </span>
        <kbd className="ml-auto hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
          Ctrl K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Global search" description="Search across Compass Tools">
        <CommandInput
          placeholder="Search customer name, phone, email, route, booking #..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {query.trim().length < 2 && (
            <CommandEmpty>Type at least 2 characters to search.</CommandEmpty>
          )}
          {query.trim().length >= 2 && !isPending && !hasResults && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}
          {results.leads.length > 0 && (
            <CommandGroup heading="Leads">
              {results.leads.map((r) => (
                <CommandItem key={r.id} onSelect={() => go(`/leads/${r.id}`)}>
                  <span className="font-medium">{r.label}</span>
                  <span className="ml-2 text-muted-foreground text-xs">{r.sublabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.contacts.length > 0 && (
            <CommandGroup heading="Contacts">
              {results.contacts.map((r) => (
                <CommandItem key={r.id} onSelect={() => go(`/contacts/${r.id}`)}>
                  <span className="font-medium">{r.label}</span>
                  <span className="ml-2 text-muted-foreground text-xs">{r.sublabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.quotes.length > 0 && (
            <CommandGroup heading="Quotes">
              {results.quotes.map((r) => (
                <CommandItem key={r.id} onSelect={() => go(`/quotes/${r.id}`)}>
                  <span className="font-medium">{r.label}</span>
                  <span className="ml-2 text-muted-foreground text-xs">{r.sublabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.bookings.length > 0 && (
            <CommandGroup heading="Bookings">
              {results.bookings.map((r) => (
                <CommandItem key={r.id} onSelect={() => go(`/bookings/${r.id}`)}>
                  <span className="font-medium">{r.label}</span>
                  <span className="ml-2 text-muted-foreground text-xs">{r.sublabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
