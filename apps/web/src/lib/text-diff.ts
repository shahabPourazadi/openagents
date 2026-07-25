export type DiffSegment = {
  type: "equal" | "delete" | "insert";
  text: string;
};

function tokenizeWords(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

function pushSegment(
  segments: DiffSegment[],
  type: DiffSegment["type"],
  text: string
) {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === type) {
    last.text += text;
  } else {
    segments.push({ type, text });
  }
}

/** LCS-based token diff; merges adjacent same-type segments. */
function diffTokens(a: string[], b: string[]): DiffSegment[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pushSegment(segments, "equal", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSegment(segments, "delete", a[i]);
      i++;
    } else {
      pushSegment(segments, "insert", b[j]);
      j++;
    }
  }
  while (i < m) {
    pushSegment(segments, "delete", a[i]);
    i++;
  }
  while (j < n) {
    pushSegment(segments, "insert", b[j]);
    j++;
  }
  return segments;
}

/**
 * Fine-grained text diff for review UI.
 * Short single-line strings → character level; longer / multi-line → word level.
 */
export function diffTexts(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) {
    return oldText ? [{ type: "equal", text: oldText }] : [];
  }
  if (!oldText) return [{ type: "insert", text: newText }];
  if (!newText) return [{ type: "delete", text: oldText }];

  const short =
    oldText.length <= 240 &&
    newText.length <= 240 &&
    !oldText.includes("\n") &&
    !newText.includes("\n");

  const a = short ? Array.from(oldText) : tokenizeWords(oldText);
  const b = short ? Array.from(newText) : tokenizeWords(newText);
  return diffTokens(a, b);
}

/** Build marked preview string (DEL/INS) from a patch old→new pair. */
export function markedPatchReplacement(
  oldText: string,
  newText: string,
  suggestionId: string,
  delMark: (text: string, id: string) => string,
  insMark: (text: string, id: string) => string,
  actMark: (id: string) => string
): string {
  const segments = diffTexts(oldText, newText);
  let out = "";
  for (const seg of segments) {
    if (seg.type === "equal") out += seg.text;
    else if (seg.type === "delete") out += delMark(seg.text, suggestionId);
    else out += insMark(seg.text, suggestionId);
  }
  return out + actMark(suggestionId);
}
