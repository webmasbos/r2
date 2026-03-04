/**
 * R2 Manager Worker
 * Endpoints:
 *   DELETE /file          - Hapus satu file
 *   DELETE /folder        - Hapus folder beserta seluruh isinya
 *   GET    /list          - List objek dalam bucket (opsional, untuk debugging)
 *   GET    /              - Dashboard UI
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

/**
 * Verifikasi Bearer token (opsional, aktifkan jika perlu)
 * Set AUTH_TOKEN di environment variable wrangler.toml / Cloudflare dashboard
 */
function isAuthorized(request, env) {
  if (!env.AUTH_TOKEN) return true; // Jika tidak ada token, skip auth
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.AUTH_TOKEN}`;
}

// ─── Core: Hapus satu file ───────────────────────────────────────────────────

async function deleteFile(env, key) {
  if (!key) return err("Parameter 'key' wajib diisi");

  // Cek apakah objek ada
  const head = await env.R2_BUCKET.head(key);
  if (!head) return err(`File tidak ditemukan: ${key}`, 404);

  await env.R2_BUCKET.delete(key);

  return json({ ok: true, deleted: key });
}

// ─── Core: Hapus folder (semua objek dengan prefix) ──────────────────────────

async function deleteFolder(env, prefix) {
  if (!prefix) return err("Parameter 'prefix' wajib diisi");

  // Pastikan prefix diakhiri '/' agar tidak salah hapus file lain
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

  let cursor;
  const deletedKeys = [];
  let totalDeleted = 0;

  do {
    // List maksimal 1000 objek per halaman
    const listed = await env.R2_BUCKET.list({
      prefix: normalizedPrefix,
      cursor,
      limit: 1000,
    });

    const keys = listed.objects.map((obj) => obj.key);

    if (keys.length > 0) {
      // R2 mendukung hapus batch hingga 1000 key sekaligus
      await env.R2_BUCKET.delete(keys);
      deletedKeys.push(...keys);
      totalDeleted += keys.length;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (totalDeleted === 0) {
    return json({
      ok: true,
      message: `Folder '${normalizedPrefix}' kosong atau tidak ditemukan`,
      totalDeleted: 0,
      deleted: [],
    });
  }

  return json({
    ok: true,
    message: `Berhasil menghapus ${totalDeleted} objek dari '${normalizedPrefix}'`,
    totalDeleted,
    deleted: deletedKeys,
  });
}

// ─── Core: List objek ────────────────────────────────────────────────────────

async function listObjects(env, prefix, limit = 100) {
  const listed = await env.R2_BUCKET.list({
    prefix: prefix || undefined,
    limit: Math.min(Number(limit), 1000),
  });

  return json({
    ok: true,
    count: listed.objects.length,
    truncated: listed.truncated,
    objects: listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      etag: o.etag,
    })),
  });
}

// ─── Dashboard UI ────────────────────────────────────────────────────────────

function dashboardHTML() {
  return new Response(
    `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>R2 Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d0f14;
      --surface: #161a24;
      --border: #252a38;
      --accent: #f97316;
      --accent-dim: #7c3410;
      --text: #e2e8f0;
      --muted: #64748b;
      --success: #22c55e;
      --danger: #ef4444;
      --code-bg: #0a0c10;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    header {
      text-align: center;
      margin-bottom: 3rem;
    }
    header h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--accent);
    }
    header p { color: var(--muted); margin-top: 0.4rem; font-size: 0.85rem; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 1.5rem;
      max-width: 900px;
      margin: 0 auto 2.5rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
    }
    .card h2 {
      font-size: 1rem;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    label { display: block; font-size: 0.78rem; color: var(--muted); margin-bottom: 0.3rem; }
    input {
      width: 100%;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-family: inherit;
      font-size: 0.85rem;
      padding: 0.55rem 0.75rem;
      margin-bottom: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: var(--accent); }
    button {
      width: 100%;
      background: var(--accent);
      color: #fff;
      font-family: inherit;
      font-size: 0.85rem;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      padding: 0.6rem;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.danger { background: var(--danger); }

    .log-area {
      max-width: 900px;
      margin: 0 auto;
    }
    .log-area h2 {
      font-size: 0.9rem;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    #log {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      font-size: 0.8rem;
      line-height: 1.7;
      min-height: 180px;
      max-height: 420px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ok   { color: var(--success); }
    .fail { color: var(--danger); }
    .info { color: var(--accent); }
    .dim  { color: var(--muted); }

    .docs {
      max-width: 900px;
      margin: 2.5rem auto 0;
      border-top: 1px solid var(--border);
      padding-top: 2rem;
    }
    .docs h2 { font-size: 0.9rem; color: var(--muted); margin-bottom: 1rem; }
    .endpoint {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.9rem 1.1rem;
      margin-bottom: 0.75rem;
      font-size: 0.78rem;
      line-height: 1.8;
    }
    .method { color: var(--danger); font-weight: 700; }
    .path   { color: var(--accent); }
    .param  { color: #94a3b8; }
  </style>
</head>
<body>
  <header>
    <h1>⚡ R2 Manager</h1>
    <p>Kelola objek Cloudflare R2 — hapus file &amp; folder dengan mudah</p>
  </header>

  <div class="grid">
    <!-- Hapus File -->
    <div class="card">
      <h2>🗑️ Hapus File</h2>
      <label for="fileKey">Key / Path file</label>
      <input id="fileKey" type="text" placeholder="folder/subfolder/nama-file.jpg" />
      <label for="fileToken">Bearer Token (jika aktif)</label>
      <input id="fileToken" type="password" placeholder="opsional" />
      <button class="danger" onclick="deleteFile()">Hapus File</button>
    </div>

    <!-- Hapus Folder -->
    <div class="card">
      <h2>📁 Hapus Folder &amp; Isinya</h2>
      <label for="folderPrefix">Prefix / Path folder</label>
      <input id="folderPrefix" type="text" placeholder="folder/subfolder" />
      <label for="folderToken">Bearer Token (jika aktif)</label>
      <input id="folderToken" type="password" placeholder="opsional" />
      <button class="danger" onclick="deleteFolder()">Hapus Folder</button>
    </div>

    <!-- List Objek -->
    <div class="card">
      <h2>📋 List Objek</h2>
      <label for="listPrefix">Prefix (kosongkan untuk semua)</label>
      <input id="listPrefix" type="text" placeholder="folder/ (opsional)" />
      <label for="listLimit">Limit</label>
      <input id="listLimit" type="number" value="50" min="1" max="1000" />
      <button onclick="listObjects()">Tampilkan List</button>
    </div>
  </div>

  <div class="log-area">
    <h2>📟 Output</h2>
    <div id="log"><span class="dim">Hasil operasi akan muncul di sini...</span></div>
  </div>

  <div class="docs">
    <h2>📡 API Endpoints</h2>
    <div class="endpoint">
      <span class="method">DELETE</span> <span class="path">/file</span><br/>
      <span class="param">?key=path/to/file.jpg</span> — Hapus satu file
    </div>
    <div class="endpoint">
      <span class="method">DELETE</span> <span class="path">/folder</span><br/>
      <span class="param">?prefix=folder/subfolder</span> — Hapus folder beserta seluruh isinya (rekursif)
    </div>
    <div class="endpoint">
      <span class="method">GET</span> <span class="path">/list</span><br/>
      <span class="param">?prefix=folder/&amp;limit=100</span> — List objek dalam bucket
    </div>
  </div>

  <script>
    const log = document.getElementById("log");

    function stamp() {
      return new Date().toLocaleTimeString("id-ID");
    }

    function print(msg, cls = "") {
      log.innerHTML += `\n<span class="${cls}">[${stamp()}] ${msg}</span>`;
      log.scrollTop = log.scrollHeight;
    }

    function clearLog() { log.innerHTML = ""; }

    async function apiFetch(url, method, token) {
      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;
      const res = await fetch(url, { method, headers });
      return res.json();
    }

    async function deleteFile() {
      const key = document.getElementById("fileKey").value.trim();
      const token = document.getElementById("fileToken").value.trim();
      if (!key) { print("⚠ Key file tidak boleh kosong", "fail"); return; }
      print(\`Menghapus file: \${key} ...\`, "info");
      try {
        const data = await apiFetch(\`/file?key=\${encodeURIComponent(key)}\`, "DELETE", token);
        if (data.ok) print(\`✓ Berhasil dihapus: \${data.deleted}\`, "ok");
        else print(\`✗ \${data.error}\`, "fail");
      } catch(e) { print("✗ Fetch error: " + e.message, "fail"); }
    }

    async function deleteFolder() {
      const prefix = document.getElementById("folderPrefix").value.trim();
      const token = document.getElementById("folderToken").value.trim();
      if (!prefix) { print("⚠ Prefix folder tidak boleh kosong", "fail"); return; }
      if (!confirm(\`Yakin ingin menghapus semua isi folder '\${prefix}'?\`)) return;
      print(\`Menghapus folder: \${prefix}/ ...\`, "info");
      try {
        const data = await apiFetch(\`/folder?prefix=\${encodeURIComponent(prefix)}\`, "DELETE", token);
        if (data.ok) {
          print(\`✓ \${data.message}\`, "ok");
          if (data.deleted && data.deleted.length > 0) {
            data.deleted.forEach(k => print(\`  └ \${k}\`, "dim"));
          }
        } else {
          print(\`✗ \${data.error}\`, "fail");
        }
      } catch(e) { print("✗ Fetch error: " + e.message, "fail"); }
    }

    async function listObjects() {
      const prefix = document.getElementById("listPrefix").value.trim();
      const limit = document.getElementById("listLimit").value || 50;
      let url = \`/list?limit=\${limit}\`;
      if (prefix) url += \`&prefix=\${encodeURIComponent(prefix)}\`;
      print(\`Mengambil list objek\${prefix ? " prefix: " + prefix : ""}...\`, "info");
      try {
        const data = await apiFetch(url, "GET", "");
        if (data.ok) {
          print(\`✓ Ditemukan \${data.count} objek\${data.truncated ? " (terpotong)" : ""}:\`, "ok");
          data.objects.forEach(o => {
            const size = (o.size / 1024).toFixed(1);
            print(\`  \${o.key}  [\${size} KB]\`, "dim");
          });
        } else {
          print(\`✗ \${data.error}\`, "fail");
        }
      } catch(e) { print("✗ Fetch error: " + e.message, "fail"); }
    }
  </script>
</body>
</html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    }
  );
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    // Auth check (semua endpoint kecuali dashboard)
    if (pathname !== "/" && !isAuthorized(request, env)) {
      return err("Unauthorized", 401);
    }

    // ── GET / → Dashboard UI
    if (method === "GET" && pathname === "/") {
      return dashboardHTML();
    }

    // ── GET /list → List objek
    if (method === "GET" && pathname === "/list") {
      const prefix = url.searchParams.get("prefix") || "";
      const limit  = url.searchParams.get("limit")  || 100;
      return listObjects(env, prefix, limit);
    }

    // ── DELETE /file → Hapus satu file
    if (method === "DELETE" && pathname === "/file") {
      const key = url.searchParams.get("key") || "";
      return deleteFile(env, key);
    }

    // ── DELETE /folder → Hapus folder + isinya
    if (method === "DELETE" && pathname === "/folder") {
      const prefix = url.searchParams.get("prefix") || "";
      return deleteFolder(env, prefix);
    }

    return err("Endpoint tidak ditemukan", 404);
  },
};
