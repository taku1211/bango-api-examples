import type { DatabaseSync } from 'node:sqlite';
import { applySnapshot, getCheckpoint, setCheckpoint, storePullPage, transaction } from './core.ts';
import { HistoryGap, MockBango } from './mock.ts';

export function pullAndRecover(db: DatabaseSync, api: MockBango): { recovered: boolean; inserted: number } {
  const cursor = getCheckpoint(db);
  if (cursor === null) throw new Error('initial checkpoint missing');
  try {
    return { recovered: false, inserted: storePullPage(db, api.pull(cursor)) };
  } catch (error) {
    if (!(error instanceof HistoryGap)) throw error;
    // Capture the new checkpoint BEFORE fetching baseline; persist both together.
    const freshCursor = api.startNow().next_cursor;
    const watches = api.listWatches();
    const baselines = watches.map(() => api.freshBaseline());
    transaction(db, () => {
      for (const { subject, current } of baselines) applySnapshot(db, subject, current);
      setCheckpoint(db, freshCursor);
    });
    const after = api.pull(freshCursor);
    return { recovered: true, inserted: storePullPage(db, after) };
  }
}
