// Tables are created on first request, so no manual SQL step is needed.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT, name TEXT, plan TEXT DEFAULT 'free', until TEXT,
    ref_by INTEGER, joined TEXT, last_seen TEXT, phone TEXT, email TEXT, paid INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS users_ref ON users(ref_by)`,
  `CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, cat TEXT, name TEXT, descr TEXT, f TEXT, soft TEXT, size TEXT, n TEXT,
    tier INTEGER DEFAULT 0, val INTEGER DEFAULT 0, date TEXT, status TEXT DEFAULT 'live', shop INTEGER DEFAULT 0, brand TEXT, link TEXT, pass TEXT,
    file_id TEXT, file_type TEXT, preview_id TEXT, preview_type TEXT, img TEXT, src_chat INTEGER, src_msg INTEGER, src_group TEXT)`,
  `CREATE INDEX IF NOT EXISTS items_group ON items(src_group)`,
  `CREATE TABLE IF NOT EXISTS gets(user_id INTEGER, item_id INTEGER, at TEXT, PRIMARY KEY(user_id,item_id))`,
  `CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, at TEXT, kind TEXT, text TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_user ON events(user_id,id)`,
  `CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, method TEXT, plan TEXT, amount TEXT,
    status TEXT, charge_id TEXT, proof_file_id TEXT, via TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sources(chat_id INTEGER PRIMARY KEY, title TEXT, handle TEXT, kind TEXT DEFAULT 'own', on_post TEXT DEFAULT 'queue',
    sec TEXT DEFAULT 'auto', tier TEXT DEFAULT 'tag', ok INTEGER DEFAULT 1, last TEXT, count INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS broadcasts(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, btn TEXT, aud TEXT, send_at TEXT, status TEXT, reach INTEGER DEFAULT 0)`
];
