export interface ParsedReviewFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  chunks: string[];
}

export interface ExcludedReviewFile {
  path: string;
  reason: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface ParsedReviewDiff {
  files: ParsedReviewFile[];
  excluded: ExcludedReviewFile[];
}

export function parseDiff(rawDiff: string): ParsedReviewDiff;
export function recommendedReviewerCount(totalLines: number, fileCount: number): number;
