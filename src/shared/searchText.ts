import { RUN_STARTS, RUN_VALUES } from "./unicode61Table";

// Full-text search tokens, shared by the SQLite compiler (BooleanFilter), the in-memory evaluator
// and the browser (DSL validation). Tokens follow SQLite FTS5's `unicode61 remove_diacritics 2`
// tokenizer, which `messages_fts` uses, through a per-code-point table generated from SQLite
// itself (scripts/generate-unicode61-table.ts): letters and digits form tokens, case is folded,
// diacritics are dropped from Latin letters, and everything else separates tokens.

/** One indexed message: its searchable columns (subject, sender, body, attachment names). */
export type SearchDocument = ReadonlyArray<string>;

const SEPARATOR = 0x200000;
const DROPPED = 0x200001;

const runValue = (codePoint: number): number => {
  let low = 0;
  let high = RUN_STARTS.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (RUN_STARTS[middle]! <= codePoint) low = middle;
    else high = middle - 1;
  }
  return RUN_VALUES[low]!;
};

/** Splits text into folded search tokens, as FTS5 indexes and queries it. */
export const tokenizeSearchText = (text: string): ReadonlyArray<string> => {
  const tokens: string[] = [];
  let current = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    // ASCII letters and digits are the common case; skip the table for them.
    const value = codePoint < 0x80
      ? (codePoint >= 0x30 && codePoint <= 0x39) || (codePoint >= 0x61 && codePoint <= 0x7a) ? 0
        : codePoint >= 0x41 && codePoint <= 0x5a ? 0x20 : SEPARATOR
      : runValue(codePoint);
    if (value === SEPARATOR) {
      if (current) tokens.push(current);
      current = "";
    } else if (value !== DROPPED) {
      current += String.fromCodePoint(codePoint + value);
    }
  }
  if (current) tokens.push(current);
  return tokens;
};

/**
 * Whether a search value matches one message: its tokens must appear consecutively in one column,
 * each as the prefix of a word (a single token: the prefix of any word). Values without tokens
 * match nothing.
 */
export const documentMatchesSearch = (tokens: ReadonlyArray<string>, document: SearchDocument): boolean =>
  tokens.length > 0 && document.some((column) => {
    const words = tokenizeSearchText(column);
    for (let start = 0; start + tokens.length <= words.length; start += 1) {
      if (tokens.every((token, index) => words[start + index]!.startsWith(token))) return true;
    }
    return false;
  });

/** A thread matches a search when any of its messages does. */
export const threadMatchesSearch = (value: string, documents: ReadonlyArray<SearchDocument>): boolean => {
  const tokens = tokenizeSearchText(value);
  return documents.some((document) => documentMatchesSearch(tokens, document));
};

/**
 * The FTS5 MATCH query for a search value: a phrase of quoted prefix tokens (`"quart"* + "rep"*`).
 * Tokens hold only token characters, never quotes or FTS5 syntax. Null when there are no tokens.
 */
export const toFtsMatchQuery = (value: string): string | null => {
  const tokens = tokenizeSearchText(value);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"*`).join(" + ");
};
