const MAX_RETRIES_DEFAULT = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Store-Key, If-None-Match, Range',
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
        bodyStream = new ReadableStream({
          start(controller) { controller.enqueue(headBytes); },
          async pull(controller) {
            const reader = request.body.getReader();
            let r;
            while (!(r = await reader.read()).done) controller.enqueue(r.value);
            controller.enqueue(tailBytes);
            controller.close();
          },
          cancel(reason) { try { request.body.cancel(reason); } catch (_) {} },
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
  if (request.method === 'HEAD')
    return new Response(null, { status: 200, headers: commonHeaders(total, mime, fname, et) });
  const ifNM = request.headers.get('If-None-Match');
  if (ifNM && ifNM === et)
    return new Response(null, { status: 304, headers: { 'ETag': et, 'Cache-Control': 'public, max-age=31536000' } });
  let rng = parseRange(request.headers.get('Range'), total);
  const chunks = manifest.chunks || [];
  if (chunks.length <= 1) {
    const fid = chunks.length === 1 ? chunks[0].fid : manifest.file_id;
    const fp = chunks.length === 1 ? chunks[0].filePath : manifest.file_path;
    const buf = await fetchTgFile(fid, fp, env);
    if (!buf) return json({ error: 'fetch failed' }, 500);
    if (rng) {
      const sliced = buf.slice(rng.start, rng.end + 1);
      const h = commonHeaders(total, mime, fname, et);
      h.set('Content-Range', 'bytes ' + rng.start + '-' + rng.end + '/' + total);
      h.set('Content-Length', String(sliced.byteLength));
      h.set('Accept-Ranges', 'bytes');
      h.set('Cache-Control', 'private');
      return new Response(sliced, { status: 206, headers: h });
    }
    const h = commonHeaders(total, mime, fname, et);
    h.set('Accept-Ranges', 'bytes');
    h.set('Cache-Control', 'public, max-age=31536000, immutable');
    return new Response(buf, { status: 200, headers: h });
  }
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let pos = 0;
        const sized = chunks.every(c => typeof c.size === 'number' && c.size >= 0);
        const hasPath = chunks.every(c => c.filePath);
        // 收集需要的分片
        const needed = [];
        for (const c of chunks) {
          if (rng) {
            if (sized) {
              const cStart = pos, cEnd = cStart + c.size - 1;
              if (cEnd < rng.start || cStart > rng.end) { pos += c.size; continue; }
              if (pos > rng.end) break;
            } else if (pos > rng.end) break;
          }
          needed.push({ c: c, pos: pos });
          pos += (typeof c.size === 'number') ? c.size : 0;
        }
        // 子请求预算：单次调用最多取 MAXC 片（50 上限 - manifest - 重试余量），
        // 超出则在本片边界截断，以 206 Partial Content 返回；浏览器/下载器会
        // 自动携带后续 Range 请求继续取，等效无感分页
        const MAXC = env.DOWNLOAD_MAX_CHUNKS ? Math.max(5, Math.min(48, parseInt(env.DOWNLOAD_MAX_CHUNKS, 10) || 45)) : 45;
        if (sized && needed.length > MAXC) {
          if (!rng) rng = { start: 0, end: total - 1 };
          const cutEnd = needed[MAXC - 1].pos + needed[MAXC - 1].c.size - 1;
          rng = { start: rng.start, end: Math.min(rng.end, cutEnd) };
          needed.length = MAXC;
        }
        // 滑动窗口流水线：最多 CONC 片在途，取到一片立即写入流并释放，
        // 内存峰值恒定（约4片），不会像整段缓冲那样撑爆 128MB 内存上限；
        // 老清单无 filePath 时每片要先 getFile，退化串行避免子请求翻倍
        const CONC = hasPath ? 4 : 1;
        const pending = new Map();
        let cursor = 0;
        const fill = () => {
          while (cursor < needed.length && pending.size < CONC) {
            const idx = cursor++;
            const c = needed[idx].c;
            pending.set(idx, fetchTgFileWithRetry(c.fid, c.filePath, env, 3));
          }
        };
        fill();
        for (let i = 0; i < needed.length; i++) {
          const buf = await pending.get(i);
          pending.delete(i);
          fill();
          if (!buf) throw new Error('chunk ' + (needed[i].c.index != null ? needed[i].c.index : '?') + ' failed');
          const s = rng ? Math.max(0, rng.start - needed[i].pos) : 0;
          const e = rng ? Math.min(buf.byteLength, rng.end - needed[i].pos + 1) : buf.byteLength;
          if (s < e) controller.enqueue(buf.slice(s, e));
        }
        controller.close();
      } catch (err) { controller.error(err); }
    }
  });
  const h = commonHeaders(total, mime, fname, et);
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', 'private');
  if (rng) {
    h.set('Content-Range', 'bytes ' + rng.start + '-' + rng.end + '/' + total);
    h.set('Content-Length', String(rng.end - rng.start + 1));
    return new Response(stream, { status: 206, headers: h });
  }
  return new Response(stream, { status: 200, headers: h });
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

async function fetchTgFile(fileId, filePath, env) {
  const base = env.TG_API_URL || 'https://api.telegram.org';
  const dl = async (fp) => {
    const r = await fetch(base + '/file/bot' + env.BOT_TOKEN + '/' + fp);
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  };
  let fp = filePath;
  if (fp) { const b = await dl(fp); if (b) return b; }
  // 缓存的 file_path 失效/为空 → 强制重新 getFile 获取新路径
  const r = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + fileId);
  const d = await r.json();
  if (!d.ok) return null;
  return await dl(d.result.file_path);
}

async function fetchTgFileWithRetry(fileId, filePath, env, retries) {
  for (let i = 0; i < retries; i++) {
    const buf = await fetchTgFile(fileId, filePath, env);
    if (buf) return buf;
    if (i < retries - 1) await sleep(500 * (i + 1));
  }
  return null;
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
