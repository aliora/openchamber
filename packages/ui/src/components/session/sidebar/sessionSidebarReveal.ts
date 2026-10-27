export const revealAllSessions = (counts: ReadonlyMap<string, number>, containerKey: string): Map<string, number> => (
  new Map(counts).set(containerKey, Number.POSITIVE_INFINITY)
);
