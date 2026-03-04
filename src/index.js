/**
 * ⚡ R2 Manager Worker — Enhanced Edition
 *
 * Endpoints:
 *   GET    /              - Dashboard UI
 *   GET    /list          - List objects (prefix, limit, cursor)
 *   GET    /stats         - Storage statistics
 *   GET    /download      - Download / proxy file
 *   PUT    /upload        - Upload file(s)
 *   DELETE /file          - Delete single file
 *   DELETE /folder        - Delete folder recursively
 *   POST   /rename        - Rename / move file
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function isAuthorized(request, env) {
  if (!env.AUTH_TOKEN) return true;
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.AUTH_TOKEN}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// ─── Stats ───────────────────────────────────────────────────────────────────

async function getStats(env) {
  let totalSize = 0;
  let totalObjects = 0;
  let cursor;
  const typeMap = {};

  do {
    const listed = await env.R2_BUCKET.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      totalSize += obj.size;
      totalObjects++;
      const ext = obj.key.split(".").pop().toLowerCase();
      typeMap[ext] = (typeMap[ext] || 0) + 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const topTypes = Object.entries(typeMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => ({ ext, count }));

  return json({ ok: true, totalObjects, totalSize, topTypes });
}

// ─── List Objects ─────────────────────────────────────────────────────────────

async function listObjects(env, prefix, limit = 100, cursor) {
  const listed = await env.R2_BUCKET.list({
    prefix: prefix || undefined,
    limit: Math.min(Number(limit), 1000),
    cursor: cursor || undefined,
    delimiter: "/",
  });

  return json({
    ok: true,
    count: listed.objects.length,
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
    commonPrefixes: listed.delimitedPrefixes || [],
    objects: listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      etag: o.etag,
      httpMetadata: o.httpMetadata,
    })),
  });
}

// ─── Upload ───────────────────────────────────────────────────────────────────

async function uploadFile(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) return err("Parameter 'key' wajib diisi");

  const contentType =
    request.headers.get("Content-Type") || "application/octet-stream";
  const body = request.body;
  if (!body) return err("Body kosong");

  await env.R2_BUCKET.put(key, body, {
    httpMetadata: { contentType },
  });

  return json({ ok: true, uploaded: key, contentType });
}

// ─── Download (proxy) ────────────────────────────────────────────────────────

async function downloadFile(env, key) {
  if (!key) return err("Parameter 'key' wajib diisi");

  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return err(`File tidak ditemukan: ${key}`, 404);

  const filename = key.split("/").pop();
  const headers = new Headers();
  headers.set(
    "Content-Type",
    obj.httpMetadata?.contentType || "application/octet-stream"
  );
  headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );
  headers.set("Content-Length", obj.size);

  return new Response(obj.body, { headers });
}

// ─── Delete File ──────────────────────────────────────────────────────────────

async function deleteFile(env, key) {
  if (!key) return err("Parameter 'key' wajib diisi");
  const head = await env.R2_BUCKET.head(key);
  if (!head) return err(`File tidak ditemukan: ${key}`, 404);
  await env.R2_BUCKET.delete(key);
  return json({ ok: true, deleted: key });
}

// ─── Delete Folder ────────────────────────────────────────────────────────────

async function deleteFolder(env, prefix) {
  if (!prefix) return err("Parameter 'prefix' wajib diisi");
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

  let cursor;
  const deletedKeys = [];

  do {
    const listed = await env.R2_BUCKET.list({
      prefix: normalizedPrefix,
      cursor,
      limit: 1000,
    });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await env.R2_BUCKET.delete(keys);
      deletedKeys.push(...keys);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return json({
    ok: true,
    message: `Berhasil menghapus ${deletedKeys.length} objek dari '${normalizedPrefix}'`,
    totalDeleted: deletedKeys.length,
    deleted: deletedKeys,
  });
}

// ─── Rename / Move ────────────────────────────────────────────────────────────

async function renameFile(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Body harus JSON: { from, to }");
  }

  const { from, to } = body;
  if (!from || !to) return err("Parameter 'from' dan 'to' wajib diisi");
  if (from === to) return err("Nama asal dan tujuan sama");

  const source = await env.R2_BUCKET.get(from);
  if (!source) return err(`File tidak ditemukan: ${from}`, 404);

  await env.R2_BUCKET.put(to, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  await env.R2_BUCKET.delete(from);

  return json({ ok: true, from, to });
}

// ─── Dashboard UI ─────────────────────────────────────────────────────────────

function dashboardHTML() {
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>R2 Manager</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@700;800&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060810;
  --surface:#0c1120;
  --surface2:#111827;
  --border:#1e2d45;
  --border2:#243352;
  --accent:#00d4ff;
  --accent2:#0099cc;
  --accent-glow:rgba(0,212,255,.15);
  --green:#00ff88;
  --green-dim:rgba(0,255,136,.1);
  --red:#ff4466;
  --red-dim:rgba(255,68,102,.1);
  --yellow:#ffd60a;
  --text:#cdd9f5;
  --muted:#4a6080;
  --muted2:#2a3a55;
  --font-mono:'Space Mono',monospace;
  --font-display:'Syne',sans-serif;
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);
  color:var(--text);
  font-family:var(--font-mono);
  font-size:13px;
  min-height:100vh;
  overflow-x:hidden;
}

/* scanline overlay */
body::after{
  content:'';
  position:fixed;
  inset:0;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.03) 4px);
  pointer-events:none;
  z-index:9999;
}

/* ─── HEADER ─── */
header{
  position:sticky;top:0;z-index:100;
  background:rgba(6,8,16,.9);
  backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border);
  padding:0 2rem;
  display:flex;align-items:center;justify-content:space-between;
  height:56px;
}
.logo{
  font-family:var(--font-display);
  font-size:1.1rem;
  font-weight:800;
  color:var(--accent);
  letter-spacing:.05em;
  text-shadow:0 0 20px var(--accent);
  display:flex;align-items:center;gap:.5rem;
}
.logo-dot{width:8px;height:8px;background:var(--green);border-radius:50%;box-shadow:0 0 8px var(--green);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}

.header-stats{display:flex;gap:1.5rem;align-items:center}
.stat-pill{
  font-size:.7rem;color:var(--muted);
  border:1px solid var(--border);
  border-radius:999px;
  padding:.2rem .75rem;
  transition:.2s;
}
.stat-pill span{color:var(--accent);font-weight:700}

/* ─── LAYOUT ─── */
.layout{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - 56px)}

/* ─── SIDEBAR ─── */
aside{
  border-right:1px solid var(--border);
  padding:1.5rem 1rem;
  display:flex;flex-direction:column;gap:.5rem;
  background:var(--surface);
}
.sidebar-label{
  font-size:.65rem;letter-spacing:.15em;
  color:var(--muted);text-transform:uppercase;
  padding:.5rem .75rem .3rem;
}
.nav-btn{
  display:flex;align-items:center;gap:.6rem;
  padding:.55rem .75rem;
  border-radius:6px;
  cursor:pointer;
  border:none;
  background:transparent;
  color:var(--muted);
  font-family:var(--font-mono);
  font-size:.8rem;
  text-align:left;
  width:100%;
  transition:.15s;
}
.nav-btn:hover{background:var(--surface2);color:var(--text)}
.nav-btn.active{background:var(--accent-glow);color:var(--accent);border:1px solid rgba(0,212,255,.2)}
.nav-btn .icon{font-size:1rem;width:20px;text-align:center}

/* ─── MAIN ─── */
main{display:flex;flex-direction:column;overflow:hidden}

.panel{display:none;flex-direction:column;height:calc(100vh - 56px);overflow:hidden}
.panel.active{display:flex}

.panel-header{
  padding:1.25rem 1.5rem;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;
}
.panel-title{
  font-family:var(--font-display);
  font-size:1rem;font-weight:700;
  color:var(--text);
  display:flex;align-items:center;gap:.5rem;
}
.panel-body{flex:1;overflow-y:auto;padding:1.5rem}

/* ─── FILE BROWSER ─── */
.browser-toolbar{
  display:flex;align-items:center;gap:.75rem;
  padding:.75rem 1.5rem;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  flex-shrink:0;
  flex-wrap:wrap;
}
.breadcrumb{
  display:flex;align-items:center;gap:.25rem;
  font-size:.75rem;flex:1;min-width:0;
  overflow:hidden;
}
.breadcrumb-item{
  color:var(--accent);cursor:pointer;
  white-space:nowrap;
}
.breadcrumb-item:hover{text-decoration:underline}
.breadcrumb-sep{color:var(--muted)}
.search-box{
  background:var(--surface2);
  border:1px solid var(--border2);
  border-radius:6px;
  color:var(--text);
  font-family:var(--font-mono);
  font-size:.78rem;
  padding:.4rem .75rem;
  outline:none;
  width:200px;
  transition:.2s;
}
.search-box:focus{border-color:var(--accent);width:240px}
.btn{
  display:inline-flex;align-items:center;gap:.4rem;
  padding:.4rem .85rem;
  border-radius:6px;
  border:none;
  font-family:var(--font-mono);
  font-size:.75rem;
  font-weight:700;
  cursor:pointer;
  transition:.15s;
  white-space:nowrap;
}
.btn-primary{background:var(--accent);color:#000}
.btn-primary:hover{opacity:.85}
.btn-danger{background:var(--red-dim);color:var(--red);border:1px solid rgba(255,68,102,.3)}
.btn-danger:hover{background:var(--red);color:#fff}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border2)}
.btn-ghost:hover{color:var(--text);border-color:var(--border)}
.btn:disabled{opacity:.35;cursor:not-allowed}

/* ─── FILE TABLE ─── */
.file-table-wrap{overflow-x:auto}
.file-table{width:100%;border-collapse:collapse}
.file-table th{
  text-align:left;font-size:.65rem;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted);
  padding:.6rem 1rem;border-bottom:1px solid var(--border);
  font-weight:400;white-space:nowrap;
}
.file-table td{
  padding:.6rem 1rem;border-bottom:1px solid var(--border);
  vertical-align:middle;
}
.file-table tr:hover td{background:rgba(0,212,255,.03)}
.file-table tr.selected td{background:rgba(0,212,255,.06)}

.file-name{
  display:flex;align-items:center;gap:.6rem;
  color:var(--text);cursor:pointer;
  font-size:.8rem;
}
.file-name:hover{color:var(--accent)}
.file-icon{font-size:1rem;flex-shrink:0}
.folder-row .file-name{color:var(--yellow)}
.file-size{color:var(--muted);font-size:.75rem;white-space:nowrap}
.file-date{color:var(--muted);font-size:.72rem;white-space:nowrap}

.action-btns{display:flex;gap:.4rem;opacity:0;transition:.15s}
.file-table tr:hover .action-btns{opacity:1}
.icon-btn{
  background:transparent;border:1px solid var(--border2);
  border-radius:4px;padding:.2rem .4rem;
  cursor:pointer;font-size:.8rem;transition:.15s;color:var(--muted);
}
.icon-btn:hover.copy{border-color:var(--accent);color:var(--accent)}
.icon-btn:hover.dl{border-color:var(--green);color:var(--green)}
.icon-btn:hover.rename{border-color:var(--yellow);color:var(--yellow)}
.icon-btn:hover.del{border-color:var(--red);color:var(--red)}

/* ─── EMPTY / LOADING ─── */
.empty-state{
  display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:.75rem;padding:4rem;color:var(--muted);
  font-size:.8rem;
}
.empty-state .big{font-size:2.5rem}
.loader{
  display:inline-block;width:16px;height:16px;
  border:2px solid var(--border2);border-top-color:var(--accent);
  border-radius:50%;animation:spin .6s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ─── UPLOAD PANEL ─── */
.drop-zone{
  border:2px dashed var(--border2);
  border-radius:12px;
  padding:3rem;
  text-align:center;
  cursor:pointer;
  transition:.2s;
  position:relative;
}
.drop-zone:hover,.drop-zone.drag-over{
  border-color:var(--accent);
  background:var(--accent-glow);
}
.drop-zone input[type=file]{
  position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;
}
.drop-icon{font-size:3rem;margin-bottom:1rem}
.drop-text{color:var(--muted);font-size:.85rem}
.drop-text strong{color:var(--accent)}

.upload-path-row{
  display:flex;gap:.75rem;margin-top:1.5rem;align-items:flex-end;
}
.field{display:flex;flex-direction:column;gap:.4rem;flex:1}
.field label{font-size:.7rem;color:var(--muted);letter-spacing:.05em}
.field input,.field select{
  background:var(--surface2);
  border:1px solid var(--border2);
  border-radius:6px;color:var(--text);
  font-family:var(--font-mono);font-size:.8rem;
  padding:.5rem .75rem;outline:none;
  transition:.2s;
}
.field input:focus,.field select:focus{border-color:var(--accent)}

.upload-queue{margin-top:1.5rem;display:flex;flex-direction:column;gap:.5rem}
.upload-item{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:8px;padding:.75rem 1rem;
  display:flex;align-items:center;gap:.75rem;
}
.upload-item-name{flex:1;font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.upload-item-size{color:var(--muted);font-size:.72rem;white-space:nowrap}
.progress-wrap{height:3px;background:var(--border);border-radius:999px;overflow:hidden;width:120px}
.progress-bar{height:100%;background:var(--accent);border-radius:999px;transition:width .3s}
.upload-status{font-size:.7rem;white-space:nowrap}
.upload-status.done{color:var(--green)}
.upload-status.fail{color:var(--red)}
.upload-status.pending{color:var(--muted)}

/* ─── STATS PANEL ─── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem}
.stat-card{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:10px;padding:1.25rem;
  position:relative;overflow:hidden;
}
.stat-card::before{
  content:'';position:absolute;top:-20px;right:-20px;
  width:80px;height:80px;border-radius:50%;
  background:var(--accent-glow);
}
.stat-card-label{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.stat-card-value{font-family:var(--font-display);font-size:1.8rem;font-weight:800;color:var(--accent);margin-top:.25rem}
.stat-card-sub{font-size:.7rem;color:var(--muted);margin-top:.2rem}

.type-bar{display:flex;flex-direction:column;gap:.5rem;margin-top:1rem}
.type-row{display:flex;align-items:center;gap:.75rem;font-size:.75rem}
.type-label{width:60px;color:var(--muted);text-transform:uppercase;font-size:.7rem}
.type-track{flex:1;height:6px;background:var(--border);border-radius:999px;overflow:hidden}
.type-fill{height:100%;background:var(--accent);border-radius:999px}
.type-count{color:var(--text);width:40px;text-align:right}

/* ─── LOG / TERMINAL ─── */
.terminal{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:10px;
  font-size:.78rem;line-height:1.8;
  padding:1.25rem;
  min-height:150px;max-height:350px;
  overflow-y:auto;
  white-space:pre-wrap;word-break:break-all;
}
.terminal .ok{color:var(--green)}
.terminal .fail{color:var(--red)}
.terminal .info{color:var(--accent)}
.terminal .dim{color:var(--muted)}
.terminal .warn{color:var(--yellow)}
.terminal-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:.5rem;
}
.terminal-title{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.terminal-clear{background:transparent;border:1px solid var(--border2);border-radius:4px;
  color:var(--muted);font-family:var(--font-mono);font-size:.7rem;padding:.15rem .5rem;cursor:pointer}
.terminal-clear:hover{color:var(--text)}

/* ─── MODAL ─── */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);
  z-index:200;display:flex;align-items:center;justify-content:center;
  opacity:0;pointer-events:none;transition:.2s;
}
.modal-overlay.open{opacity:1;pointer-events:all}
.modal{
  background:var(--surface);border:1px solid var(--border2);
  border-radius:12px;padding:1.5rem;
  width:min(440px,90vw);
  transform:translateY(10px);transition:.2s;
}
.modal-overlay.open .modal{transform:translateY(0)}
.modal h3{font-family:var(--font-display);font-size:1rem;color:var(--text);margin-bottom:1rem}
.modal-btns{display:flex;gap:.75rem;margin-top:1.25rem;justify-content:flex-end}

/* ─── PREVIEW MODAL ─── */
.preview-content{
  max-width:100%;max-height:60vh;object-fit:contain;
  border-radius:8px;display:block;margin:0 auto;
}
.preview-info{margin-top:1rem;font-size:.75rem;color:var(--muted);text-align:center}

/* ─── SCROLLBAR ─── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:999px}
::-webkit-scrollbar-thumb:hover{background:var(--muted2)}

/* ─── CHECKBOX ─── */
input[type=checkbox]{
  accent-color:var(--accent);
  width:14px;height:14px;cursor:pointer;
}

/* ─── TOAST ─── */
.toast-wrap{position:fixed;bottom:1.5rem;right:1.5rem;z-index:300;display:flex;flex-direction:column;gap:.5rem}
.toast{
  background:var(--surface2);border:1px solid var(--border2);
  border-radius:8px;padding:.6rem 1rem;font-size:.78rem;
  display:flex;align-items:center;gap:.5rem;
  animation:slideIn .2s ease;
  box-shadow:0 4px 20px rgba(0,0,0,.4);
}
@keyframes slideIn{from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}
.toast.ok{border-color:rgba(0,255,136,.3);color:var(--green)}
.toast.fail{border-color:rgba(255,68,102,.3);color:var(--red)}
.toast.info{border-color:rgba(0,212,255,.3);color:var(--accent)}

/* ─── RESPONSIVE ─── */
@media(max-width:640px){
  .layout{grid-template-columns:1fr}
  aside{flex-direction:row;border-right:none;border-bottom:1px solid var(--border);padding:.5rem;overflow-x:auto}
  .sidebar-label{display:none}
  .nav-btn span.label{display:none}
  .nav-btn{padding:.5rem}
  .header-stats{display:none}
}
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-dot"></div>
    R2 MANAGER
  </div>
  <div class="header-stats">
    <div class="stat-pill">Objects: <span id="hdr-objects">—</span></div>
    <div class="stat-pill">Storage: <span id="hdr-size">—</span></div>
  </div>
</header>

<div class="layout">
  <aside>
    <div class="sidebar-label">Navigation</div>
    <button class="nav-btn active" onclick="showPanel('browser')" id="nav-browser">
      <span class="icon">🗂️</span> <span class="label">File Browser</span>
    </button>
    <button class="nav-btn" onclick="showPanel('upload')" id="nav-upload">
      <span class="icon">📤</span> <span class="label">Upload</span>
    </button>
    <button class="nav-btn" onclick="showPanel('stats')" id="nav-stats">
      <span class="icon">📊</span> <span class="label">Statistics</span>
    </button>
    <button class="nav-btn" onclick="showPanel('api')" id="nav-api">
      <span class="icon">📡</span> <span class="label">API Docs</span>
    </button>
  </aside>

  <main>

    <!-- ═══ FILE BROWSER ═══ -->
    <section class="panel active" id="panel-browser">
      <div class="panel-header">
        <div class="panel-title">🗂️ File Browser</div>
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-danger" id="batch-del-btn" onclick="batchDelete()" disabled style="display:none">🗑️ Delete Selected (<span id="sel-count">0</span>)</button>
          <button class="btn btn-ghost" onclick="refreshBrowser()">↻ Refresh</button>
        </div>
      </div>

      <div class="browser-toolbar">
        <div class="breadcrumb" id="breadcrumb">
          <span class="breadcrumb-item" onclick="navigateTo('')">⌂ root</span>
        </div>
        <input class="search-box" id="search-box" type="text" placeholder="🔍 Search files..." oninput="filterFiles(this.value)"/>
      </div>

      <div class="panel-body" style="padding:0">
        <div id="file-browser-content">
          <div class="empty-state"><div class="loader"></div><div>Loading...</div></div>
        </div>
      </div>
    </section>

    <!-- ═══ UPLOAD ═══ -->
    <section class="panel" id="panel-upload">
      <div class="panel-header">
        <div class="panel-title">📤 Upload Files</div>
      </div>
      <div class="panel-body">
        <div class="drop-zone" id="drop-zone">
          <input type="file" multiple onchange="handleFileSelect(this.files)"/>
          <div class="drop-icon">📂</div>
          <div class="drop-text">
            <strong>Drag & drop</strong> file ke sini<br/>
            atau klik untuk pilih file
          </div>
        </div>

        <div class="upload-path-row">
          <div class="field" style="flex:2">
            <label>PREFIX / FOLDER TUJUAN</label>
            <input type="text" id="upload-prefix" placeholder="folder/subfolder/ (opsional)"/>
          </div>
          <div class="field">
            <label>TOKEN (jika aktif)</label>
            <input type="password" id="upload-token" placeholder="opsional"/>
          </div>
          <button class="btn btn-primary" onclick="startUpload()" id="upload-btn" disabled>⬆️ Upload All</button>
        </div>

        <div class="upload-queue" id="upload-queue"></div>

        <div style="margin-top:1.5rem">
          <div class="terminal-header">
            <div class="terminal-title">Upload Log</div>
            <button class="terminal-clear" onclick="clearLog('upload-log')">Clear</button>
          </div>
          <div class="terminal" id="upload-log"><span class="dim">Log upload akan muncul di sini...</span></div>
        </div>
      </div>
    </section>

    <!-- ═══ STATS ═══ -->
    <section class="panel" id="panel-stats">
      <div class="panel-header">
        <div class="panel-title">📊 Storage Statistics</div>
        <button class="btn btn-ghost" onclick="loadStats()">↻ Refresh</button>
      </div>
      <div class="panel-body">
        <div class="stats-grid" id="stats-grid">
          <div class="empty-state"><div class="loader"></div></div>
        </div>
        <div id="stats-types"></div>
      </div>
    </section>

    <!-- ═══ API DOCS ═══ -->
    <section class="panel" id="panel-api">
      <div class="panel-header">
        <div class="panel-title">📡 API Reference</div>
      </div>
      <div class="panel-body">
        <div style="display:flex;flex-direction:column;gap:.75rem;max-width:700px">
          ${[
            ["GET","/" ,"Dashboard UI","—"],
            ["GET","/list","List objects","?prefix=folder/&limit=100&cursor=TOKEN"],
            ["GET","/stats","Storage statistics","—"],
            ["GET","/download","Download file","?key=path/to/file.jpg"],
            ["PUT","/upload","Upload file","?key=path/to/file.jpg (body: raw file)"],
            ["DELETE","/file","Delete single file","?key=path/to/file.jpg"],
            ["DELETE","/folder","Delete folder recursively","?prefix=folder/name"],
            ["POST","/rename","Rename / move file","body: {from, to}"],
          ].map(([m,p,d,q])=>`
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:1rem">
            <div style="display:flex;align-items:baseline;gap:.75rem;margin-bottom:.3rem">
              <span style="color:${m==='GET'?'var(--green)':m==='DELETE'?'var(--red)':m==='PUT'?'var(--yellow)':'var(--accent)'};font-weight:700;font-size:.8rem">${m}</span>
              <span style="color:var(--accent);font-size:.85rem">${p}</span>
              <span style="color:var(--muted);font-size:.72rem;margin-left:auto">${d}</span>
            </div>
            <div style="color:var(--muted);font-size:.72rem;font-style:italic">${q}</div>
          </div>`).join('')}
        </div>
      </div>
    </section>

  </main>
</div>

<!-- ─── MODALS ─── -->
<div class="modal-overlay" id="rename-modal">
  <div class="modal">
    <h3>✏️ Rename / Move File</h3>
    <div class="field" style="margin-bottom:.75rem">
      <label>FROM (current key)</label>
      <input type="text" id="rename-from" readonly style="opacity:.6"/>
    </div>
    <div class="field">
      <label>TO (new key)</label>
      <input type="text" id="rename-to"/>
    </div>
    <div class="modal-btns">
      <button class="btn btn-ghost" onclick="closeModal('rename-modal')">Cancel</button>
      <button class="btn btn-primary" onclick="confirmRename()">Rename</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="preview-modal">
  <div class="modal" style="max-width:600px">
    <h3 id="preview-title">Preview</h3>
    <div id="preview-body"></div>
    <div class="modal-btns">
      <button class="btn btn-ghost" onclick="closeModal('preview-modal')">Close</button>
      <button class="btn btn-primary" id="preview-dl-btn">⬇️ Download</button>
    </div>
  </div>
</div>

<!-- ─── TOAST ─── -->
<div class="toast-wrap" id="toast-wrap"></div>

<script>
// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
let currentPrefix = '';
let allObjects = [];
let selectedKeys = new Set();
let statsLoaded = false;

// ═══════════════════════════════════════════════════════════
// Panel navigation
// ═══════════════════════════════════════════════════════════
function showPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.getElementById('nav-' + id).classList.add('active');
  if (id === 'stats' && !statsLoaded) loadStats();
}

// ═══════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════
function toast(msg, type = 'info', duration = 3000) {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ═══════════════════════════════════════════════════════════
// Log
// ═══════════════════════════════════════════════════════════
function log(id, msg, cls='') {
  const el = document.getElementById(id);
  const t = new Date().toLocaleTimeString('id-ID');
  el.innerHTML += \`\\n<span class="\${cls}">[\${t}] \${msg}</span>\`;
  el.scrollTop = el.scrollHeight;
}
function clearLog(id) { document.getElementById(id).innerHTML = ''; }

// ═══════════════════════════════════════════════════════════
// Auth header
// ═══════════════════════════════════════════════════════════
function authHeaders(token) {
  const h = {};
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

// ═══════════════════════════════════════════════════════════
// Format helpers
// ═══════════════════════════════════════════════════════════
function fmtSize(bytes) {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k,i)).toFixed(1) + ' ' + sizes[i];
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('id-ID', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function fileIcon(key) {
  const ext = key.split('.').pop().toLowerCase();
  const imgs = ['jpg','jpeg','png','gif','webp','svg','avif','ico'];
  const vids = ['mp4','mov','avi','mkv','webm'];
  const auds = ['mp3','wav','ogg','flac','m4a'];
  const docs = ['pdf','doc','docx','xls','xlsx','ppt','pptx'];
  const code = ['js','ts','py','go','rs','java','php','html','css','json','yaml','yml','toml','sh'];
  const arch = ['zip','rar','tar','gz','7z'];
  if (imgs.includes(ext)) return '🖼️';
  if (vids.includes(ext)) return '🎬';
  if (auds.includes(ext)) return '🎵';
  if (docs.includes(ext)) return '📄';
  if (code.includes(ext)) return '💾';
  if (arch.includes(ext)) return '📦';
  return '📃';
}
function isImage(key) {
  return /\\.(jpg|jpeg|png|gif|webp|svg|avif)$/i.test(key);
}

// ═══════════════════════════════════════════════════════════
// BROWSER — Load & Render
// ═══════════════════════════════════════════════════════════
async function loadBrowser(prefix = '') {
  currentPrefix = prefix;
  selectedKeys.clear();
  updateBatchBtn();

  const content = document.getElementById('file-browser-content');
  content.innerHTML = '<div class="empty-state"><div class="loader"></div><div>Loading...</div></div>';

  updateBreadcrumb(prefix);

  try {
    const res = await fetch('/list?prefix=' + encodeURIComponent(prefix) + '&limit=500');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    allObjects = [];

    // Folders
    (data.commonPrefixes || []).forEach(p => {
      allObjects.push({ type: 'folder', key: p, name: p.replace(prefix, '').replace(/\\/$/, '') });
    });

    // Files
    (data.objects || []).forEach(o => {
      allObjects.push({ type: 'file', ...o, name: o.key.replace(prefix, '') });
    });

    renderFiles(allObjects);

  } catch(e) {
    content.innerHTML = \`<div class="empty-state"><div>❌ Error: \${e.message}</div></div>\`;
  }
}

function renderFiles(items) {
  const content = document.getElementById('file-browser-content');

  if (items.length === 0) {
    content.innerHTML = '<div class="empty-state"><div class="big">📭</div><div>Folder kosong</div></div>';
    return;
  }

  const rows = items.map(item => {
    if (item.type === 'folder') {
      return \`<tr class="folder-row">
        <td><input type="checkbox" onchange="toggleSelect('\${item.key}',this)"/></td>
        <td><div class="file-name" onclick="navigateTo('\${item.key}')"><span class="file-icon">📁</span>\${item.name}</div></td>
        <td class="file-size">—</td>
        <td class="file-date">—</td>
        <td>
          <div class="action-btns">
            <button class="icon-btn del" title="Delete folder" onclick="promptDeleteFolder('\${item.key}')">🗑️</button>
          </div>
        </td>
      </tr>\`;
    }
    const key = item.key;
    const name = item.name;
    return \`<tr id="row-\${btoa(key).replace(/=/g,'')}">
      <td><input type="checkbox" onchange="toggleSelect('\${escHtml(key)}',this)"/></td>
      <td><div class="file-name" onclick="previewFile('\${escHtml(key)}')"><span class="file-icon">\${fileIcon(name)}</span>\${escHtml(name)}</div></td>
      <td class="file-size">\${fmtSize(item.size)}</td>
      <td class="file-date">\${fmtDate(item.uploaded)}</td>
      <td>
        <div class="action-btns">
          <button class="icon-btn copy" title="Copy URL" onclick="copyUrl('\${escHtml(key)}')">📋</button>
          <button class="icon-btn dl" title="Download" onclick="downloadFile('\${escHtml(key)}')">⬇️</button>
          <button class="icon-btn rename" title="Rename" onclick="openRename('\${escHtml(key)}')">✏️</button>
          <button class="icon-btn del" title="Delete" onclick="promptDeleteFile('\${escHtml(key)}')">🗑️</button>
        </div>
      </td>
    </tr>\`;
  }).join('');

  content.innerHTML = \`
  <div class="file-table-wrap">
    <table class="file-table">
      <thead><tr>
        <th style="width:32px"><input type="checkbox" onchange="toggleAll(this)"/></th>
        <th>Name</th><th>Size</th><th>Uploaded</th><th style="width:120px">Actions</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function filterFiles(q) {
  if (!q) { renderFiles(allObjects); return; }
  const filtered = allObjects.filter(o => o.key.toLowerCase().includes(q.toLowerCase()));
  renderFiles(filtered);
}

function refreshBrowser() { loadBrowser(currentPrefix); }

// ═══════════════════════════════════════════════════════════
// Breadcrumb
// ═══════════════════════════════════════════════════════════
function updateBreadcrumb(prefix) {
  const bc = document.getElementById('breadcrumb');
  const parts = prefix ? prefix.split('/').filter(Boolean) : [];
  let html = \`<span class="breadcrumb-item" onclick="navigateTo('')">⌂ root</span>\`;
  let built = '';
  parts.forEach(p => {
    built += p + '/';
    const path = built;
    html += \`<span class="breadcrumb-sep">/</span><span class="breadcrumb-item" onclick="navigateTo('\${path}')">\${p}</span>\`;
  });
  bc.innerHTML = html;
}

function navigateTo(prefix) {
  document.getElementById('search-box').value = '';
  loadBrowser(prefix);
}

// ═══════════════════════════════════════════════════════════
// Selection
// ═══════════════════════════════════════════════════════════
function toggleSelect(key, cb) {
  if (cb.checked) selectedKeys.add(key);
  else selectedKeys.delete(key);
  updateBatchBtn();
}
function toggleAll(cb) {
  document.querySelectorAll('.file-table tbody input[type=checkbox]').forEach(c => {
    c.checked = cb.checked;
    const row = c.closest('tr');
    const key = allObjects.find(o => o.name === c.closest('tr').querySelector('.file-name')?.textContent?.trim())?.key;
  });
  if (cb.checked) allObjects.forEach(o => selectedKeys.add(o.key));
  else selectedKeys.clear();
  updateBatchBtn();
}
function updateBatchBtn() {
  const btn = document.getElementById('batch-del-btn');
  const cnt = document.getElementById('sel-count');
  cnt.textContent = selectedKeys.size;
  btn.style.display = selectedKeys.size > 0 ? 'flex' : 'none';
  btn.disabled = selectedKeys.size === 0;
}

// ═══════════════════════════════════════════════════════════
// File actions
// ═══════════════════════════════════════════════════════════
function copyUrl(key) {
  const url = location.origin + '/download?key=' + encodeURIComponent(key);
  navigator.clipboard.writeText(url);
  toast('📋 URL copied!', 'ok');
}

function downloadFile(key) {
  const a = document.createElement('a');
  a.href = '/download?key=' + encodeURIComponent(key);
  a.download = key.split('/').pop();
  a.click();
  toast('⬇️ Download started', 'info');
}

async function promptDeleteFile(key) {
  if (!confirm(\`Hapus file:\\n\${key}?\`)) return;
  try {
    const res = await fetch('/file?key=' + encodeURIComponent(key), { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) { toast('🗑️ Deleted: ' + key, 'ok'); refreshBrowser(); }
    else toast('❌ ' + data.error, 'fail');
  } catch(e) { toast('❌ ' + e.message, 'fail'); }
}

async function promptDeleteFolder(prefix) {
  if (!confirm(\`Hapus SELURUH isi folder:\\n\${prefix}?\\n\\nTindakan ini tidak bisa di-undo!\`)) return;
  try {
    const res = await fetch('/folder?prefix=' + encodeURIComponent(prefix), { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) { toast(\`🗑️ Deleted \${data.totalDeleted} objects\`, 'ok'); refreshBrowser(); }
    else toast('❌ ' + data.error, 'fail');
  } catch(e) { toast('❌ ' + e.message, 'fail'); }
}

async function batchDelete() {
  const keys = [...selectedKeys];
  if (!confirm(\`Hapus \${keys.length} item yang dipilih?\`)) return;
  let ok = 0, fail = 0;
  for (const key of keys) {
    try {
      const res = await fetch('/file?key=' + encodeURIComponent(key), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) ok++; else fail++;
    } catch { fail++; }
  }
  toast(\`🗑️ Deleted \${ok}\${fail ? ', failed '+fail : ''}\`, ok > 0 ? 'ok' : 'fail');
  selectedKeys.clear();
  refreshBrowser();
}

// ═══════════════════════════════════════════════════════════
// Rename
// ═══════════════════════════════════════════════════════════
function openRename(key) {
  document.getElementById('rename-from').value = key;
  document.getElementById('rename-to').value = key;
  openModal('rename-modal');
}

async function confirmRename() {
  const from = document.getElementById('rename-from').value;
  const to = document.getElementById('rename-to').value.trim();
  if (!to || to === from) { toast('⚠️ Nama tujuan sama atau kosong', 'fail'); return; }
  try {
    const res = await fetch('/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    const data = await res.json();
    if (data.ok) { toast('✏️ Renamed!', 'ok'); closeModal('rename-modal'); refreshBrowser(); }
    else toast('❌ ' + data.error, 'fail');
  } catch(e) { toast('❌ ' + e.message, 'fail'); }
}

// ═══════════════════════════════════════════════════════════
// Preview
// ═══════════════════════════════════════════════════════════
function previewFile(key) {
  const modal = document.getElementById('preview-modal');
  const title = document.getElementById('preview-title');
  const body = document.getElementById('preview-body');
  const dlBtn = document.getElementById('preview-dl-btn');

  title.textContent = key.split('/').pop();
  dlBtn.onclick = () => downloadFile(key);

  if (isImage(key)) {
    body.innerHTML = \`<img class="preview-content" src="/download?key=\${encodeURIComponent(key)}" alt="\${key}"/><div class="preview-info">\${key}</div>\`;
  } else {
    body.innerHTML = \`<div style="text-align:center;padding:2rem;color:var(--muted)">
      <div style="font-size:3rem">\${fileIcon(key)}</div>
      <div style="margin-top:.75rem">\${key}</div>
      <div style="font-size:.72rem;margin-top:.3rem">Preview tidak tersedia — klik Download</div>
    </div>\`;
  }
  openModal('preview-modal');
}

// ═══════════════════════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
});

// ═══════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════
let uploadFiles = [];

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFileSelect(e.dataTransfer.files);
});

function handleFileSelect(files) {
  uploadFiles = [...files];
  const queue = document.getElementById('upload-queue');
  queue.innerHTML = uploadFiles.map((f, i) => \`
    <div class="upload-item" id="uitem-\${i}">
      <span class="file-icon">\${fileIcon(f.name)}</span>
      <span class="upload-item-name" title="\${f.name}">\${f.name}</span>
      <span class="upload-item-size">\${fmtSize(f.size)}</span>
      <div class="progress-wrap"><div class="progress-bar" id="uprog-\${i}" style="width:0%"></div></div>
      <span class="upload-status pending" id="ustatus-\${i}">pending</span>
    </div>\`).join('');
  document.getElementById('upload-btn').disabled = uploadFiles.length === 0;
}

async function startUpload() {
  if (uploadFiles.length === 0) return;
  const prefix = document.getElementById('upload-prefix').value.trim();
  const token = document.getElementById('upload-token').value.trim();
  document.getElementById('upload-btn').disabled = true;

  log('upload-log', \`Starting upload of \${uploadFiles.length} file(s)...\`, 'info');

  for (let i = 0; i < uploadFiles.length; i++) {
    const file = uploadFiles[i];
    const key = (prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '') + file.name;
    const statusEl = document.getElementById('ustatus-' + i);
    const progEl = document.getElementById('uprog-' + i);

    statusEl.textContent = 'uploading...';
    statusEl.className = 'upload-status info';
    progEl.style.width = '30%';

    try {
      const res = await fetch('/upload?key=' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { ...authHeaders(token), 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      progEl.style.width = '100%';
      if (data.ok) {
        statusEl.textContent = '✓ done';
        statusEl.className = 'upload-status done';
        log('upload-log', \`✓ Uploaded: \${key}\`, 'ok');
        toast('✅ ' + file.name, 'ok', 2000);
      } else {
        throw new Error(data.error);
      }
    } catch(e) {
      progEl.style.background = 'var(--red)';
      progEl.style.width = '100%';
      statusEl.textContent = '✗ failed';
      statusEl.className = 'upload-status fail';
      log('upload-log', \`✗ Failed: \${key} — \${e.message}\`, 'fail');
      toast('❌ ' + file.name + ': ' + e.message, 'fail', 4000);
    }
  }

  log('upload-log', 'Upload selesai.', 'dim');
  document.getElementById('upload-btn').disabled = false;
  uploadFiles = [];
  refreshBrowser();
}

// ═══════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════
async function loadStats() {
  statsLoaded = true;
  const grid = document.getElementById('stats-grid');
  const types = document.getElementById('stats-types');
  grid.innerHTML = '<div class="empty-state"><div class="loader"></div></div>';
  types.innerHTML = '';

  try {
    const res = await fetch('/stats');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    // Update header
    document.getElementById('hdr-objects').textContent = data.totalObjects.toLocaleString('id');
    document.getElementById('hdr-size').textContent = fmtSize(data.totalSize);

    grid.innerHTML = \`
      <div class="stat-card">
        <div class="stat-card-label">Total Objects</div>
        <div class="stat-card-value">\${data.totalObjects.toLocaleString('id')}</div>
        <div class="stat-card-sub">files & folders</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Total Storage</div>
        <div class="stat-card-value">\${fmtSize(data.totalSize)}</div>
        <div class="stat-card-sub">used space</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Avg File Size</div>
        <div class="stat-card-value">\${data.totalObjects ? fmtSize(Math.round(data.totalSize / data.totalObjects)) : '—'}</div>
        <div class="stat-card-sub">per object</div>
      </div>\`;

    if (data.topTypes && data.topTypes.length > 0) {
      const max = data.topTypes[0].count;
      types.innerHTML = \`
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1.25rem;margin-top:1rem;max-width:500px">
          <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:1rem">Top File Types</div>
          <div class="type-bar">
            \${data.topTypes.map(t => \`
              <div class="type-row">
                <div class="type-label">.\${t.ext}</div>
                <div class="type-track"><div class="type-fill" style="width:\${Math.round(t.count/max*100)}%"></div></div>
                <div class="type-count">\${t.count}</div>
              </div>\`).join('')}
          </div>
        </div>\`;
    }
  } catch(e) {
    grid.innerHTML = \`<div class="empty-state">❌ \${e.message}</div>\`;
  }
}

// ═══════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════
loadBrowser('');
// Load header stats silently
fetch('/stats').then(r => r.json()).then(d => {
  if (d.ok) {
    document.getElementById('hdr-objects').textContent = d.totalObjects.toLocaleString('id');
    document.getElementById('hdr-size').textContent = fmtSize(d.totalSize);
  }
}).catch(() => {});
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    // Dashboard — no auth required
    if (method === "GET" && pathname === "/") {
      return dashboardHTML();
    }

    // Auth check for all other endpoints
    if (!isAuthorized(request, env)) {
      return err("Unauthorized", 401);
    }

    // GET /list
    if (method === "GET" && pathname === "/list") {
      return listObjects(
        env,
        url.searchParams.get("prefix") || "",
        url.searchParams.get("limit") || 500,
        url.searchParams.get("cursor") || ""
      );
    }

    // GET /stats
    if (method === "GET" && pathname === "/stats") {
      return getStats(env);
    }

    // GET /download
    if (method === "GET" && pathname === "/download") {
      return downloadFile(env, url.searchParams.get("key") || "");
    }

    // PUT /upload
    if (method === "PUT" && pathname === "/upload") {
      return uploadFile(request, env);
    }

    // DELETE /file
    if (method === "DELETE" && pathname === "/file") {
      return deleteFile(env, url.searchParams.get("key") || "");
    }

    // DELETE /folder
    if (method === "DELETE" && pathname === "/folder") {
      return deleteFolder(env, url.searchParams.get("prefix") || "");
    }

    // POST /rename
    if (method === "POST" && pathname === "/rename") {
      return renameFile(request, env);
    }

    return err("Endpoint tidak ditemukan", 404);
  },
};
