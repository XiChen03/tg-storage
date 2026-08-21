const MAX_RETRIES = 3;
const CHUNK_SIZE = 16 * 1024 * 1024;

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
      else if (path.startsWith('/f/') && (request.method === 'GET' || request.method === 'HEAD'))
        res = await handleDownload(path.substring(3), request, env);
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
async function handleUpload(request, env) {
  if (request.headers.get('X-Store-Key') !== env.STORE_KEY)
    return json({ error: 'unauthorized' }, 401);
  const fd = await request.formData();
  const file = fd.get('file');
  if (!file) return json({ error: 'no file' }, 400);
  const ext = (file.name || 'file').split('.').pop().toLowerCase();
  const mime = file.type || 'application/octet-stream';
  const m = resolveMethod(mime, ext);
  let lastErr;
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
      if (!data.ok) throw new Error(data.description || 'TG API error');
      const r = data.result;
      let fi;
      if (r.photo) fi = r.photo.reduce((a, b) => a.file_size > b.file_size ? a : b);
      else fi = r.video || r.animation || r.document || r.audio;
      if (!fi) throw new Error('unexpected response');
      let filePath = null;
      try {
        const fr = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + fi.file_id);
        const fd2 = await fr.json();
        if (fd2.ok) filePath = fd2.result.file_path;
      } catch (_) {}
      // 提取缩略图（图片/视频 TG 自动生成）
      let thumbFid = null, thumbFp = null, thumbMid = null;
      const thumb = (r.photo ? r.photo.reduce((a, b) => a.file_size < b.file_size ? a : b) : null)
        || (r.video && r.video.thumb) || (r.animation && r.animation.thumb);
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
      if (i < MAX_RETRIES - 1) await sleep(1000 * (i + 1));
    }
  }
  return json({ error: 'upload failed: ' + lastErr.message }, 500);
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
  const rng = parseRange(request.headers.get('Range'), total);
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
        for (const c of chunks) {
          const cStart = c.index * CHUNK_SIZE;
          const cEnd = cStart + c.size - 1;
          if (rng && (cEnd < rng.start || cStart > rng.end)) { pos += c.size; continue; }
          const buf = await fetchTgFileWithRetry(c.fid, c.filePath, env, 3);
          if (!buf) throw new Error('chunk ' + c.index + ' failed');
          const s = rng ? Math.max(0, rng.start - pos) : 0;
          const e = rng ? Math.min(buf.byteLength, rng.end - pos + 1) : buf.byteLength;
          if (s < e) controller.enqueue(buf.slice(s, e));
          pos += c.size;
          if (rng && pos > rng.end) break;
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
async function handleDelete(fileId, request, env) {
  if (request.headers.get('X-Store-Key') !== env.STORE_KEY)
    return json({ error: 'unauthorized' }, 401);
  if (!fileId || fileId.includes('..'))
    return json({ error: 'invalid id' }, 400);
  const url = new URL(request.url);
  const msgIds = (url.searchParams.get('msgIds') || '').split(',').filter(Boolean);
  if (!msgIds.length) return json({ error: 'no msgIds' }, 400);
  const base = env.TG_API_URL || 'https://api.telegram.org';
  const results = [];
  for (const mid of msgIds) {
    try {
      const resp = await fetch(base + '/bot' + env.BOT_TOKEN + '/deleteMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.CHAT_ID, message_id: parseInt(mid) })
      });
      const d = await resp.json();
      results.push({ message_id: parseInt(mid), ok: d.ok });
    } catch (e) {
      results.push({ message_id: parseInt(mid), ok: false, error: e.message });
    }
  }
  return json({ ok: true, results: results });
}

// ===================== HELPERS =====================
function resolveMethod(mime, ext) {
  if (ext === 'gif' || ext === 'webp')
    return { method: 'sendAnimation', typeName: 'animation', outName: (ext === 'gif' ? 'a.gif' : 'a.webp').replace(/\.\w+$/, '.jpeg') };
  if (mime.startsWith('video/'))
    return { method: 'sendVideo', typeName: 'video', outName: 'v.mp4' };
  if (mime.startsWith('audio/'))
    return { method: 'sendAudio', typeName: 'audio', outName: 'a.mp3' };
  return { method: 'sendDocument', typeName: 'document', outName: 'f.' + ext };
}

async function fetchManifest(fileId, env) {
  const key = 'tgstore/' + fileId + '.json';
  const resp = await fetch(env.ORIGIN_URL + '/' + key, {
    headers: { 'X-Store-Key': env.STORE_KEY }
  });
  if (!resp.ok) return null;
  return await resp.json();
}

async function fetchTgFile(fileId, filePath, env) {
  const base = env.TG_API_URL || 'https://api.telegram.org';
  let fp = filePath;
  if (!fp) {
    const r = await fetch(base + '/bot' + env.BOT_TOKEN + '/getFile?file_id=' + fileId);
    const d = await r.json();
    if (!d.ok) return null;
    fp = d.result.file_path;
  }
  const r = await fetch(base + '/file/bot' + env.BOT_TOKEN + '/' + fp);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
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
  const m = header.match(/bytes=(\d+)-(\d*)/);
  if (!m) return null;
  const start = parseInt(m[1]);
  const end = m[2] ? parseInt(m[2]) : total - 1;
  if (start >= total || end >= total || start > end) return null;
  return { start: start, end: end };
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
