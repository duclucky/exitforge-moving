import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id), provider TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(job,provider));
    CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, job TEXT NOT NULL, offer TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, paypal_order TEXT UNIQUE, capture TEXT UNIQUE, paid INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS allocations (id TEXT PRIMARY KEY, hold_id TEXT NOT NULL, date TEXT NOT NULL, resource TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id), provider TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(job,provider,id);
    CREATE TABLE IF NOT EXISTS message_reads (job TEXT NOT NULL, provider TEXT NOT NULL, user TEXT NOT NULL, last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job,provider,user));
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_links (
      token_hash TEXT PRIMARY KEY, hold_id TEXT NOT NULL REFERENCES holds(id), expires INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fulfillments (
      hold_id TEXT PRIMARY KEY REFERENCES holds(id), stage TEXT NOT NULL DEFAULT 'scheduled',
      started_at TEXT, reported_at TEXT, accepted_at TEXT, completed_at TEXT,
      operator_note TEXT NOT NULL DEFAULT '', customer_note TEXT NOT NULL DEFAULT '',
      balance_order TEXT UNIQUE, balance_capture TEXT UNIQUE, balance_paid INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS work_events (
      id INTEGER PRIMARY KEY, hold_id TEXT NOT NULL REFERENCES holds(id), actor TEXT NOT NULL,
      action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_settlements (
      hold_id TEXT PRIMARY KEY REFERENCES holds(id), provider TEXT NOT NULL, receiver TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, batch_key TEXT NOT NULL UNIQUE, item_key TEXT NOT NULL UNIQUE,
      batch_id TEXT UNIQUE, item_id TEXT UNIQUE, transaction_id TEXT UNIQUE,
      status TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(holds)').all().some(column => column.name === 'snapshot')) db.exec('ALTER TABLE holds ADD COLUMN snapshot TEXT');
  return db;
}
export const users = [
  { id: 'customer', name: 'Alex Morgan', role: 'customer', initials: 'AM' },
  { id: 'goodmove', name: 'GoodMove', role: 'provider', initials: 'GM', description: 'Apartment moves & careful handling' },
  { id: 'citycrew', name: 'City Crew', role: 'provider', initials: 'CC', description: 'Small moves, thoughtfully done' },
];
export const resources = [
  { id: 'gm-truck-1', name: 'Oak · 2-ton truck', kind: 'truck', provider: 'goodmove' },
  { id: 'gm-truck-2', name: 'Elm · 1-ton truck', kind: 'truck', provider: 'goodmove' },
  { id: 'gm-1', name: 'Jamie', kind: 'mover', provider: 'goodmove' },
  { id: 'gm-2', name: 'Sam', kind: 'mover', provider: 'goodmove' },
  { id: 'gm-3', name: 'Robin', kind: 'mover', provider: 'goodmove' },
  { id: 'cc-truck', name: 'City · 2-ton truck', kind: 'truck', provider: 'citycrew' },
  { id: 'cc-1', name: 'Taylor', kind: 'mover', provider: 'citycrew' },
  { id: 'cc-2', name: 'Casey', kind: 'mover', provider: 'citycrew' },
];
export function seed(db) {
  if (db.prepare('SELECT value FROM meta WHERE key=?').get('seeded')) return;
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const notes = 'Pickup building: service elevator available 09:00–10:00. Destination building: elevator available 11:00–12:00. Please protect the wooden desk. Everything is packed.';
  const jobs = [
    { id: 'move-101', title: 'A fresh start in Thao Dien', from: 'District 3, Ho Chi Minh City', to: 'Thao Dien, Ho Chi Minh City', date, size: '1-bedroom apartment', inventory: '12 packed boxes, 1 wooden desk, 2 chairs, 1 bookshelf', pickupStart: '09:00', pickupEnd: '10:00', dropStart: '11:00', dropEnd: '12:00', budget: 220, notes, status: 'open', sample: true, createdAt: new Date().toISOString() },
    { id: 'move-102', title: 'Make room for something new', from: 'Binh Thanh, Ho Chi Minh City', to: 'District 1, Ho Chi Minh City', date, size: 'Furniture only', inventory: '1 sofa, 1 coffee table, 4 packed boxes', pickupStart: '13:00', pickupEnd: '15:00', dropStart: '14:00', dropEnd: '17:00', budget: 150, notes: 'Ground-floor pickup. Destination elevator available 14:00–17:00.', status: 'open', sample: true, createdAt: new Date().toISOString() },
    { id: 'move-103', title: 'Moving my little home office', from: 'District 7, Ho Chi Minh City', to: 'District 4, Ho Chi Minh City', date, size: 'Studio apartment', inventory: '8 boxes, 1 desk, 1 office chair', pickupStart: '08:00', pickupEnd: '11:00', dropStart: '09:00', dropEnd: '13:00', budget: 180, notes: 'Use the loading entrance. Please bring moving blankets.', status: 'open', sample: true, createdAt: new Date().toISOString() },
  ];
  db.exec('BEGIN');
  for (const job of jobs) db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, 'customer', JSON.stringify(job));
  const offers = [
    { id: 'offer-gm-101', jobId: 'move-101', provider: 'goodmove', price: 180, deposit: 36, start: '09:00', loadMinutes: 60, travelMinutes: 45, unloadMinutes: 60, resources: ['gm-truck-1', 'gm-1', 'gm-2'], note: 'Two movers, a 2-ton truck and protective blankets. Access windows checked.', status: 'offered' },
    { id: 'offer-cc-101', jobId: 'move-101', provider: 'citycrew', price: 200, deposit: 40, start: '09:30', loadMinutes: 30, travelMinutes: 45, unloadMinutes: 30, resources: ['cc-truck', 'cc-1', 'cc-2'], note: 'A compact crew for your packed apartment. Merchant-estimated 30-minute loading and unloading.', status: 'offered' },
  ];
  for (const offer of offers) db.prepare('INSERT INTO offers VALUES (?,?,?,?)').run(offer.id, offer.jobId, offer.provider, JSON.stringify(offer));
  db.prepare('INSERT INTO meta VALUES (?,?)').run('seeded', date);
  db.exec('COMMIT');
}
