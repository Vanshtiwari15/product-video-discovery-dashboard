import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}
