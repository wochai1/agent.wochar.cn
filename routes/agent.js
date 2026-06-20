const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, dbAll, dbGet, dbRun, addAuditLog, isValidName,
  readDbContent, writeDbContent, appendDbContent, deleteDbFile,
  writeDbContentAsync, appendDbContentAsync } = require('../db');
const { requireAgent } = require('./auth');

const router = express.Router();

function canWrite(agent, dbMeta) {
  if (dbMeta.type === 'shared') return true;
  if (dbMeta.type === 'keyed') return true;
  if (dbMeta.type === 'private' || dbMeta.type === 'protected') {
    return dbMeta.owner_agent_id === agent.id;
  }
  return false;
}

function canRead(agent, dbMeta) {
  if (dbMeta.type === 'shared' || dbMeta.type === 'readonly') return true;
  if (dbMeta.type === 'keyed') return true; // 读也需要验钥，在 checkDbAccess 中检查
  if (dbMeta.type === 'protected') return true;  // 共享读
  if (dbMeta.type === 'private' && dbMeta.owner_agent_id === agent.id) return true;
  return false;
}

function checkDbAccess(agent, dbName, requireWrite, dbKey) {
  if (!isValidName(dbName)) throw { status: 400, message: '数据库名无效' };
  const dbMeta = dbGet('SELECT * FROM databases WHERE name = ?', [dbName]);
  if (!dbMeta) throw { status: 404, message: '数据库不存在' };
  if (requireWrite) {
    if (!canWrite(agent, dbMeta)) throw { status: 403, message: '无写入权限' };
    if (dbMeta.type === 'keyed' && dbMeta.db_key !== dbKey) throw { status: 403, message: '密钥错误，无写入权限' };
  }
  if (!requireWrite) {
    if (!canRead(agent, dbMeta)) throw { status: 403, message: '无读取权限' };
    // 密钥保护的数据库，读取也需要校验密钥
    if (dbMeta.type === 'keyed' && dbMeta.db_key !== dbKey) throw { status: 403, message: '密钥错误，无读取权限' };
  }
  return dbMeta;
}

// ===================== 工具函数 =====================

// 获取收件箱摘要（未读数 + 最近5条未读消息），附加到响应中
function attachInbox(agentId, result) {
  try {
    const unreadCount = (dbGet(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE (to_agent_id = ? OR to_agent_id IS NULL) AND read_at IS NULL AND from_agent_id != ?`,
      [agentId, agentId]
    ) || {}).cnt || 0;
    const recent = dbAll(
      `SELECT m.id, m.content, m.created_at, a.name as from_name FROM messages m
       LEFT JOIN agents a ON m.from_agent_id = a.id
       WHERE (m.to_agent_id = ? OR m.to_agent_id IS NULL) AND m.read_at IS NULL AND m.from_agent_id != ?
       ORDER BY m.created_at DESC LIMIT 5`,
      [agentId, agentId]
    );
    return { ...result, inbox: { unread: unreadCount, messages: recent } };
  } catch {
    return { ...result, inbox: { unread: 0, messages: [] } };
  }
}

// ===================== 数据库操作 =====================

// Agent 自行创建数据库（归属自己，类型默认 shared）
router.post('/agent/db', requireAgent, (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !isValidName(name)) return res.status(400).json({ error: '数据库名无效' });
    const allowedTypes = ['shared', 'keyed', 'protected', 'private'];
    const dbType = allowedTypes.includes(type) ? type : 'shared';
    if (dbGet('SELECT id FROM databases WHERE name = ?', [name])) return res.status(400).json({ error: '数据库名已存在' });
    const id = uuidv4();
    // 每个 Agent 最多创建 8 个数据库（含自动分配的 _私有/_共享）
    const agentDbCount = dbGet('SELECT COUNT(*) as cnt FROM databases WHERE owner_agent_id = ?', [req.agent.id]);
    if (agentDbCount && agentDbCount.cnt >= 8) return res.status(400).json({ error: '每个 Agent 最多创建 8 个数据库' });
    const dbKey = dbType === 'keyed' ? uuidv4().replace(/-/g, '') : null;
    dbRun('INSERT INTO databases (id, name, type, owner_agent_id, db_key) VALUES (?,?,?,?,?)',
      [id, name, dbType, req.agent.id, dbKey]);
    writeDbContent(name, '');
    addAuditLog(req.agent.id, 'create_database', name, { type: dbType, by_agent: true });
    res.json({ id, name, type: dbType, db_key: dbKey });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 列出本 Agent 可见的数据库
router.get('/agent/databases', requireAgent, (req, res) => {
  const agent = req.agent;
  const all = dbAll('SELECT * FROM databases ORDER BY type, name');
  const visible = all.filter(d => canRead(agent, d)).map(d => ({
    name: d.name,
    type: d.type,
    can_write: canWrite(agent, d),
    is_owner: d.type === 'private' || d.type === 'protected' ? d.owner_agent_id === agent.id : null,
    content_length: readDbContent(d.name).length
  }));
  res.json(attachInbox(agent.id, { agent_name: agent.name, databases: visible }));
});

// 读取数据库内容（GET 方式，中文名需 URL 编码）
router.get('/agent/db/:dbName/read', requireAgent, (req, res) => {
  try {
    const { dbName } = req.params;
    checkDbAccess(req.agent, dbName, false, req.headers['x-db-key']);
    const content = readDbContent(dbName);
    addAuditLog(req.agent.id, 'read', dbName, { length: content.length });
    res.json(attachInbox(req.agent.id, { content, db_name: dbName }));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 读取数据库内容（POST 方式，推荐。数据库名放 body，无 URL 编码问题）
router.post('/agent/db/read', requireAgent, (req, res) => {
  try {
    const { db_name } = req.body;
    if (!db_name) return res.status(400).json({ error: '缺少 db_name 参数' });
    checkDbAccess(req.agent, db_name, false, req.headers['x-db-key']);
    const content = readDbContent(db_name);
    addAuditLog(req.agent.id, 'read', db_name, { length: content.length });
    res.json(attachInbox(req.agent.id, { content, db_name }));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 覆盖写入（URL 方式）
router.post('/agent/db/:dbName/write', requireAgent, async (req, res) => {
  try {
    const { dbName } = req.params;
    const { content } = req.body;
    checkDbAccess(req.agent, dbName, true, req.headers['x-db-key']);
    await writeDbContentAsync(dbName, String(content ?? ''));
    addAuditLog(req.agent.id, 'write', dbName, { length: (content || '').length });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 覆盖写入（POST body 方式，推荐）
router.post('/agent/db/write', requireAgent, async (req, res) => {
  try {
    const { db_name, content } = req.body;
    if (!db_name) return res.status(400).json({ error: '缺少 db_name 参数' });
    checkDbAccess(req.agent, db_name, true, req.headers['x-db-key']);
    await writeDbContentAsync(db_name, String(content ?? ''));
    addAuditLog(req.agent.id, 'write', db_name, { length: (content || '').length });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 追加写入（URL 方式）
router.post('/agent/db/:dbName/append', requireAgent, async (req, res) => {
  try {
    const { dbName } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    checkDbAccess(req.agent, dbName, true, req.headers['x-db-key']);
    await appendDbContentAsync(dbName, String(content));
    addAuditLog(req.agent.id, 'append', dbName, { length: content.length });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 追加写入（POST body 方式，推荐）
router.post('/agent/db/append', requireAgent, async (req, res) => {
  try {
    const { db_name, content } = req.body;
    if (!db_name) return res.status(400).json({ error: '缺少 db_name 参数' });
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    checkDbAccess(req.agent, db_name, true, req.headers['x-db-key']);
    await appendDbContentAsync(db_name, String(content));
    addAuditLog(req.agent.id, 'append', db_name, { length: content.length });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// 删除数据库（仅自己创建的可删除，keyed额外需密钥）
router.delete('/agent/db/:dbName', requireAgent, (req, res) => {
  try {
    const { dbName } = req.params;
    if (!isValidName(dbName)) return res.status(400).json({ error: '数据库名无效' });
    const dbMeta = dbGet('SELECT * FROM databases WHERE name = ?', [dbName]);
    if (!dbMeta) return res.status(404).json({ error: '数据库不存在' });
    // 只有归属者可以删除
    if (dbMeta.owner_agent_id !== req.agent.id) return res.status(403).json({ error: '只能删除自己创建的数据库' });
    // keyed 类型额外验证密钥
    if (dbMeta.type === 'keyed' && dbMeta.db_key !== req.headers['x-db-key']) return res.status(403).json({ error: '密钥错误' });
    deleteDbFile(dbName);
    dbRun('DELETE FROM databases WHERE id = ?', [dbMeta.id]);
    addAuditLog(req.agent.id, 'delete_database', dbName, { type: dbMeta.type });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || e.toString() });
  }
});

// ===================== 消息通信 =====================
router.post('/agent/messages', requireAgent, (req, res) => {
  const { to_agent_id, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '消息内容不能为空' });
  if (content.length > 6000) return res.status(400).json({ error: '消息内容不能超过6000字' });
  if (to_agent_id) {
    const target = dbGet('SELECT id FROM agents WHERE id = ? AND enabled = 1', [to_agent_id]);
    if (!target) return res.status(404).json({ error: '目标 Agent 不存在或已禁用' });
  }
  const id = uuidv4();
  dbRun('INSERT INTO messages (id, from_agent_id, to_agent_id, content) VALUES (?,?,?,?)',
    [id, req.agent.id, to_agent_id || null, content.trim()]);
  addAuditLog(req.agent.id, 'send_message', null, { message_id: id, to_agent_id });
  res.json({ id, ok: true });
});

router.get('/agent/messages/inbox', requireAgent, (req, res) => {
  const msgs = dbAll(
    `SELECT m.*, a.name as from_name FROM messages m
     LEFT JOIN agents a ON m.from_agent_id = a.id
     WHERE m.to_agent_id = ? OR m.to_agent_id IS NULL
     ORDER BY CASE WHEN m.read_at IS NULL THEN 0 ELSE 1 END, m.created_at DESC LIMIT 200`,
    [req.agent.id]);
  res.json({ messages: msgs });
});

router.get('/agent/messages/sent', requireAgent, (req, res) => {
  const msgs = dbAll(
    `SELECT m.*, a.name as to_name FROM messages m
     LEFT JOIN agents a ON m.to_agent_id = a.id
     WHERE m.from_agent_id = ? ORDER BY m.created_at DESC LIMIT 200`,
    [req.agent.id]);
  res.json({ messages: msgs });
});

router.get('/agent/messages/with/:agentId', requireAgent, (req, res) => {
  const msgs = dbAll(
    `SELECT * FROM messages
     WHERE (from_agent_id = ? AND to_agent_id = ?) OR (from_agent_id = ? AND to_agent_id = ?)
     ORDER BY created_at ASC LIMIT 200`,
    [req.agent.id, req.params.agentId, req.params.agentId, req.agent.id]);
  res.json(msgs);
});

router.post('/agent/messages/:id/read', requireAgent, (req, res) => {
  dbRun("UPDATE messages SET read_at = datetime('now') WHERE id = ? AND (to_agent_id = ? OR to_agent_id IS NULL)",
    [req.params.id, req.agent.id]);
  res.json({ ok: true });
});

// 删除自己收/发的消息
router.delete('/agent/messages/:id', requireAgent, (req, res) => {
  const msg = dbGet('SELECT * FROM messages WHERE id = ? AND (from_agent_id = ? OR to_agent_id = ? OR to_agent_id IS NULL)',
    [req.params.id, req.agent.id, req.agent.id]);
  if (!msg) return res.status(404).json({ error: '消息不存在或无权删除' });
  dbRun('DELETE FROM messages WHERE id = ?', [req.params.id]);
  addAuditLog(req.agent.id, 'delete_message', null, { message_id: req.params.id });
  res.json({ ok: true });
});

// 标记所有收件箱消息为已读
router.post('/agent/messages/read-all', requireAgent, (req, res) => {
  dbRun("UPDATE messages SET read_at = datetime('now') WHERE (to_agent_id = ? OR to_agent_id IS NULL) AND read_at IS NULL",
    [req.agent.id]);
  res.json({ ok: true });
});

router.get('/agent/agents', requireAgent, (req, res) => {
  res.json(attachInbox(req.agent.id, { agents: dbAll('SELECT id, name, enabled, created_at FROM agents') }));
});

module.exports = router;
