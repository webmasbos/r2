# ⚡ R2 Manager Worker

Cloudflare Worker untuk mengelola bucket R2 — hapus file, hapus folder beserta isinya, dan list objek.

---

## 📦 Setup

### 1. Install Wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. Ganti nama bucket di `wrangler.toml`
```toml
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "nama-bucket-kamu"   # ← Ganti ini
```

### 3. Deploy
```bash
wrangler deploy
```

---

## 🔐 Autentikasi (Opsional)

Untuk mengamankan endpoint, set secret `AUTH_TOKEN`:
```bash
wrangler secret put AUTH_TOKEN
```

Lalu kirim header di setiap request:
```
Authorization: Bearer <token-kamu>
```

---

## 📡 API Endpoints

### `GET /`
Dashboard UI berbasis web.

---

### `GET /list`
List objek dalam bucket.

| Parameter | Wajib | Keterangan |
|-----------|-------|------------|
| `prefix`  | Tidak | Filter by prefix/folder |
| `limit`   | Tidak | Maks objek (default: 100, max: 1000) |

**Contoh:**
```bash
curl "https://worker.domain.workers.dev/list?prefix=uploads/&limit=50"
```

---

### `DELETE /file`
Hapus satu file.

| Parameter | Wajib | Keterangan |
|-----------|-------|------------|
| `key`     | Ya    | Key/path file di R2 |

**Contoh:**
```bash
curl -X DELETE "https://worker.domain.workers.dev/file?key=uploads/foto.jpg"
```

**Response:**
```json
{ "ok": true, "deleted": "uploads/foto.jpg" }
```

---

### `DELETE /folder`
Hapus folder beserta seluruh isinya (rekursif, batch deletion).

| Parameter | Wajib | Keterangan |
|-----------|-------|------------|
| `prefix`  | Ya    | Prefix/path folder |

> Prefix `images/2024` akan otomatis di-normalize ke `images/2024/`.

**Contoh:**
```bash
curl -X DELETE "https://worker.domain.workers.dev/folder?prefix=uploads/tahun-lama"
```

**Response:**
```json
{
  "ok": true,
  "message": "Berhasil menghapus 42 objek dari 'uploads/tahun-lama/'",
  "totalDeleted": 42,
  "deleted": [
    "uploads/tahun-lama/foto1.jpg",
    "uploads/tahun-lama/foto2.jpg",
    ...
  ]
}
```

---

## 📁 Struktur Proyek

```
r2-manager/
├── src/
│   └── index.js       # Worker utama
├── wrangler.toml      # Konfigurasi Cloudflare
└── README.md
```

---

## ⚠️ Catatan

- Penghapusan folder bersifat **permanen** dan tidak bisa di-undo.
- Worker mendukung pagination otomatis — folder dengan >1000 file tetap terhapus semua.
- Gunakan `AUTH_TOKEN` untuk produksi.
