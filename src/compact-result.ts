export interface CompactResultSummary {
  text: string;
  hidden: boolean;
}

function normalizeResultText(value: string): string {
  const text = value.trim();
  return text || "Done";
}

function compactResultText(fullText: string): CompactResultSummary {
  const lines = fullText.split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim())?.trim() || "Done";
  const text = firstLine.length > 180 ? `${firstLine.slice(0, 179).trimEnd()}…` : firstLine;
  return { text, hidden: lines.length > 1 || text !== fullText };
}

export function summarizeResultText(value: string, expanded: boolean): CompactResultSummary {
  const fullText = normalizeResultText(value);
  if (expanded) return { text: fullText, hidden: false };
  return compactResultText(fullText);
}
