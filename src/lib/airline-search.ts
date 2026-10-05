// Pure helpers behind the airline picker's search (server/queries/reference-data.ts searchAirlines). Kept out of
// that "use server" module so they can be unit-tested and reused without becoming server actions.

const ACCENTED = "ÁÀÂÄÃÅĀĂĄÇĆČÐĎÉÈÊËĒĚĘÍÌÎÏĪŁŃŇÑÓÒÔÖÕØŌŘŚŠŞŤÚÙÛÜŪŮÝŸŹŽŻáàâäãåāăąçćčðďéèêëēěęíìîïīłńňñóòôöõøōřśšşťúùûüūůýÿźžż";

/** SQL-side fold map (use with translate(name, FROM, TO)): the same one-to-one accent -> ASCII mapping as foldAirlineText. */
export const AIRLINE_FOLD_FROM = ACCENTED;
export const AIRLINE_FOLD_TO = [...ACCENTED].map((ch) => foldChar(ch)).join("");

function foldChar(ch: string): string {
  const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
  if (/^[A-Za-z]$/.test(base)) return base;
  const special: Record<string, string> = { Ø: "O", ø: "o", Ł: "L", ł: "l", Ð: "D", ð: "d" };
  return special[ch] ?? ch;
}

/** Lower-cases and strips accents/diacritics ("Aeroméxico" -> "aeromexico", "Widerøe" -> "wideroe"), collapses spaces. */
export function foldAirlineText(text: string): string {
  return [...text.trim()]
    .map(foldChar)
    .join("")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Escapes LIKE wildcards for use with `ESCAPE '!'`. */
export function escapeLike(text: string): string {
  return text.replace(/[!%_]/g, (m) => `!${m}`);
}

export type RankableAirline = { id: number; iata: string | null; icao: string | null; name: string };

/**
 * Orders candidate airlines for a typed query, most certain first, so the intended carrier is on top and a
 * vague fragment can never push a precise match down:
 *   0 exact IATA code · 1 exact name · 2 exact ICAO code · 3 name starts with · 4 a word in the name starts with · 5 contains.
 * Ties prefer airlines that have an IATA code (the ones agents actually book), then the shorter name, then alphabetical.
 */
export function rankAirlineMatches<T extends RankableAirline>(rows: T[], query: string): T[] {
  const folded = foldAirlineText(query);
  const upper = query.trim().toUpperCase();
  const score = (a: T): number => {
    const name = foldAirlineText(a.name);
    if (a.iata && a.iata.toUpperCase() === upper) return 0;
    if (name === folded) return 1;
    if (a.icao && a.icao.toUpperCase() === upper) return 2;
    if (name.startsWith(folded)) return 3;
    if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(folded))) return 4;
    return 5;
  };
  return [...rows].sort((a, b) => {
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    const byIata = Number(!!b.iata) - Number(!!a.iata);
    if (byIata !== 0) return byIata;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name) || a.id - b.id;
  });
}
