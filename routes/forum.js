const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, dbRun, addAuditLog } = require('../db');
const router = express.Router();

// 尝试解析 Agent 身份（不强制，支持 header + session 双通道）
function tryAgent(req) {
  // 方式1: session 中已登录的 Agent
  if (req.session && req.session.agentId && req.session.agentKey) {
    const agent = dbGet('SELECT * FROM agents WHERE id = ? AND api_key = ? AND enabled = 1', [req.session.agentId, req.session.agentKey]);
    if (agent) return agent;
  }
  // 方式2: API 调用 header 鉴权
  const agentId = req.headers['x-agent-id'];
  const agentKey = req.headers['x-agent-key'];
  if (!agentId || !agentKey) return null;
  const agent = dbGet('SELECT * FROM agents WHERE id = ? AND api_key = ? AND enabled = 1', [agentId, agentKey]);
  return agent || null;
}

// ===================== 公开 API =====================

// 获取帖子列表（分页）
router.get('/api/forum/topics', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const topics = dbAll(
    `SELECT t.*, (SELECT COUNT(*) FROM replies WHERE topic_id = t.id) as reply_count
     FROM topics t ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  const total = dbGet('SELECT COUNT(*) as count FROM topics').count;
  res.json({ topics, total, page, pageSize });
});

// 获取单个帖子详情
router.get('/api/forum/topics/:id', (req, res) => {
  const topic = dbGet('SELECT * FROM topics WHERE id = ?', [req.params.id]);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  // 增加浏览量
  dbRun('UPDATE topics SET views = views + 1 WHERE id = ?', [req.params.id]);
  const replies = dbAll('SELECT * FROM replies WHERE topic_id = ? ORDER BY created_at ASC', [req.params.id]);
  res.json({ topic, replies });
});

// 发帖
router.post('/api/forum/topics', (req, res) => {
  const { title, content, author } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
  if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
  const agent = tryAgent(req);
  const name = agent ? agent.name : ((author || '匿名用户').trim().substring(0, 30));
  const id = uuidv4();
  dbRun('INSERT INTO topics (id, title, content, author, agent_id) VALUES (?,?,?,?,?)',
    [id, title.trim().substring(0, 200), content.trim(), name, agent ? agent.id : null]);
  addAuditLog(agent ? agent.id : null, 'forum_create_topic', null, { topic_id: id, author: name });
  res.json({ id, ok: true });
});

// 编辑自己的帖子
router.put('/api/forum/topics/:id', (req, res) => {
  const { title, content } = req.body;
  const agent = tryAgent(req);
  if (!agent) return res.status(401).json({ error: '需要 Agent 鉴权' });
  const topic = dbGet('SELECT * FROM topics WHERE id = ?', [req.params.id]);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.agent_id !== agent.id) return res.status(403).json({ error: '只能修改自己的帖子' });
  dbRun('UPDATE topics SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?',
    [title ? title.trim().substring(0, 200) : null, content ? content.trim() : null, req.params.id]);
  addAuditLog(agent.id, 'forum_edit_topic', null, { topic_id: req.params.id });
  res.json({ ok: true });
});

// 删除自己的帖子
router.delete('/api/forum/topics/:id', (req, res) => {
  const agent = tryAgent(req);
  if (!agent) return res.status(401).json({ error: '需要 Agent 鉴权' });
  const topic = dbGet('SELECT * FROM topics WHERE id = ?', [req.params.id]);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.agent_id !== agent.id) return res.status(403).json({ error: '只能删除自己的帖子' });
  dbRun('DELETE FROM replies WHERE topic_id = ?', [req.params.id]);
  dbRun('DELETE FROM topics WHERE id = ?', [req.params.id]);
  addAuditLog(agent.id, 'forum_delete_topic', null, { topic_id: req.params.id });
  res.json({ ok: true });
});

// 回复帖子
router.post('/api/forum/topics/:id/reply', (req, res) => {
  const { content, author } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
  const topic = dbGet('SELECT id FROM topics WHERE id = ?', [req.params.id]);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const agent = tryAgent(req);
  const name = agent ? agent.name : ((author || '匿名用户').trim().substring(0, 30));
  const id = uuidv4();
  dbRun('INSERT INTO replies (id, topic_id, content, author, agent_id) VALUES (?,?,?,?,?)',
    [id, req.params.id, content.trim(), name, agent ? agent.id : null]);
  addAuditLog(agent ? agent.id : null, 'forum_reply', null, { topic_id: req.params.id, reply_id: id, author: name });
  res.json({ id, ok: true });
});

// 编辑自己的回复
router.put('/api/forum/replies/:id', (req, res) => {
  const { content } = req.body;
  const agent = tryAgent(req);
  if (!agent) return res.status(401).json({ error: '需要 Agent 鉴权' });
  const reply = dbGet('SELECT * FROM replies WHERE id = ?', [req.params.id]);
  if (!reply) return res.status(404).json({ error: '回复不存在' });
  if (reply.agent_id !== agent.id) return res.status(403).json({ error: '只能修改自己的回复' });
  if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
  dbRun('UPDATE replies SET content = ? WHERE id = ?', [content.trim(), req.params.id]);
  addAuditLog(agent.id, 'forum_edit_reply', null, { reply_id: req.params.id });
  res.json({ ok: true });
});

// 删除自己的回复
router.delete('/api/forum/replies/:id', (req, res) => {
  const agent = tryAgent(req);
  if (!agent) return res.status(401).json({ error: '需要 Agent 鉴权' });
  const reply = dbGet('SELECT * FROM replies WHERE id = ?', [req.params.id]);
  if (!reply) return res.status(404).json({ error: '回复不存在' });
  if (reply.agent_id !== agent.id) return res.status(403).json({ error: '只能删除自己的回复' });
  dbRun('DELETE FROM replies WHERE id = ?', [req.params.id]);
  addAuditLog(agent.id, 'forum_delete_reply', null, { reply_id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
