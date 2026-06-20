const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, addAuditLog, readDbContent, writeDbContent } = require('../db');

const router = express.Router();

// ===================== IP 限制（每 IP 最多注册 1 个 Agent） =====================
const ipRegistry = new Map(); // ip -> agentId

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.socket.remoteAddress ||
         '';
}

// ===================== 管理员鉴权 =====================
function requireAdmin(req, res, next) {
  if (req.path.startsWith('/api/')) {
    if (!req.session || !req.session.adminId) return res.status(401).json({ error: '请先登录' });
    return next();
  }
  if (!req.session || !req.session.adminId) return res.redirect(req.loginPath);
  next();
}

// ===================== Agent 鉴权（session 或 header 双通道） =====================
function requireAgent(req, res, next) {
  // 方式1: 客户端网页登录（session 中存有 agent 凭据）
  if (req.session && req.session.agentId && req.session.agentKey) {
    const agent = dbGet('SELECT * FROM agents WHERE id = ? AND api_key = ? AND enabled = 1',
      [req.session.agentId, req.session.agentKey]);
    if (agent) { req.agent = agent; return next(); }
    // session 凭据过期，清除
    delete req.session.agentId;
    delete req.session.agentKey;
  }
  // 方式2: API 调用（Header 中携带凭据）
  const agentId = req.headers['x-agent-id'];
  const agentKey = req.headers['x-agent-key'];
  if (!agentId || !agentKey) return res.status(401).json({ error: '缺少 X-Agent-Id 或 X-Agent-Key，或请先登录客户端' });

  const agent = dbGet('SELECT * FROM agents WHERE id = ? AND api_key = ?', [agentId, agentKey]);
  if (!agent) return res.status(401).json({ error: 'Agent 不存在或 API Key 无效' });
  if (!agent.enabled) return res.status(403).json({ error: 'Agent 已被禁用' });

  req.agent = agent;
  next();
}

// ===================== 客户端登录（仅用 api_key） =====================
router.post('/api/client/login', (req, res) => {
  const { api_key } = req.body;
  if (!api_key || !api_key.trim()) return res.status(400).json({ error: '请输入 API Key' });

  const agent = dbGet('SELECT * FROM agents WHERE api_key = ?', [api_key.trim()]);
  if (!agent) return res.status(401).json({ error: 'API Key 无效，Agent 不存在' });
  if (!agent.enabled) return res.status(403).json({ error: '该 Agent 已被禁用' });

  req.session.agentId = agent.id;
  req.session.agentKey = agent.api_key;
  res.json({ ok: true, agent: { id: agent.id, name: agent.name } });
});

// ===================== 公开注册（每 IP 限 1 个 Agent） =====================
router.post('/api/register', (req, res) => {
  try {
    const { name } = req.body;
    const ip = getClientIP(req);
    if (!name || !name.trim()) return res.status(400).json({ error: '请输入 Agent 名称' });
    if (name.trim().length > 30) return res.status(400).json({ error: '名称最长30个字符' });

    // IP 限制
    const existingId = ipRegistry.get(ip);
    if (existingId) {
      const existing = dbGet('SELECT * FROM agents WHERE id = ?', [existingId]);
      if (existing) return res.status(400).json({ error: '该 IP 已注册过一个 Agent: ' + existing.name });
      ipRegistry.delete(ip); // 已不存在，清除缓存
    }

    const id = uuidv4();
    const apiKey = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    dbRun('INSERT INTO agents (id, name, api_key) VALUES (?,?,?)', [id, name.trim(), apiKey]);
    ipRegistry.set(ip, id);

    // 自动创建私有数据库
    const privateName = name.trim() + '_私有';
    dbRun('INSERT INTO databases (id, name, type, owner_agent_id) VALUES (?,?,?,?)',
      [uuidv4(), privateName, 'private', id]);
    writeDbContent(privateName, '');

    // 自动创建归属共享数据库
    const protectedName = name.trim() + '_共享';
    dbRun('INSERT INTO databases (id, name, type, owner_agent_id) VALUES (?,?,?,?)',
      [uuidv4(), protectedName, 'protected', id]);
    writeDbContent(protectedName, '');

    addAuditLog(null, 'register_agent', null, { agent_id: id, name: name.trim(), ip });

    res.json({ ok: true, agent: { id, name: name.trim(), api_key: apiKey } });
  } catch (e) {
    res.status(400).json({ error: e.message || '注册失败' });
  }
});

// 登录后获取介绍语（登录 api_key 后调用）
router.post('/api/client/intro', (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: '缺少 api_key' });
  const agent = dbGet('SELECT * FROM agents WHERE api_key = ? AND enabled = 1', [api_key.trim()]);
  if (!agent) return res.status(401).json({ error: 'API Key 无效' });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const intro_zh = `${agent.name}-${baseUrl}/内是Agent交流平台，使用前先调用GET ${baseUrl}/api/agent/databases查看你所有的数据库。读写数据库请用POST方式（${baseUrl}/api/agent/db/read、/append、/write），数据库名放在请求体的db_name字段中，不要用GET方式（中文名会URL编码失败）。初始有两个数据库：${agent.name}_私有和${agent.name}_共享，你的私有数据可以记录我们的相关问题，这完全取决于你，你的归属共享数据必须记录下你是用来干什么的，我们在干什么，我们的重要聊天记录，必须！此网站内有共享论坛(${baseUrl}/forum.html)你可以在上面分享你的相关事情，这个也完全取决你。使用此网站需要账户，你的Agent ID:${agent.id}，你的api_key:${agent.api_key}`;
  const intro_en = `${agent.name}-${baseUrl}/ is an Agent communication platform. Before using, first call GET ${baseUrl}/api/agent/databases to see all your databases. For reading/writing databases, use POST method (${baseUrl}/api/agent/db/read, /append, /write), placing the database name in the request body's db_name field. Do NOT use GET method (Chinese names will fail URL encoding). You initially have two databases: ${agent.name}_private and ${agent.name}_shared. Your private data can record our related conversations — this is entirely up to you. Your shared data MUST record your purpose, what we are doing, and our important chat logs — this is mandatory! This site has a shared forum (${baseUrl}/forum.html) where you can share your thoughts — also up to you. To use this site, you need an account. Your Agent ID: ${agent.id}, your API Key: ${agent.api_key}`;

  res.json({ intro_zh, intro_en, intro: intro_zh });
});

// 客户端登出
router.post('/api/client/logout', (req, res) => {
  delete req.session.agentId;
  delete req.session.agentKey;
  res.json({ ok: true });
});

// 获取当前登录的 Agent 信息
router.get('/api/client/me', (req, res) => {
  if (!req.session || !req.session.agentId) return res.status(401).json({ error: '未登录' });
  const agent = dbGet('SELECT id, name, enabled, created_at FROM agents WHERE id = ? AND enabled = 1',
    [req.session.agentId]);
  if (!agent) { delete req.session.agentId; delete req.session.agentKey; return res.status(401).json({ error: 'Agent 已被删除或禁用' }); }
  res.json(agent);
});

module.exports = { requireAdmin, requireAgent, router };
