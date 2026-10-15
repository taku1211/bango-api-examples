import { DatabaseSync } from 'node:sqlite';

export const CONSUMER = 'accounting-demo';

export type Snapshot = { company: unknown | null; invoice: unknown | null };
export type Subject = { id: string; version: string; corporate_number?: string | null };
export type ChangeEvent = {
  id: string;
  type: string;
  subject: Subject;
  data: { current: Snapshot };
};
export type BatchRow = {
  row_index: number;
  confidence: 'confident' | 'review' | 'unmatched';
  matched_corporate_number: string | null;
};
export type PullPage = {
  mode: 'incremental';
  data: ChangeEvent[];
  next_cursor: string;
};

export function openStore(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS partners (
      local_id TEXT PRIMARY KEY, input_name TEXT NOT NULL, confidence TEXT,
      corporate_number TEXT, subject_id TEXT, subject_version TEXT,
      company_json TEXT, invoice_json TEXT
    );
    CREATE TABLE IF NOT EXISTS subjects (
      consumer_id TEXT NOT NULL, subject_id TEXT NOT NULL, version TEXT NOT NULL,
      company_json TEXT NOT NULL, invoice_json TEXT NOT NULL,
      PRIMARY KEY (consumer_id, subject_id)
    );
    CREATE TABLE IF NOT EXISTS inbox (
      consumer_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL,
      outcome TEXT, PRIMARY KEY (consumer_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      consumer_id TEXT PRIMARY KEY, cursor TEXT NOT NULL
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^(0|[1-9][0-9]*)$/.test(version);
}

function validSnapshot(snapshot: unknown): snapshot is Snapshot {
  return !!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) &&
    Object.hasOwn(snapshot, 'company') && Object.hasOwn(snapshot, 'invoice') &&
    ((snapshot as Snapshot).company === null || (typeof (snapshot as Snapshot).company === 'object' && !Array.isArray((snapshot as Snapshot).company))) &&
    ((snapshot as Snapshot).invoice === null || (typeof (snapshot as Snapshot).invoice === 'object' && !Array.isArray((snapshot as Snapshot).invoice)));
}

export function validEvent(payload: unknown): payload is ChangeEvent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const e = payload as Partial<ChangeEvent>;
  return typeof e.id === 'string' && e.id.startsWith('evt_') &&
    typeof e.type === 'string' && typeof e.subject?.id === 'string' &&
    validVersion(e.subject.version) && validSnapshot(e.data?.current);
}

// These are example-side records, NOT BANGO's customer database.
export function addPartner(db: DatabaseSync, id: string, name: string): void {
  db.prepare('INSERT INTO partners (local_id,input_name) VALUES (?,?)').run(id, name);
}

export function acceptBatch(db: DatabaseSync, rows: BatchRow[]): void {
  transaction(db, () => {
    for (const row of rows) {
      const id = `partner-${row.row_index}`;
      // A confidence label is not a statistical probability; review is never auto-linked.
      const number = row.confidence === 'confident' ? row.matched_corporate_number : null;
      if (row.confidence === 'confident' && !number) throw new Error('confident missing corporate number');
      const result = db.prepare('UPDATE partners SET confidence=?,corporate_number=? WHERE local_id=?')
        .run(row.confidence, number, id);
      if (result.changes !== 1) throw new Error('missing partner row');
    }
  });
}

export function setCheckpoint(db: DatabaseSync, cursor: string, consumer = CONSUMER): void {
  if (!cursor) throw new Error('empty incremental cursor');
  db.prepare('INSERT INTO checkpoints (consumer_id,cursor) VALUES (?,?) ON CONFLICT (consumer_id) DO UPDATE SET cursor=excluded.cursor')
    .run(consumer, cursor);
}

export function getCheckpoint(db: DatabaseSync, consumer = CONSUMER): string | null {
  const row = db.prepare('SELECT cursor FROM checkpoints WHERE consumer_id=?').get(consumer) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

export function applySnapshot(db: DatabaseSync, subject: Subject, current: Snapshot, consumer = CONSUMER): boolean {
  if (!subject.id || !validVersion(subject.version) || !validSnapshot(current)) throw new Error('invalid snapshot');
  const existing = db.prepare('SELECT version FROM subjects WHERE consumer_id=? AND subject_id=?')
    .get(consumer, subject.id) as { version: string } | undefined;
  if (existing && BigInt(existing.version) >= BigInt(subject.version)) return false;
  const company = JSON.stringify(current.company);
  const invoice = JSON.stringify(current.invoice);
  db.prepare(`INSERT INTO subjects (consumer_id,subject_id,version,company_json,invoice_json)
    VALUES (?,?,?,?,?) ON CONFLICT (consumer_id,subject_id) DO UPDATE SET
    version=excluded.version, company_json=excluded.company_json, invoice_json=excluded.invoice_json`)
    .run(consumer, subject.id, subject.version, company, invoice);
  if (subject.corporate_number) {
    db.prepare(`UPDATE partners SET subject_id=?,subject_version=?,company_json=?,invoice_json=?
      WHERE corporate_number=? AND (subject_version IS NULL OR length(subject_version) < length(?) OR
      (length(subject_version) = length(?) AND subject_version < ?))`)
      .run(subject.id, subject.version, company, invoice, subject.corporate_number,
        subject.version, subject.version, subject.version);
  } else {
    // Individual subjects or deletion events may omit corporate_number.
    db.prepare(`UPDATE partners SET subject_version=?,company_json=?,invoice_json=?
      WHERE subject_id=? AND (subject_version IS NULL OR length(subject_version) < length(?) OR
      (length(subject_version) = length(?) AND subject_version < ?))`)
      .run(subject.version, company, invoice, subject.id, subject.version, subject.version, subject.version);
  }
  return true;
}

export function applyBaseline(db: DatabaseSync, subject: Subject, current: Snapshot): boolean {
  return transaction(db, () => applySnapshot(db, subject, current));
}

export function storeEvent(db: DatabaseSync, event: ChangeEvent, consumer = CONSUMER): boolean {
  if (!validEvent(event)) throw new Error('invalid event shape');
  return db.prepare('INSERT OR IGNORE INTO inbox (consumer_id,event_id,payload) VALUES (?,?,?)')
    .run(consumer, event.id, JSON.stringify(event)).changes === 1;
}

export function storePullPage(db: DatabaseSync, page: PullPage, consumer = CONSUMER): number {
  if (page.mode !== 'incremental' || !page.next_cursor || !Array.isArray(page.data)) throw new Error('incremental page required');
  return transaction(db, () => {
    let inserted = 0;
    for (const event of page.data) inserted += Number(storeEvent(db, event, consumer));
    setCheckpoint(db, page.next_cursor, consumer);
    return inserted;
  });
}

const supported = new Set([
  'company.updated', 'company.closed', 'company.deleted', 'company.restored',
  'invoice.updated', 'invoice.deleted', 'invoice.validity_changed',
]);

export function processInbox(db: DatabaseSync, consumer = CONSUMER): { applied: number; stale: number; unsupported: number } {
  const rows = db.prepare('SELECT event_id,payload FROM inbox WHERE consumer_id=? AND outcome IS NULL ORDER BY rowid')
    .all(consumer) as { event_id: string; payload: string }[];
  const result = { applied: 0, stale: 0, unsupported: 0 };
  for (const row of rows) {
    transaction(db, () => {
      const event = JSON.parse(row.payload) as ChangeEvent;
      const outcome = !supported.has(event.type) ? 'unsupported' :
        applySnapshot(db, event.subject, event.data.current, consumer) ? 'applied' : 'stale';
      db.prepare('UPDATE inbox SET outcome=? WHERE consumer_id=? AND event_id=?')
        .run(outcome, consumer, row.event_id);
      result[outcome as keyof typeof result]++;
    });
  }
  return result;
}

export function currentState(db: DatabaseSync): unknown {
  const partners = db.prepare('SELECT * FROM partners ORDER BY local_id').all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY subject_id').all();
  const inbox = db.prepare('SELECT event_id,outcome FROM inbox ORDER BY rowid').all();
  return { partners, subjects, inbox, checkpoint: getCheckpoint(db) };
}
