const RRF_K = 60;

export function mergeWithRRF<T extends { messageId?: number; summaryId?: string }>(
  keywordResults: T[],
  vectorResults: T[],
  limit: number,
  idKey: "messageId" | "summaryId",
): T[] {
  const scores = new Map<number | string, number>();
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const id = keywordResults[rank][idKey];
    if (id != null) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const id = vectorResults[rank][idKey];
    if (id != null) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  const seen = new Set<number | string>();
  const merged: T[] = [];
  const all = [...keywordResults, ...vectorResults];
  for (const r of all) {
    const id = r[idKey];
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    merged.push(r);
  }
  merged.sort((a, b) => {
    const scoreA = scores.get(a[idKey]!) ?? 0;
    const scoreB = scores.get(b[idKey]!) ?? 0;
    return scoreB - scoreA;
  });
  return merged.slice(0, limit);
}
