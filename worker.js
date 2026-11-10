const MAX_RETRIES_DEFAULT = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Store-Key, If-None-Match, Range',
      // Content-Range / Accept-Ranges 不在 CORS 默认可读清单里，跨域（xywm.org → tg.xywm.org）
      // 时前端读不到它们，就没法判断总长与分段是否对齐，必须显式暴露
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag, X-File-Size',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      let res;
      if (path === '/upload' && request.method === 'POST')
        res = await handleUpload(request, env);
      else if (path === '/upload-raw' && request.method === 'POST')
        res = await handleUploadRaw(request, env);
      else if (path.startsWith('/f/') && (request.method === 'GET' || request.method === 'HEAD'))
        res = await handleDownload(path.substring(3), request, env);
      else if (path === '/del-batch' && request.method === 'POST')
        res = await handleDeleteBatch(request, env);
      else if (path.startsWith('/del/') && request.method === 'DELETE')
        res = await handleDelete(path.substring(5), request, env);
      else
        res = new Response('TG Storage Worker - OK', { status: 200 });
      Object.entries(CORS).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    } catch (e) {
      return json({ error: e.message }, 500, CORS);
    }
  }
};

// ===================== UPLOAD =====================
// Telegram 限流（429）要按 retry_after 精确等待，提前重试会延长惩罚时间。
// 这里把 429 单独识别出来，并把退避信号透传给前端，让前端整体降速。
function tgRetryAfter(data) {
  const p = data && data.parameters;
  const n = p && (p.retry_after != null ? p.retry_after : p.migrate_to_chat_id);
  return (typeof n === 'number' && n > 0) ? n : 0;
}
function isTgRateLimited(description) {
  return /too many requests|flood|retry after/i.test(description || '');
}

async function handleUpload(request, env) {
  if (request.headers.get('X-Store-Key') !== env.STORE_KEY)
    return json({ error: 'unauthorized' }, 401);
  const fd = await request.formData();
  const file = fd.get('file');
  if (!file) return json({ error: 'no file' }, 400);
  const ext = (file.name || 'file').split('.').pop().toLowerCase();
  const mime = file.type || 'application/octet-stream';
  const m = resolveMethod(mime, ext, file.name);
  const MAX_RETRIES = env.UPLOAD_RETRIES ? (parseInt(env.UPLOAD_RETRIES, 10) || MAX_RETRIES_DEFAULT) : MAX_RETRIES_DEFAULT;
  let lastErr, lastRetryAfter = 0;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const tgFd = new FormData();
      tgFd.append('chat_id', env.CHAT_ID);
      const blob = m.outName !== file.name
        ? new File([file], m.outName, { type: mime }) : file;
      tgFd.append(m.typeName, blob, m.outName);
      const base = env.TG_API_URL || 'https://api.telegram.org';
      const resp = await fetch(base + '/bot' + env.BOT_TOKEN + '/' + m.method, {
        method: 'POST', body: tgFd
      });
      const data = await resp.json();
      if (!data.ok) {
        // 429：按 retry_after 精确等待（另加 0.5s 余量），并把信号记下来透传
        const ra = tgRetryAfter(data);
        const desc = data.description || 'TG API error';
        if (ra > 0 || isTgRateLimited(desc)) {
          lastRetryAfter = ra || 5;
          lastErr = new Error(desc);
          if (i < MAX_RETRIES - 1) { await sleep(lastRetryAfter * 1000 + 500); continue; }
          return json({ error: 'rate limited: ' + desc, rateLimited: true, retryAfter: lastRetryAfter }, 429);
        }
        throw new Error(desc);
      }
      const r = data.result || {};
      let fi = pickFile(r);
      if (!fi && m.method !== 'sendDocument') {
        // 兜底：TG 对某些格式（如 WebP 走 animation）会静默退回 document，改用 sendDocument 重发
        const docFd = new FormData();
        docFd.append('chat_id', env.CHAT_ID);
        docFd.append('document', file, m.outName);
        const resp2 = await fetch(base + '/bot' + env.BOT_TOKEN + '/sendDocument', {
          method: 'POST', body: docFd
        });
        const data2 = await resp2.json();
        if (!data2.ok) {
          const ra2 = tgRetryAfter(data2);
          if (ra2 > 0) return json({ error: 'rate limited', rateLimited: true, retryAfter: ra2 }, 429);
          throw new Error(data2.description || 'TG API error');
        }
        const r2 = data2.result || {};
        const fi2 = pickFile(r2);
        if (!fi2) throw new Error('unexpected response (fields: ' + Object.keys(r2).join(',') + ')');
        // 用 sendDocument 的结果覆盖后续逻辑
        r.document = r2.document;
        r.message_id = r2.message_id;
        fi = fi2;
      }
      if (!fi) throw new Error('unexpected response (fields: ' + Object.keys(r).join(',') + ')');
      let filePath = null;
      try {
        const fr = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + fi.file_id);
        const fd2 = await fr.json();
        if (fd2.ok) filePath = fd2.result.file_path;
      } catch (_) {}
      // 提取缩略图（图片/视频 TG 自动生成）
      let thumbFid = null, thumbFp = null, thumbMid = null;
      const thumb = (r.photo ? r.photo.reduce((a, b) => a.file_size < b.file_size ? a : b) : null)
        || (r.video && r.video.thumb) || (r.animation && r.animation.thumb)
        || (r.document && r.document.thumb) || (r.sticker && r.sticker.thumb);
      if (thumb && thumb.file_id) {
        thumbFid = thumb.file_id;
        try {
          const tfr = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + thumbFid);
          const tfd = await tfr.json();
          if (tfd.ok) thumbFp = tfd.result.file_path;
        } catch (_) {}
      }
      const resp2 = {
        ok: true, file_id: fi.file_id, file_path: filePath,
        message_id: r.message_id, mime: mime,
        filename: file.name, size: fi.file_size || file.size,
      };
      if (thumbFid) {
        resp2.thumb_fid = thumbFid;
        resp2.thumb_fp = thumbFp;
        thumbMid = r.message_id;
      }
      return json(resp2);
    } catch (e) {
      lastErr = e;
      if (i < MAX_RETRIES - 1) {
        // 普通错误（网络抖动等）指数退避；限流已在上面的分支里按 retry_after 等待
        const wait = lastRetryAfter > 0 ? lastRetryAfter * 1000 + 500 : 1000 * (i + 1);
        await sleep(wait);
      }
    }
  }
  const body = { error: 'upload failed: ' + (lastErr ? lastErr.message : 'unknown') };
  if (lastRetryAfter > 0) { body.rateLimited = true; body.retryAfter = lastRetryAfter; }
  return json(body, lastRetryAfter > 0 ? 429 : 500);
}

/**
 * POST /upload-raw —— 原始二进制直传（前端发 application/octet-stream）。
 *
 * 为什么不复用 handleUpload：那条路径要 await request.formData() 把整个分片
 * 解析成 multipart 对象，再 new FormData() 重新组装。这两步都是 CPU 密集
 * 操作，在 Cloudflare Free 的 10ms CPU 预算下很容易被强制终止——表现为浏览器
 * 收到一个不带 CORS 头的 503（请求根本没跑完）。
 *
 * 这里完全不碰 body：从请求头取文件名，直接把 request.body 流式转发给 Telegram，
 * CPU 占用几乎为零，也不会把整片内容读进内存。
 *
 * 请求头：X-Store-Key（密钥）/ X-File-Name（URL 编码文件名，决定 TG 接口）/ Content-Type
 */
async function handleUploadRaw(request, env) {
  if (request.headers.get('X-Store-Key') !== env.STORE_KEY)
    return json({ error: 'unauthorized' }, 401);
  if (!request.body) return json({ error: 'no body' }, 400);

  const rawName = request.headers.get('X-File-Name') || 'file.bin';
  let origName;
  try { origName = decodeURIComponent(rawName); } catch (_) { origName = rawName; }
  origName = String(origName).replace(/[\\/\r\n]+/g, '_') || 'file.bin';

  const ext = origName.split('.').pop().toLowerCase();
  const mime = request.headers.get('Content-Type') || 'application/octet-stream';
  const m = resolveMethod(mime, ext, origName);
  const total = parseInt(request.headers.get('Content-Length') || '0', 10) || 0;

  const base = env.TG_API_URL || 'https://api.telegram.org';
  const MAX_RETRIES = env.UPLOAD_RETRIES ? (parseInt(env.UPLOAD_RETRIES, 10) || MAX_RETRIES_DEFAULT) : MAX_RETRIES_DEFAULT;

  // multipart 的头尾自己拼（几百字节），body 本体用流拼接，不复制内容
  const boundary = '----tgstore' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  const encName = origName.replace(/["\r\n]/g, '_');
  const head = '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
    + env.CHAT_ID + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="' + m.typeName + '"; filename="' + encName + '"\r\n'
    + 'Content-Type: ' + mime + '\r\n\r\n';
  const tail = '\r\n--' + boundary + '--\r\n';
  const headBytes = new TextEncoder().encode(head);
  const tailBytes = new TextEncoder().encode(tail);

  // 原始 body 是一次性的：首次尝试纯流式转发；重试时已耗尽，需先缓冲到内存
  let cached = null;
  let lastErr = null, lastRetryAfter = 0;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      let bodyStream;
      if (cached) {
        const all = new Uint8Array(headBytes.length + cached.length + tailBytes.length);
        all.set(headBytes, 0);
        all.set(cached, headBytes.length);
        all.set(tailBytes, headBytes.length + cached.length);
        bodyStream = all;
      } else {
        // reader 必须在闭包里只创建一次：每次 pull 都 getReader() 会在流被锁定后抛错，
        // 表现为上传中途断流（浏览器侧看到的是没有 CORS 头的 5xx）
        const reader = request.body.getReader();
        let first = true;
        bodyStream = new ReadableStream({
          async pull(controller) {
            if (first) { first = false; controller.enqueue(headBytes); return; }
            const r = await reader.read();
            if (r.done) { controller.enqueue(tailBytes); controller.close(); return; }
            controller.enqueue(r.value);
          },
          cancel(reason) { try { reader.cancel(reason); } catch (_) {} },
        });
      }
      const resp = await fetch(base + '/bot' + env.BOT_TOKEN + '/' + m.method, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: bodyStream,
        duplex: 'half',
      });
      const data = await resp.json();
      if (!data.ok) {
        const ra = tgRetryAfter(data);
        const desc = data.description || 'TG API error';
        if (ra > 0 || isTgRateLimited(desc)) {
          lastRetryAfter = ra || 5;
          lastErr = new Error(desc);
          if (i < MAX_RETRIES - 1) { await sleep(lastRetryAfter * 1000 + 500); continue; }
          return json({ error: 'rate limited: ' + desc, rateLimited: true, retryAfter: lastRetryAfter }, 429);
        }
        throw new Error(desc);
      }
      const r = data.result || {};
      const fi = pickFile(r);
      if (!fi) throw new Error('unexpected response (fields: ' + Object.keys(r).join(',') + ')');

      let filePath = null;
      try {
        const fr = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + fi.file_id);
        const fd2 = await fr.json();
        if (fd2.ok) filePath = fd2.result.file_path;
      } catch (_) {}

      let thumbFid = null, thumbFp = null;
      const thumb = (r.photo ? r.photo.reduce((a, b) => a.file_size < b.file_size ? a : b) : null)
        || (r.video && r.video.thumb) || (r.animation && r.animation.thumb)
        || (r.document && r.document.thumb) || (r.sticker && r.sticker.thumb);
      if (thumb && thumb.file_id) {
        thumbFid = thumb.file_id;
        try {
          const tfr = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + thumbFid);
          const tfd = await tfr.json();
          if (tfd.ok) thumbFp = tfd.result.file_path;
        } catch (_) {}
      }

      const out = {
        ok: true, file_id: fi.file_id, file_path: filePath,
        message_id: r.message_id, mime: mime,
        filename: origName, size: fi.file_size || total,
      };
      if (thumbFid) { out.thumb_fid = thumbFid; out.thumb_fp = thumbFp; }
      return json(out);
    } catch (e) {
      lastErr = e;
      // 首次失败：把还没读完的原始 body 收进内存，供后续重试复用
      if (!cached) {
        try { cached = new Uint8Array(await new Response(request.body).arrayBuffer()); } catch (_) {}
      }
      if (i < MAX_RETRIES - 1) await sleep(1000 * (i + 1));
    }
  }
  return json({ error: 'upload failed: ' + (lastErr ? lastErr.message : 'unknown') }, 500);
}

// ===================== DOWNLOAD =====================
/**
 * 把 manifest 的 chunks 展开成绝对字节区间。
 * 老清单可能缺 size，缺 size 时按「整文件一块」处理，避免区间算错。
 */
function buildLayout(chunks, total) {
  const out = [];
  if (!chunks || !chunks.length) return out;
  const sized = chunks.every(c => typeof c.size === 'number' && c.size >= 0);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] || {};
    const size = sized ? c.size : (i === 0 ? total : 0);
    out.push({
      index: c.index != null ? c.index : i,
      fid: c.fid,
      filePath: c.filePath || null,
      start: pos,
      end: pos + size - 1,
      size: size,
    });
    pos += size;
  }
  return out;
}

/**
 * 文件下载 —— 核心约束：Cloudflare 会在约 60 秒时掐断仍在传输的响应。
 *
 * 199MB 的文件按实测约 1.2MB/s 需要 160 秒以上，所以「一个请求整包推完」
 * 在任何情况下都不可能成功，只会得到「头里写了 199MB、实际几 MB 就断」的
 * 半截响应（下载器据此判定失败）。因此：
 *
 *   1. 每个响应都有明确的字节区间，超过 DOWNLOAD_MAX_MB（默认 20MB）
 *      就按分片边界截断，回 206 + 精确的 Content-Range，客户端用 Range 续取；
 *   2. 绝不再出现「声明全长却只发一部分」的响应；
 *   3. ?info=1 返回分片布局，客户端可据此做进度与断点续传；
 *   4. 传输中若某片短读，直接 error 掉流，让客户端明确失败并重试那一段，
 *      而不是悄悄交付一个损坏的文件。
 */
async function handleDownload(fileId, request, env) {
  if (!fileId || fileId.includes('..') || fileId.includes('/') || fileId.includes('\\'))
    return json({ error: 'invalid id' }, 400);
  const manifest = await fetchManifest(fileId, env);
  if (!manifest) return json({ error: 'not found' }, 404);
  const url = new URL(request.url);

  const wantThumb = url.searchParams.get('thumb') === '1';
  if (wantThumb && manifest.thumb_fid) {
    const buf = await fetchTgFile(manifest.thumb_fid, manifest.thumb_fp, env);
    if (!buf) return json({ error: 'thumb fetch failed' }, 504);
    const h = new Headers();
    h.set('Content-Type', manifest.mime || 'image/jpeg');
    h.set('Cache-Control', 'public, max-age=604800, immutable');
    h.set('Content-Length', String(buf.byteLength));
    return new Response(buf, { status: 200, headers: h });
  }

  const total = manifest.size || 0;
  const mime = manifest.mime || 'application/octet-stream';
  const fname = encodeURIComponent(manifest.filename || fileId);
  const et = makeEtag(manifest);
  const chunks = manifest.chunks || [];
  const layout = buildLayout(chunks, total);

  // 分片布局：前端据此规划 Range 请求、显示进度、断点续传
  if (url.searchParams.get('info') === '1') {
    return json({
      ok: true,
      size: total,
      mime: manifest.mime || 'application/octet-stream',
      filename: manifest.filename || fileId,
      etag: et,
      chunks: layout.map(c => ({ index: c.index, start: c.start, end: c.end, size: c.size })),
    }, 200, { 'Cache-Control': 'private, max-age=60' });
  }

  if (request.method === 'HEAD')
    return new Response(null, { status: 200, headers: commonHeaders(total, mime, fname, et) });
  const ifNM = request.headers.get('If-None-Match');
  if (ifNM && ifNM === et)
    return new Response(null, { status: 304, headers: { 'ETag': et, 'Cache-Control': 'private' } });

  // 单次响应的字节预算：一篇 20MB 实测约需 17s，安全地留在 60s 掐断线以内
  const MAXB = Math.min(64, Math.max(2, parseInt(env.DOWNLOAD_MAX_MB, 10) || 20)) * 1024 * 1024;
  const want = parseRange(request.headers.get('Range'), total) || { start: 0, end: total - 1 };
  const parts = layout.length ? layout
    : [{ index: 0, fid: manifest.file_id, filePath: manifest.file_path || null,
         start: 0, end: total - 1, size: total }];
  const rng = { start: want.start, end: Math.max(want.start, Math.min(want.end, want.start + MAXB - 1, total - 1)) };
  const full = rng.start === 0 && rng.end >= total - 1;

  // 本次响应覆盖到的分片
  const need = parts.filter(c => c.end >= rng.start && c.start <= rng.end);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const CONC = Math.min(4, Math.max(1, need.length));
        const pending = new Map();
        let cursor = 0;
        const fill = () => {
          while (cursor < need.length && pending.size < CONC) {
            const i = cursor++;
            const c = need[i];
            const s = Math.max(0, rng.start - c.start);
            const e = Math.min(c.size, rng.end - c.start + 1) - 1;
            pending.set(i, tgOpen(c.fid, c.filePath, env, 3, { start: s, end: e }));
          }
        };
        fill();
        const expect = rng.end - rng.start + 1;
        let emitted = 0;
        for (let i = 0; i < need.length; i++) {
          const src = await pending.get(i);
          pending.delete(i);
          fill();
          if (!src) throw new Error('chunk ' + need[i].index + ' failed');
          const c = need[i];
          const s = Math.max(0, rng.start - c.start);
          const e = Math.min(c.size, rng.end - c.start + 1) - 1;
          const needBytes = e - s + 1;
          // 上游按 Range 返回 206 时 body 已经是目标片段；否则自己裁
          const body = src.partial ? src.body : trimStream(src.body, s, e);
          const reader = body.getReader();
          let got = 0;
          for (;;) {
            const rr = await reader.read();
            if (rr.done) break;
            controller.enqueue(rr.value);
            got += rr.value.byteLength;
          }
          emitted += got;
          // 短读必须显式失败：宁可让客户端重试这段，也不能交付错位的字节
          if (got !== needBytes) throw new Error('chunk ' + c.index + ' short: ' + got + '/' + needBytes);
        }
        if (emitted !== expect) throw new Error('short response: ' + emitted + '/' + expect);
        controller.close();
      } catch (err) { controller.error(err); }
    }
  });

  const h = commonHeaders(total, mime, fname, et);
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', full ? 'public, max-age=31536000, immutable' : 'private');
  h.set('X-File-Size', String(total));
  if (full) {
    h.set('Content-Length', String(total));
    return new Response(stream, { status: 200, headers: h });
  }
  h.set('Content-Range', 'bytes ' + rng.start + '-' + rng.end + '/' + total);
  h.set('Content-Length', String(rng.end - rng.start + 1));
  return new Response(stream, { status: 206, headers: h });
}

// ===================== DELETE =====================
async function deleteMessages(msgIds, env) {
  const base = env.TG_API_URL || 'https://api.telegram.org';
  const results = [];
  // TG 没有批量删除 API，但并发发送可以基本消除串行等待
  const CONC = 8;
  for (let i = 0; i < msgIds.length; i += CONC) {
    const slice = msgIds.slice(i, i + CONC);
    const part = await Promise.all(slice.map(async (mid) => {
      try {
        const resp = await fetch(base + '/bot' + env.BOT_TOKEN + '/deleteMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.CHAT_ID, message_id: parseInt(mid) })
        });
        const d = await resp.json();
        return { message_id: parseInt(mid), ok: d.ok };
      } catch (e) {
        return { message_id: parseInt(mid), ok: false, error: e.message };
      }
    }));
    for (const r of part) results.push(r);
  }
  return results;
}

async function handleDelete(fileId, request, env) {
  if (request.headers.get('X-Store-Key') !== env.STORE_KEY)
    return json({ error: 'unauthorized' }, 401);
  if (!fileId || fileId.includes('..'))
    return json({ error: 'invalid id' }, 400);
  const url = new URL(request.url);
  const msgIds = (url.searchParams.get('msgIds') || '').split(',').filter(Boolean);
  if (!msgIds.length) return json({ error: 'no msgIds' }, 400);
  return json({ ok: true, results: await deleteMessages(msgIds, env) });
}

/** POST /del-batch  { items: [{ id, msgIds: [..] }, ...] } —— 一次请求清理多个清单 */
async function handleDeleteBatch(request, env) {
  if (request.headers.get('X-Store-Key') !== env.STORE_KEY)
    return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const items = (body && body.items) || [];
  if (!Array.isArray(items) || !items.length) return json({ error: 'no items' }, 400);
  // 汇总所有消息 id 一次性并发删除
  const all = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || it.id.includes('..')) continue;
    for (const mid of (it.msgIds || [])) all.push(mid);
  }
  const results = all.length ? await deleteMessages(all, env) : [];
  const okCount = results.filter(r => r.ok).length;
  return json({ ok: true, total: all.length, deleted: okCount, results: results });
}

// ===================== HELPERS =====================
function resolveMethod(mime, ext, origName) {
  const keep = (origName && /\.\w+$/.test(origName)) ? origName : null;
  // GIF 是合法的 animation；WebP 不是（TG 会存成 document，导致取不到 animation 字段）
  if (ext === 'gif')
    return { method: 'sendAnimation', typeName: 'animation', outName: keep || 'a.gif' };
  if (ext === 'webp')
    return { method: 'sendDocument', typeName: 'document', outName: keep || 'f.webp' };
  if (mime.startsWith('video/'))
    return { method: 'sendVideo', typeName: 'video', outName: (origName && /\.\w+$/.test(origName)) ? origName : 'v.mp4' };
  if (mime.startsWith('audio/'))
    return { method: 'sendAudio', typeName: 'audio', outName: (origName && /\.\w+$/.test(origName)) ? origName : 'a.mp3' };
  return { method: 'sendDocument', typeName: 'document', outName: (origName && /\.\w+$/.test(origName)) ? origName : ('f.' + ext) };
}

/** 从 TG 返回的 message 里挑出实际存储的文件对象（photo 取最大分辨率） */
function pickFile(r) {
  if (!r) return null;
  if (Array.isArray(r.photo) && r.photo.length)
    return r.photo.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a));
  return r.video || r.animation || r.document || r.audio
    || r.voice || r.video_note || r.sticker || r.animation || null;
}

async function fetchManifest(fileId, env) {
  const key = 'tgstore/' + fileId + '.json';
  const url = env.ORIGIN_URL + '/' + key;
  // 清单很少变化，用 Cloudflare 边缘缓存把每次下载前的这次 ORIGIN 往返省掉。
  // 命中缓存时可省 1-3 个 RTT，云储存视频的首帧明显更快。
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(url, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return await hit.json();
    } catch (_) { /* 缓存不可用则退化为直连 */ }
  }
  const resp = await fetch(url, { headers: { 'X-Store-Key': env.STORE_KEY } });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (cache) {
    try {
      const body = JSON.stringify(data);
      const cached = new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=600',
        },
      });
      await cache.put(cacheKey, cached);
    } catch (_) { /* 写缓存失败不影响本次返回 */ }
  }
  return data;
}

/**
 * 打开 TG 文件并拿到「流」，不把内容读进内存。
 *
 * 旧实现用 arrayBuffer() 整段缓冲再 slice()，20MB 分片就是两次 20MB 拷贝，
 * 在 Workers Free 的 10ms CPU 预算里必然被强杀——重视频库（大量 Range 拉流）
 * 就是这么把 CPU 配额烧光的。改成直接返回上游 body 流，CPU 占用趋近于零。
 */
async function tgOpen(fileId, filePath, env, retries, range) {
  const base = env.TG_API_URL || 'https://api.telegram.org';
  const tries = retries || 1;
  // 把浏览器的 Range 透传给 Telegram：只取这一小段，而不是整个 20MB 分片。
  // 这是起播速度和子请求数量的关键——不传 Range 的话，为了给播放器 1 个字节，
  // Worker 也得把整片 20MB 拖下来。
  const hdrs = {};
  if (range) hdrs['Range'] = 'bytes=' + range.start + '-' + range.end;
  const attempt = async (fp) => {
    try {
      const r = await fetch(base + '/file/bot' + env.BOT_TOKEN + '/' + fp, { headers: hdrs });
      if (!r.ok) return null;
      return {
        body: r.body,
        size: parseInt(r.headers.get('Content-Length') || '0', 10) || 0,
        partial: r.status === 206,
        // 上游没按 Range 裁剪时，这里的 Content-Range 可用来校准
        contentRange: r.headers.get('Content-Range') || null,
      };
    } catch (_) { return null; }
  };
  for (let i = 0; i < tries; i++) {
    let got = filePath ? await attempt(filePath) : null;
    if (got) return got;
    // 缓存的 file_path 失效/为空 → 强制重新 getFile 拿新路径
    try {
      const fr = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + fileId);
      const d = await fr.json();
      if (d && d.ok && d.result && d.result.file_path) {
        filePath = d.result.file_path;
        got = await attempt(filePath);
        if (got) return got;
      }
    } catch (_) {}
    if (i < tries - 1) await sleep(500 * (i + 1));
  }
  return null;
}

/** 把流裁剪到 [start, end] 字节区间，逐块转发，不复制整段 */
function trimStream(body, start, end) {
  if (!body) return new ReadableStream({ start(c) { c.close(); } });
  let pos = 0;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const r = await reader.read();
        if (r.done) { controller.close(); return; }
        const v = r.value;
        const vStart = pos;
        const vEnd = pos + v.byteLength - 1;
        pos += v.byteLength;
        if (vEnd < start) continue;              // 整块都在区间前，丢弃
        if (vStart > end) { controller.close(); try { reader.cancel(); } catch (_) {} return; }
        const s = Math.max(0, start - vStart);
        const e = Math.min(v.byteLength, end - vStart + 1);
        controller.enqueue(s === 0 && e === v.byteLength ? v : v.subarray(s, e));
        return;
      }
    },
    cancel(reason) { try { reader.cancel(reason); } catch (_) {} },
  });
}

async function fetchTgFile(fileId, filePath, env) {
  // 缩略图用（几十 KB），整段缓冲没问题
  const src = await tgOpen(fileId, filePath, env, 3);
  if (!src) return null;
  return new Uint8Array(await new Response(src.body).arrayBuffer());
}



function parseRange(header, total) {
  if (!header || total <= 0) return null;
  // bytes=N-M（标准范围）
  let m = header.match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const start = parseInt(m[1]);
    const end = m[2] ? parseInt(m[2]) : total - 1;
    if (start >= total || end >= total || start > end) return null;
    return { start: start, end: end };
  }
  // bytes=-N（Safari/iOS 探测 moov atom 用的后缀范围）
  m = header.match(/bytes=-(\d+)/);
  if (m) {
    const suffix = parseInt(m[1]);
    if (suffix <= 0 || suffix > total) return null;
    return { start: total - suffix, end: total - 1 };
  }
  return null;
}

function makeEtag(manifest) {
  const ts = manifest.chunks ? manifest.chunks.length : 0;
  return '"' + (manifest.size || 0) + '-' + ts + '"';
}

function commonHeaders(total, mime, fname, etag) {
  const h = new Headers();
  h.set('Content-Type', mime);
  h.set('Content-Disposition', 'inline; filename="' + fname + '"');
  h.set('Content-Length', String(total));
  h.set('ETag', etag);
  h.set('Accept-Ranges', 'bytes');
  return h;
}

function json(obj, status, extra) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (extra) Object.entries(extra).forEach(([k, v]) => h[k] = v);
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
