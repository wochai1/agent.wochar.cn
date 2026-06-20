const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb, dbAll, dbGet, dbRun, addAuditLog, isValidName,
  readDbContent, writeDbContent, appendDbContent, deleteDbFile, listAllDbFiles,
  writeDbContentAsync } = require('../db');
const { requireAdmin } = require('./auth');

const router = express.Router();

// ===================== 登录/登出 =====================
router.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const admin = dbGet('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin) return res.status(401).json({ error: '用户名或密码错误' });
  if (!admin.initialized) return res.status(401).json({ error: '密码尚未初始化，请先设置密码' });
  if (!bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  req.session.adminId = admin.id;
  req.session.adminRole = admin.role;
  res.json({ ok: true, username: admin.username, role: admin.role, redirect: req.adminPath });
});

router.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ===================== 密码初始化 & 修改 =====================

// 检查管理员密码是否已初始化
router.get('/api/admin/check-init', (req, res) => {
  const admin = dbGet('SELECT id, initialized FROM admins WHERE role = ? LIMIT 1', ['super']);
  if (!admin) return res.json({ initialized: false, exists: false });
  // NULL 或 0 都算未初始化（兼容旧数据）
  res.json({ initialized: !!admin.initialized, exists: true });
});

// 首次设置密码（仅未初始化时可用）
router.post('/api/admin/setup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: '请输入用户名' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const admin = dbGet("SELECT * FROM admins WHERE role = 'super' AND (initialized IS NULL OR initialized = 0) LIMIT 1");
  if (!admin) return res.status(403).json({ error: '密码已初始化，请直接登录' });

  const hash = bcrypt.hashSync(password, 10);
  dbRun('UPDATE admins SET username = ?, password_hash = ?, initialized = 1 WHERE id = ?',
    [username.trim(), hash, admin.id]);
  addAuditLog(null, 'admin_setup', null, { username: username.trim() });
  res.json({ ok: true });
});

// 修改密码（需已登录）
router.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '请输入旧密码和新密码' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码至少6位' });

  const admin = dbGet('SELECT * FROM admins WHERE id = ?', [req.session.adminId]);
  if (!admin) return res.status(404).json({ error: '管理员不存在' });
  if (!bcrypt.compareSync(old_password, admin.password_hash)) {
    return res.status(403).json({ error: '旧密码错误' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  dbRun('UPDATE admins SET password_hash = ?, initialized = 1 WHERE id = ?',
    [hash, admin.id]);
  addAuditLog(null, 'admin_change_password', null, {});
  res.json({ ok: true });
});

// ===================== Agent 管理 =====================
router.get('/api/admin/agents', requireAdmin, (req, res) => {
  res.json(dbAll('SELECT * FROM agents ORDER BY created_at DESC'));
});

router.post('/api/admin/agents', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Agent 名称不能为空' });
  const id = uuidv4();
  const apiKey = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  dbRun('INSERT INTO agents (id, name, api_key) VALUES (?,?,?)', [id, name.trim(), apiKey]);
  addAuditLog(null, 'create_agent', null, { agent_id: id, name: name.trim() });

  // 自动创建私有数据库
  const privateName = name.trim() + '_私有';
  const privateId = uuidv4();
  dbRun('INSERT INTO databases (id, name, type, owner_agent_id) VALUES (?,?,?,?)',
    [privateId, privateName, 'private', id]);
  writeDbContent(privateName, '');
  addAuditLog(null, 'create_database', privateName, { type: 'private', owner_agent_id: id, auto: true });

  // 自动创建归属共享数据库
  const protectedName = name.trim() + '_共享';
  const protectedId = uuidv4();
  dbRun('INSERT INTO databases (id, name, type, owner_agent_id) VALUES (?,?,?,?)',
    [protectedId, protectedName, 'protected', id]);
  writeDbContent(protectedName, '');
  addAuditLog(null, 'create_database', protectedName, { type: 'protected', owner_agent_id: id, auto: true });

  res.json({ id, name: name.trim(), api_key: apiKey, enabled: 1,
    databases: [
      { name: privateName, type: 'private' },
      { name: protectedName, type: 'protected' }
    ]});
});

router.delete('/api/admin/agents/:id', requireAdmin, (req, res) => {
  const agent = dbGet('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Agent 不存在' });
  const privateDbs = dbAll('SELECT name FROM databases WHERE owner_agent_id = ?', [req.params.id]);
  privateDbs.forEach(d => deleteDbFile(d.name));
  dbRun('DELETE FROM databases WHERE owner_agent_id = ?', [req.params.id]);
  dbRun('DELETE FROM messages WHERE from_agent_id = ? OR to_agent_id = ?', [req.params.id, req.params.id]);
  dbRun('DELETE FROM agents WHERE id = ?', [req.params.id]);
  addAuditLog(null, 'delete_agent', null, { agent_id: req.params.id, name: agent.name });
  res.json({ ok: true });
});

router.patch('/api/admin/agents/:id/toggle', requireAdmin, (req, res) => {
  const agent = dbGet('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Agent 不存在' });
  const v = agent.enabled ? 0 : 1;
  dbRun('UPDATE agents SET enabled = ? WHERE id = ?', [v, req.params.id]);
  addAuditLog(null, v ? 'enable_agent' : 'disable_agent', null, { agent_id: req.params.id });
  res.json({ ok: true, enabled: !!v });
});

router.post('/api/admin/agents/:id/reset-key', requireAdmin, (req, res) => {
  const agent = dbGet('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Agent 不存在' });
  const newKey = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  dbRun('UPDATE agents SET api_key = ? WHERE id = ?', [newKey, req.params.id]);
  addAuditLog(null, 'reset_agent_key', null, { agent_id: req.params.id });
  res.json({ ok: true, api_key: newKey });
});

// ===================== 数据库管理 =====================
router.get('/api/admin/databases', requireAdmin, (req, res) => {
  // 从 SQLite 读取已注册的数据库
  const registered = dbAll('SELECT * FROM databases ORDER BY created_at DESC');
  const registeredNames = new Set(registered.map(d => d.name));

  // 扫描硬盘上所有 txt 文件，补上元数据丢失的
  const files = listAllDbFiles();
  for (const f of files) {
    if (!registeredNames.has(f.name)) {
      registered.push({
        id: 'orphan_' + f.name,
        name: f.name,
        type: 'shared',
        owner_agent_id: null,
        created_at: '未知',
        content_length: readDbContent(f.name).length
      });
    } else {
      const r = registered.find(d => d.name === f.name);
      r.content_length = readDbContent(f.name).length;
    }
  }
  res.json(registered);
});

router.post('/api/admin/databases', requireAdmin, (req, res) => {
  const { name, type, owner_agent_id } = req.body;
  if (!name || !isValidName(name)) return res.status(400).json({ error: '数据库名无效' });
  if (!['shared', 'private', 'readonly', 'keyed', 'protected'].includes(type)) return res.status(400).json({ error: '类型无效' });
  if (dbGet('SELECT id FROM databases WHERE name = ?', [name])) return res.status(400).json({ error: '数据库名已存在' });
  if ((type === 'private' || type === 'protected') && !owner_agent_id) return res.status(400).json({ error: '此类型数据库必须指定归属 Agent' });
  const id = uuidv4();
  const dbKey = type === 'keyed' ? uuidv4().replace(/-/g, '') : null;
  dbRun('INSERT INTO databases (id, name, type, owner_agent_id, db_key) VALUES (?,?,?,?,?)',
    [id, name, type, (type === 'private' || type === 'protected') ? owner_agent_id : null, dbKey]);
  writeDbContent(name, '');
  addAuditLog(null, 'create_database', name, { type, owner_agent_id });
  res.json({ id, name, type, owner_agent_id: (type === 'private' || type === 'protected') ? owner_agent_id : null, db_key: dbKey });
});

router.delete('/api/admin/databases/:id', requireAdmin, (req, res) => {
  // 支持删除孤儿数据库（id 以 orphan_ 开头）
  if (req.params.id.startsWith('orphan_')) {
    const dbName = req.params.id.replace('orphan_', '');
    deleteDbFile(dbName);
    addAuditLog(null, 'delete_database', dbName, { orphan: true });
    return res.json({ ok: true });
  }
  const dbMeta = dbGet('SELECT * FROM databases WHERE id = ?', [req.params.id]);
  if (!dbMeta) return res.status(404).json({ error: '数据库不存在' });
  deleteDbFile(dbMeta.name);
  dbRun('DELETE FROM databases WHERE id = ?', [req.params.id]);
  addAuditLog(null, 'delete_database', dbMeta.name, {});
  res.json({ ok: true });
});

// 重置 keyed 数据库的密钥
router.post('/api/admin/databases/:id/reset-key', requireAdmin, (req, res) => {
  const dbMeta = dbGet('SELECT * FROM databases WHERE id = ?', [req.params.id]);
  if (!dbMeta) return res.status(404).json({ error: '数据库不存在' });
  if (dbMeta.type !== 'keyed') return res.status(400).json({ error: '仅 keyed 类型支持此操作' });
  const newKey = uuidv4().replace(/-/g, '');
  dbRun('UPDATE databases SET db_key = ? WHERE id = ?', [newKey, req.params.id]);
  addAuditLog(null, 'reset_db_key', dbMeta.name, {});
  res.json({ ok: true, db_key: newKey });
});

router.get('/api/admin/db/:dbName/content', requireAdmin, (req, res) => {
  const { dbName } = req.params;
  if (!isValidName(dbName)) return res.status(400).json({ error: '数据库名无效' });
  const dbMeta = dbGet('SELECT * FROM databases WHERE name = ?', [dbName]);
  const type = dbMeta ? dbMeta.type : 'shared';
  res.json({ content: readDbContent(dbName), type, name: dbName });
});

router.post('/api/admin/db/:dbName/write', requireAdmin, async (req, res) => {
  const { dbName } = req.params;
  const { content } = req.body;
  if (!isValidName(dbName)) return res.status(400).json({ error: '数据库名无效' });
  await writeDbContentAsync(dbName, content || '');
  addAuditLog(null, 'write', dbName, { length: (content || '').length });
  res.json({ ok: true });
});

// ===================== 消息管理 =====================
router.get('/api/admin/messages', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM messages';
  const conds = [], params = [];
  if (from) { conds.push('from_agent_id = ?'); params.push(from); }
  if (to) { conds.push('to_agent_id = ?'); params.push(to); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json(dbAll(sql, params));
});

router.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM messages WHERE id = ?', [req.params.id]);
  addAuditLog(null, 'delete_message', null, { message_id: req.params.id });
  res.json({ ok: true });
});

// ===================== 论坛管理 =====================
router.get('/api/admin/forum/topics', requireAdmin, (req, res) => {
  const topics = dbAll(`SELECT t.*, (SELECT COUNT(*) FROM replies WHERE topic_id = t.id) as reply_count
    FROM topics t ORDER BY t.created_at DESC`);
  res.json(topics);
});

router.delete('/api/admin/forum/topics/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM replies WHERE topic_id = ?', [req.params.id]);
  dbRun('DELETE FROM topics WHERE id = ?', [req.params.id]);
  addAuditLog(null, 'forum_delete_topic', null, { topic_id: req.params.id });
  res.json({ ok: true });
});

router.delete('/api/admin/forum/replies/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM replies WHERE id = ?', [req.params.id]);
  addAuditLog(null, 'forum_delete_reply', null, { reply_id: req.params.id });
  res.json({ ok: true });
});

router.get('/api/admin/forum/replies/:topicId', requireAdmin, (req, res) => {
  res.json(dbAll('SELECT * FROM replies WHERE topic_id = ? ORDER BY created_at ASC', [req.params.topicId]));
});

// ===================== 审计日志 =====================
router.get('/api/admin/audit-logs', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(dbAll(`
    SELECT al.*, a.name as agent_name FROM audit_logs al
    LEFT JOIN agents a ON al.agent_id = a.id
    ORDER BY al.created_at DESC LIMIT ?`, [limit]));
});

module.exports = router;
