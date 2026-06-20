const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'data', 'platform.db');
const DATA_DIR = path.join(__dirname, 'data');
let SQL = null;
let db = null;

async function getDb() {
  if (db) return db;
  SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  initTables();
  createDefaultAdmin();
  return db;
}

// 原子写入：先写临时文件，再重命名，防止写入中途崩溃导致数据库损坏
function atomicWrite(filePath, data, encoding) {
  const tmpPath = filePath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmpPath, data, encoding);
  fs.renameSync(tmpPath, filePath);
}

function saveDb() {
  if (!db) return;
  try {
    atomicWrite(DB_PATH, Buffer.from(db.export()));
  } catch (e) {
    console.error('[DB] 保存 platform.db 失败:', e.message);
    // 失败时重试一次直接写入
    try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e2) {}
  }
}

function initTables() {
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'super',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS databases (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    type TEXT NOT NULL,
    owner_agent_id TEXT, db_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  try { db.run('ALTER TABLE databases ADD COLUMN db_key TEXT'); } catch(e) { /* 列已存在 */ }
  try { db.run('ALTER TABLE admins ADD COLUMN initialized INTEGER NOT NULL DEFAULT 1'); } catch(e) { /* 列已存在 */ }
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, from_agent_id TEXT NOT NULL, to_agent_id TEXT,
    content TEXT NOT NULL, read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, agent_id TEXT, action TEXT NOT NULL,
    db_name TEXT, payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '匿名用户', agent_id TEXT, views INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  try { db.run('ALTER TABLE topics ADD COLUMN agent_id TEXT'); } catch(e) { /* 列已存在 */ }
  db.run(`CREATE TABLE IF NOT EXISTS replies (
    id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '匿名用户', agent_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  try { db.run('ALTER TABLE replies ADD COLUMN agent_id TEXT'); } catch(e) { /* 列已存在 */ }
  saveDb();
}

function createDefaultAdmin() {
  const existing = dbGet('SELECT * FROM admins LIMIT 1');
  if (existing) {
    // 已有管理员：检测是否仍为旧默认密码 admin123，是则强制重新初始化
    if (existing.password_hash && bcrypt.compareSync('admin123', existing.password_hash)) {
      dbRun('UPDATE admins SET password_hash = ?, initialized = 0 WHERE id = ?', ['', existing.id]);
      console.log('检测到旧默认密码，已清除（详见下方启动信息）');
      return { initialized: false, password: null };
    }
    if (!existing.initialized) return { initialized: false, password: null };
    return { initialized: true, password: null };
  }
  // 生成随机密码并哈希存储
  const randomPassword = crypto.randomBytes(6).toString('base64url'); // ~8 chars
  const hash = bcrypt.hashSync(randomPassword, 10);
  db.run('INSERT INTO admins (id, username, password_hash, role, initialized) VALUES (?,?,?,?,?)',
    [uuidv4(), 'admin', hash, 'super', 1]);
  saveDb();
  return { initialized: true, password: randomPassword };
}

function dbRun(sql, params = []) { db.run(sql, params); saveDb(); return db; }
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}
function addAuditLog(agentId, action, dbName, payload) {
  db.run("INSERT INTO audit_logs (id, agent_id, action, db_name, payload, created_at) VALUES (?,?,?,?,?,datetime('now'))",
    [uuidv4(), agentId || null, action, dbName || null, JSON.stringify(payload || {})]);
  saveDb();
}
function isValidName(name) { return typeof name === 'string' && name.trim().length > 0 && !/[\\/:*?"<>|\.]/.test(name); }

function getDbFilePath(dbName) { return path.join(DATA_DIR, `${dbName}.txt`); }

// ===================== 文件锁（防止并发写入互相覆盖） =====================
// 锁结构: Map<fileName, { locked: boolean, queue: Function[] }>
const fileLocks = new Map();
const LOCK_TIMEOUT = 10000; // 10秒超时（文本文件通常毫秒级完成）

function acquireLock(fileName, dbName) {
  return new Promise((resolve, reject) => {
    const entry = fileLocks.get(fileName);
    if (!entry) {
      // 无人持有锁，立即获取
      fileLocks.set(fileName, { locked: true, queue: [] });
      resolve();
      return;
    }
    // 有人持有锁，排队
    const queuePos = entry.queue.length + 1; // 当前排队位置
    let timer = setTimeout(() => {
      const idx = entry.queue.indexOf(wrapped);
      if (idx >= 0) { entry.queue.splice(idx, 1); }
      const label = dbName || fileName.replace(/\.txt$/, '');
      reject(new Error(`数据库"${label}"正被其他 Agent 写入中，排队等待${LOCK_TIMEOUT/1000}秒仍未获取到写入权。建议：稍后重试，或检查是否有 Agent 异常占锁（长时间未释放）。当前队列长度: ${entry.queue.length}`));
    }, LOCK_TIMEOUT);
    function wrapped() {
      clearTimeout(timer);
      timer = null;
      resolve();
    }
    entry.queue.push(wrapped);
  });
}

function releaseLock(fileName) {
  const entry = fileLocks.get(fileName);
  if (!entry) return;
  if (entry.queue.length > 0) {
    // 还有等待者，交给下一个
    const next = entry.queue.shift();
    next();
    if (entry.queue.length === 0) {
      fileLocks.delete(fileName);
    }
  } else {
    // 无等待者，释放锁
    fileLocks.delete(fileName);
  }
}

// 带锁的原子写入
function writeDbContent(dbName, content) {
  const filePath = getDbFilePath(dbName);
  const str = String(content ?? '').replace(/^\uFEFF/, ''); // 移除 BOM
  atomicWrite(filePath, str, 'utf-8');
}

// 带锁的追加写入
function appendDbContent(dbName, content) {
  const filePath = getDbFilePath(dbName);
  const str = String(content ?? '').replace(/^\uFEFF/, '');
  // 追加写入：先读后写保证并发安全
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '') : '';
  atomicWrite(filePath, existing + str, 'utf-8');
}

// 读取数据库内容（自动去除 BOM）
function readDbContent(dbName) {
  const p = getDbFilePath(dbName);
  if (!fs.existsSync(p)) return '';
  const raw = fs.readFileSync(p, 'utf-8');
  return raw.replace(/^\uFEFF/, ''); // 去除 UTF-8 BOM
}

// 异步版本（带锁），供需要并发安全的场景使用
async function writeDbContentAsync(dbName, content) {
  const filePath = getDbFilePath(dbName);
  await acquireLock(filePath, dbName);
  try {
    writeDbContent(dbName, content);
  } finally {
    releaseLock(filePath);
  }
}

async function appendDbContentAsync(dbName, content) {
  const filePath = getDbFilePath(dbName);
  await acquireLock(filePath, dbName);
  try {
    appendDbContent(dbName, content);
  } finally {
    releaseLock(filePath);
  }
}

async function readDbContentAsync(dbName) {
  const filePath = getDbFilePath(dbName);
  await acquireLock(filePath, dbName);
  try {
    return readDbContent(dbName);
  } finally {
    releaseLock(filePath);
  }
}
function deleteDbFile(dbName) {
  const p = getDbFilePath(dbName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// 扫描 data 目录下所有 txt 文件（排除 platform.db）
function listAllDbFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ name: f.replace('.txt', ''), filePath: path.join(DATA_DIR, f) }));
}

module.exports = { getDb, saveDb, dbAll, dbGet, dbRun, addAuditLog, isValidName,
  readDbContent, writeDbContent, appendDbContent, deleteDbFile, listAllDbFiles, DB_PATH,
  readDbContentAsync, writeDbContentAsync, appendDbContentAsync, createDefaultAdmin };
