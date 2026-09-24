import type { SessionEntry, SessionSnapshot, SessionUpdate } from '../session-types.js'

export function mergeEntries(previous: SessionEntry[], incoming: SessionEntry[]): SessionEntry[] {
  const entries = new Map(previous.map(entry => [entry.id, entry]))
  for (const entry of incoming) entries.set(entry.id, entry)
  return [...entries.values()].sort((a, b) => a.seq - b.seq)
}

export function mergeSession(previous: SessionSnapshot | null, update: SessionUpdate): SessionSnapshot {
  if (!previous || previous.bindingId !== update.bindingId || update.reset) return update
  if (update.cursor < previous.cursor) return previous
  return {
    ...update,
    entries: mergeEntries(previous.entries, update.entries),
    hasMore: previous.hasMore,
    beforeSeq: previous.beforeSeq,
  }
}

export function overlayPosition(x: number, y: number, width: number, height: number, petWidth: number) {
  return { x: x + petWidth / 2 - width / 2, y: y - height - 8 }
}
