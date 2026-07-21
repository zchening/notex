'use strict';
// NoteSync — 极简端到端加密便签后端（多笔记 + 限流，零依赖 Node.js）
// 只做一件事：按 URL 路径存/取多段密文。所有加解密都在浏览器完成，服务器从不见明文、不见口令、不见密钥。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const NOTES_DIR = path.join(DATA_DIR, 'notes');
const INDEX_FILE = path.join(APP_DIR, 'index.html');

if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

const EMPTY = { v: 0, ct: '', iv: '', salt: '', updatedAt: 0 };

// noteId 校验：只允许字母数字、横线、下划线，1-32 字符
const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// --- 限流参数 ---
const FAIL_LIMIT = 10;                   // 失败阈值
const FAIL_WINDOW = 10 * 60 * 1000;      // 计数窗口 10 分钟
const LOCK_DURATION = 30 * 60 * 1000;    // 锁定 30 分钟
// Map<key, { count, firstFail, lockedAt }>
const failMap = new Map();

function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkLimit(ip, noteId) {
  const key = ip + ':' + noteId;
  const now = Date.now();
  const rec = failMap.get(key);
  if (rec && rec.lockedAt) {
    if (now - rec.lockedAt < LOCK_DURATION) {
      return { locked: true, retryAfter: Math.ceil((LOCK_DURATION - (now - rec.lockedAt)) / 1000) };
    } else {
      failMap.delete(key); // 锁定过期，清除
    }
  }
  return { locked: false };
}

function recordFail(ip, noteId) {
  const key = ip + ':' + noteId;
  const now = Date.now();
  let rec = failMap.get(key);
  // 已锁定，直接返回
  if (rec && rec.lockedAt) {
    return checkLimit(ip, noteId);
  }
  // 无记录或窗口过期，重置
  if (!rec || (now - rec.firstFail > FAIL_WINDOW)) {
    rec = { count: 0, firstFail: now, lockedAt: null };
  }
  rec.count++;
  if (rec.count >= FAIL_LIMIT) {
    rec.lockedAt = now;
  }
  failMap.set(key, rec);
  return checkLimit(ip, noteId);
}

// 定期清理过期记录（每 5 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of failMap) {
    if (rec.lockedAt) {
      if (now - rec.lockedAt >= LOCK_DURATION) failMap.delete(key);
    } else if (now - rec.firstFail >= FAIL_WINDOW) {
      failMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function notePath(id) {
  return path.join(NOTES_DIR, id + '.json');
}

function readNote(id) {
  try {
    return JSON.parse(fs.readFileSync(notePath(id), 'utf8'));
  } catch {
    return { ...EMPTY };
  }
}

function writeNote(id, obj) {
  const tmp = notePath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, notePath(id));
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function extractId(url, prefix) {
  // /api/note/abc123 → abc123
  const m = url.match(new RegExp('^' + prefix + '/([^/]+)'));
  return m ? m[1] : null;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const ip = getClientIP(req);

  // --- API: 读取笔记 ---
  if (req.method === 'GET' && url.startsWith('/api/note/')) {
    const id = extractId(url, '/api/note');
    if (!id || !ID_RE.test(id)) return sendJSON(res, 400, { error: 'bad id' });
    const limit = checkLimit(ip, id);
    if (limit.locked) return sendJSON(res, 429, { error: 'locked', retryAfter: limit.retryAfter });
    return sendJSON(res, 200, readNote(id));
  }

  // --- API: 写入笔记 ---
  if (req.method === 'PUT' && url.startsWith('/api/note/')) {
    const id = extractId(url, '/api/note');
    if (!id || !ID_RE.test(id)) return sendJSON(res, 400, { error: 'bad id' });
    const limit = checkLimit(ip, id);
    if (limit.locked) return sendJSON(res, 429, { error: 'locked', retryAfter: limit.retryAfter });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let obj;
      try { obj = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      if (!obj || typeof obj.ct !== 'string' || typeof obj.iv !== 'string' || typeof obj.salt !== 'string') {
        return sendJSON(res, 400, { error: 'missing fields' });
      }
      const cur = readNote(id);
      const next = { v: (cur.v || 0) + 1, ct: obj.ct, iv: obj.iv, salt: obj.salt, updatedAt: Date.now() };
      writeNote(id, next);
      return sendJSON(res, 200, { ok: true, v: next.v, updatedAt: next.updatedAt });
    });
    return;
  }

  // --- API: 上报解密失败 ---
  if (req.method === 'POST' && url.startsWith('/api/fail/')) {
    const id = extractId(url, '/api/fail');
    if (!id || !ID_RE.test(id)) return sendJSON(res, 400, { error: 'bad id' });
    const limit = recordFail(ip, id);
    if (limit.locked) return sendJSON(res, 429, { locked: true, retryAfter: limit.retryAfter });
    const rec = failMap.get(ip + ':' + id);
    return sendJSON(res, 200, { locked: false, count: rec ? rec.count : 0 });
  }

  // --- 健康检查 ---
  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200); res.end('ok'); return;
  }

  // --- 前端页面（SPA 风格，所有非 /api/ 的 GET 都返回 index.html）---
  if (req.method === 'GET' && !url.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX_FILE).pipe(res);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log('[notesync] listening on :' + PORT));
