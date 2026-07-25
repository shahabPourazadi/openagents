/** Markers used when attaching an editor selection to a chat message. */
export const QUOTE_HEADER = "Regarding this selected excerpt from the document:";

export function formatQuotedUserMessage(quote: string, prompt: string): string {
  const trimmedQuote = quote.trim();
  const trimmedPrompt = prompt.trim();
  return `${QUOTE_HEADER}\n\n"""\n${trimmedQuote}\n"""\n\n${trimmedPrompt}`;
}

export function parseQuotedUserMessage(content: string): {
  quote?: string;
  prompt: string;
} {
  if (!content.startsWith(QUOTE_HEADER)) {
    return { prompt: content };
  }
  const match = content.match(
    /^Regarding this selected excerpt from the document:\n\n"""\n([\s\S]*?)\n"""\n\n([\s\S]*)$/
  );
  if (!match) return { prompt: content };
  return { quote: match[1], prompt: match[2] };
}
