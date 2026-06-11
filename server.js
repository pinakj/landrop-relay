const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const app = express();

// ── Storage ──────────────────────────────────────────────────────────────────
// Files land on disk so large payloads don't blow up memory.
const storage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (_req, _file, cb) => cb(null, `landrop-${crypto.randomBytes(8).toString('hex')}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB

// ── Transfer store ────────────────────────────────────────────────────────────
// id → { senderName, fileName, contentType, filePath, state, createdAt }
const transfers = new Map();
const TTL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, t] of transfers) {
    if (t.createdAt < cutoff) {
      if (t.filePath) fs.rm(t.filePath, { force: true }, () => {});
      transfers.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.headers.host}`;
}

function html(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:40px;background:#f7f7f3;color:#1f2a24}
  main{max-width:540px;margin:auto}
  h1{margin-top:0}
  .name{font-weight:700;color:#1f2a24}
  .file{color:#3d5a47;word-break:break-all}
  .actions{display:flex;gap:12px;margin-top:28px;flex-wrap:wrap}
  button,.btn{display:inline-block;padding:14px 32px;font-size:18px;font-weight:600;border:0;border-radius:8px;cursor:pointer;text-decoration:none}
  .accept{background:#1f815d;color:#fff}
  .decline{background:#e8ece8;color:#3d4a42}
  .muted{color:#5a6b60;font-size:15px;margin-top:16px}
</style></head>
<body><main>${body}</main></body></html>`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function approvePage(senderName, fileName, id) {
  return html('LANDrop — incoming file',
    `<h1>Incoming file</h1>
     <p><span class="name">${esc(senderName)}</span> wants to send you:</p>
     <p class="file">📄 ${esc(fileName)}</p>
     <div class="actions">
       <form method="post" action="/r/${id}/accept">
         <button class="btn accept" type="submit">Accept &amp; Download</button>
       </form>
       <form method="post" action="/r/${id}/decline">
         <button class="btn decline" type="submit">Decline</button>
       </form>
     </div>
     <p class="muted">This link expires in 1 hour and can only be downloaded once.</p>`);
}

function declinedPage() {
  return html('LANDrop — declined',
    `<h1>Declined</h1><p>You declined the incoming file. This transfer has been discarded.</p>`);
}

function preparingPage(senderName, fileName, id) {
  return html('LANDrop — preparing…',
    `<h1>Preparing transfer…</h1>
     <p><span class="name">${esc(senderName)}</span> is sending you <span class="file">${esc(fileName)}</span>.</p>
     <p class="muted">The file is still uploading. This page will refresh automatically.</p>
     <script>
       (function poll() {
         fetch('/r/${id}/status').then(r=>r.json()).then(d=>{
           if (d.state !== 'preparing') location.reload();
           else setTimeout(poll, 1500);
         }).catch(()=>setTimeout(poll,2000));
       })();
     </script>`);
}

function errorPage(msg) {
  return html('LANDrop — error', `<h1>Oops</h1><p>${esc(msg)}</p>`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /register  — creates a transfer record and returns the public URL immediately,
// before any file data is sent. The client then uploads the file separately.
app.post('/register', express.json(), (req, res) => {
  const senderName  = String(req.body?.senderName  || 'Someone').slice(0, 120);
  const fileName    = String(req.body?.fileName    || 'file').slice(0, 255);
  const contentType = String(req.body?.contentType || 'application/octet-stream');

  const id = crypto.randomBytes(5).toString('hex');
  transfers.set(id, {
    senderName, fileName, contentType,
    filePath: null,
    state: 'preparing',   // waiting for the file upload to finish
    createdAt: Date.now(),
  });

  res.json({ id, url: `${baseUrl(req)}/r/${id}`, expiresIn: 3600 });
});

// PUT /r/:id/upload-stream  — streams the file for a pre-registered transfer.
app.put('/r/:id/upload-stream', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transfer not found.' });
  if (t.state !== 'preparing') return res.status(409).json({ error: 'Already uploaded.' });

  const tmpPath = path.join(os.tmpdir(), `landrop-${crypto.randomBytes(8).toString('hex')}`);
  const out     = fs.createWriteStream(tmpPath);

  req.pipe(out);

  out.on('error', (err) => {
    fs.rm(tmpPath, { force: true }, () => {});
    res.status(500).json({ error: `Write error: ${err.message}` });
  });

  out.on('finish', () => {
    t.filePath = tmpPath;
    t.state    = 'pending';
    res.json({ ok: true });
  });
});

// PUT /upload-stream  — legacy single-step upload (kept for older clients).
app.put('/upload-stream', (req, res) => {
  const senderName  = String(req.query.senderName  || 'Someone').slice(0, 120);
  const fileName    = String(req.query.fileName    || 'file').slice(0, 255);
  const contentType = String(req.query.contentType || 'application/octet-stream');

  const tmpPath = path.join(os.tmpdir(), `landrop-${crypto.randomBytes(8).toString('hex')}`);
  const out     = fs.createWriteStream(tmpPath);

  req.pipe(out);

  out.on('error', (err) => {
    fs.rm(tmpPath, { force: true }, () => {});
    res.status(500).json({ error: `Write error: ${err.message}` });
  });

  out.on('finish', () => {
    const id = crypto.randomBytes(5).toString('hex');
    transfers.set(id, {
      senderName, fileName, contentType,
      filePath: tmpPath,
      state: 'pending',
      createdAt: Date.now(),
    });
    res.json({ id, url: `${baseUrl(req)}/r/${id}`, expiresIn: 3600 });
  });
});

// POST /upload  — sender uploads the file, gets back a public URL
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });

  const id          = crypto.randomBytes(5).toString('hex'); // 10-char
  const senderName  = String(req.body.senderName  || 'Someone').slice(0, 120);
  const fileName    = String(req.body.fileName    || req.file.originalname || 'file').slice(0, 255);
  const contentType = String(req.body.contentType || req.file.mimetype || 'application/octet-stream');

  transfers.set(id, {
    senderName, fileName, contentType,
    filePath: req.file.path,
    state: 'pending',
    createdAt: Date.now(),
  });

  res.json({ id, url: `${baseUrl(req)}/r/${id}`, expiresIn: 3600 });
});

// GET /r/:id  — approval page shown to the receiver
app.get('/r/:id', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!t) return res.status(404).send(errorPage('This transfer has expired or does not exist.'));
  if (t.state === 'downloaded') return res.status(410).send(errorPage('This file has already been downloaded.'));
  if (t.state === 'declined')   return res.status(410).send(declinedPage());
  if (t.state === 'preparing')  return res.send(preparingPage(t.senderName, t.fileName, req.params.id));
  res.send(approvePage(t.senderName, t.fileName, req.params.id));
});

// POST /r/:id/accept  — receiver accepts; redirects straight to download
app.post('/r/:id/accept', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!t) return res.status(404).send(errorPage('Transfer not found or expired.'));
  t.state = 'accepted';
  res.redirect(303, `/r/${req.params.id}/download`);
});

// GET /r/:id/download  — streams the file to the receiver
app.get('/r/:id/download', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!t || t.state === 'pending') return res.status(403).send(errorPage('Accept the transfer first.'));
  if (!fs.existsSync(t.filePath))  return res.status(410).send(errorPage('File no longer available.'));

  const safeName = t.fileName.replace(/"/g, '').replace(/[\r\n]/g, '');
  res.setHeader('Content-Type', t.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Length', fs.statSync(t.filePath).size);

  const stream = fs.createReadStream(t.filePath);
  stream.pipe(res);
  stream.on('close', () => {
    t.state = 'downloaded';
    fs.rm(t.filePath, { force: true }, () => {});
  });
});

// POST /r/:id/decline  — receiver declines
app.post('/r/:id/decline', (req, res) => {
  const t = transfers.get(req.params.id);
  if (t) {
    t.state = 'declined';
    fs.rm(t.filePath, { force: true }, () => {});
  }
  res.send(declinedPage());
});

// GET /r/:id/status  — sender polls this to track progress
app.get('/r/:id/status', (req, res) => {
  const t = transfers.get(req.params.id);
  res.json({ state: t ? t.state : 'expired' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LANDrop relay listening on port ${PORT}`));
