#!/usr/bin/env node
/**
 * Kimi 2007 浏览器兼容模式启动器。
 *
 * 浏览器模式:
 *   1. 确保 `kimi server` 本地守护进程已启动。
 *   2. 从 ~/.kimi-code/server.token 读取持久令牌。
 *   3. 在 http://127.0.0.1:2007 提供页面和 /env.json。
 *
 * macOS 原生客户端在 Swift 中实现同样的服务检测和随机回环页面服务，不加载本模块。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const UI_PORT = Number(process.env.QKIMI_UI_PORT) || 2007;
const KIMI_PORT = Number(process.env.KIMI_SERVER_PORT) || 58627;
const KIMI_BASE = process.env.KIMI_SERVER_BASE || `http://127.0.0.1:${KIMI_PORT}`;
const TOKEN_FILE = process.env.KIMI_SERVER_TOKEN_FILE ||
  path.join(os.homedir(), '.kimi-code', 'server.token');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const PUBLIC_FILES = new Set(['/index.html', '/style.css', '/bootstrap.js', '/markdown-it.min.js', '/app.js']);

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

async function kimiHealthy(token) {
  if (!token) return false;
  try {
    const res = await fetch(`${KIMI_BASE}/api/v1/meta`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function findKimiBinary() {
  if (process.env.KIMI_BIN) return process.env.KIMI_BIN;
  const name = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  const installed = path.join(os.homedir(), '.kimi-code', 'bin', name);
  return fs.existsSync(installed) ? installed : name;
}

function spawnKimiDaemon() {
  const binary = findKimiBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['server', 'run', '--keep-alive', '--port', String(KIMI_PORT)], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', (error) => {
      reject(new Error(`无法启动 Kimi CLI (${binary}): ${error.message}`));
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function ensureKimiServer() {
  let token = readToken();
  if (token && (await kimiHealthy(token))) {
    console.log(`[kimi-2007] kimi server 已在运行: ${KIMI_BASE}`);
    return token;
  }

  console.log('[kimi-2007] 正在拉起 kimi server 守护进程...');
  await spawnKimiDaemon();

  // 令牌文件可能由刚启动的服务生成，因此健康检查期间持续重读。
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    token = readToken();
    if (token && (await kimiHealthy(token))) {
      console.log(`[kimi-2007] kimi server 就绪: ${KIMI_BASE}`);
      return token;
    }
  }
  throw new Error('kimi server 启动超时，请运行 `kimi server run --keep-alive` 排查');
}

function runtimeEnv(token, cwd) {
  return {
    base: KIMI_BASE,
    token: readToken() || token,
    model: 'kimi-code/k3',
    cwd,
  };
}

function securityHeaders() {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function serveStatic(req, res, options) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, Object.assign({ Allow: 'GET, HEAD' }, securityHeaders()));
    res.end('method not allowed');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, securityHeaders());
    res.end('bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath === '/env.json' && options.exposeEnv) {
    const body = JSON.stringify(runtimeEnv(options.token, options.cwd));
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, securityHeaders()));
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }

  if (!PUBLIC_FILES.has(urlPath)) {
    res.writeHead(404, securityHeaders());
    res.end('not found');
    return;
  }

  const filePath = path.join(options.root, urlPath.slice(1));
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, securityHeaders());
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }, securityHeaders()));
    res.end(method === 'HEAD' ? undefined : data);
  });
}

function startUiServer(options = {}) {
  const settings = {
    host: options.host || '127.0.0.1',
    port: options.port == null ? UI_PORT : options.port,
    token: options.token || readToken(),
    cwd: options.cwd || ROOT,
    root: options.root || ROOT,
    exposeEnv: options.exposeEnv !== false,
  };
  const server = http.createServer((req, res) => serveStatic(req, res, settings));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({
        server,
        url: `http://${settings.host}:${address.port}`,
        setCwd: (cwd) => { settings.cwd = cwd; },
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

async function startBrowserUi() {
  const token = await ensureKimiServer();
  const ui = await startUiServer({ token, cwd: ROOT });
  console.log(`[kimi-2007] 浏览器界面已就绪: ${ui.url}`);
  return ui;
}

if (require.main === module) {
  startBrowserUi().catch((error) => {
    console.error('[kimi-2007] 启动失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  KIMI_BASE,
  KIMI_PORT,
  ROOT,
  TOKEN_FILE,
  ensureKimiServer,
  findKimiBinary,
  kimiHealthy,
  readToken,
  runtimeEnv,
  serveStatic,
  startBrowserUi,
  startUiServer,
};
