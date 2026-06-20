const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { getDb, createDefaultAdmin } = require('./db');

const app = express();

// ===================== 请求体解析 =====================
// JSON 解析（接受常见的 Content-Type）
app.use(express.json({
  type: ['application/json', 'text/plain', 'application/*+json', '*/*'],
  limit: '10mb'
}));

// 确保所有 JSON 响应使用 UTF-8 编码
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function(data) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return origJson(data);
  };
  next();
});

// JSON 解析错误处理——返回友好 JSON 错误而非 HTML 页面
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体格式错误：JSON 解析失败，请检查 body 是否为合法 JSON' });
  }
  next(err);
});

app.use(session({
  secret: uuidv4(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// 拦截 /admin.html /login.html — 不响应任何内容
app.use((req, res, next) => {
  if (req.path === '/admin.html' || req.path === '/login.html') return res.status(404).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8'
    };
    if (mime[ext]) res.setHeader('Content-Type', mime[ext]);
  }
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 生成随机后台管理路径（每次启动固定）
const ADMIN_SUFFIX = crypto.randomBytes(4).toString('hex'); // ~8 chars
const ADMIN_PATH = `/admin-${ADMIN_SUFFIX}.html`;
const LOGIN_SUFFIX = crypto.randomBytes(4).toString('hex');
const LOGIN_PATH = `/login-${LOGIN_SUFFIX}.html`;

// 通过中间件注入动态路径到 req，确保路由可靠访问
app.use((req, res, next) => {
  req.adminPath = ADMIN_PATH;
  req.loginPath = LOGIN_PATH;
  next();
});

app.get(ADMIN_PATH, (req, res) => {
  if (!req.session || !req.session.adminId) return res.redirect(LOGIN_PATH);
  // 注入动态登录路径到 admin.html
  const html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8')
    .replace('__LOGIN_PATH__', LOGIN_PATH);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get(LOGIN_PATH, (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/client.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/api-docs.md', (req, res) => res.redirect('/api-docs.html'));

// 挂载路由（数据库初始化后）
let routesMounted = false;
function mountRoutes() {
  if (routesMounted) return;
  routesMounted = true;
  const auth = require('./routes/auth');
  app.use(auth.router);
  app.use(require('./routes/admin'));
  app.use('/api', require('./routes/agent'));
  app.use(require('./routes/forum'));
}

// ===================== 启动 =====================
const args = process.argv.slice(2);
const HTTP_PORT = process.env.HTTP_PORT || 4000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const certPath = path.join(__dirname, 'data', 'cert.pem');
const keyPath = path.join(__dirname, 'data', 'key.pem');

// 全局异步错误处理（捕获 async 路由中未处理的异常）
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack || err.message || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

async function start() {
  await getDb();
  const adminInfo = createDefaultAdmin();
  mountRoutes();

  const httpOnly = args.includes('--http-only');
  const protocol = (!httpOnly && fs.existsSync(certPath) && fs.existsSync(keyPath)) ? 'https' : 'http';
  const port = protocol === 'https' ? HTTPS_PORT : HTTP_PORT;

  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`HTTP 服务器已启动: http://localhost:${HTTP_PORT}`);
  });
  if (!httpOnly && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app).listen(HTTPS_PORT, () => {
      console.log(`HTTPS 服务器已启动: https://localhost:${HTTPS_PORT}`);
    });
  } else if (!httpOnly) {
    console.log('未找到 SSL 证书，仅启动 HTTP 模式');
  }

  // 打印后台管理地址和密码
  const adminUrl = `${protocol}://localhost:${port}${ADMIN_PATH}`;
  const loginUrl = `${protocol}://localhost:${port}${LOGIN_PATH}`;
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log(`  后台登录页:   ${loginUrl}`);
  console.log(`  后台管理页:   ${adminUrl}`);
  if (adminInfo.password) {
    console.log(`  管理员密码:   ${adminInfo.password}`);
    console.log('  ⚠ 请立即登录并修改密码');
  } else if (!adminInfo.initialized) {
    console.log(`  密码未初始化，请访问 ${loginUrl} 设置密码`);
  }
  console.log('══════════════════════════════════════════');
  console.log('');
}

start();
