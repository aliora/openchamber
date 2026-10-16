# OpenChamber Claude Code Swap Mimarisi ve Tasarım Belgesi

**Tarih:** 2026-10-16  
**Durum:** Onaylandı / Uygulamaya Hazır  
**Proje:** OpenChamber (`aliora/openchamber`)  
**Hedef Kapsam:** OpenCode motorunu tamamen söküp Claude Code CLI'ı birinci sınıf yerel motor olarak entegre etmek (macOS, Windows, Ubuntu).

---

## 1. Genel Bakış ve Amaç

OpenChamber; geliştirici dostu arayüzü (Web, Electron, Mobil PWA), dosya gezgini, Git/worktree yönetimi ve tünel kabiliyetleriyle bağımsız bir AI geliştirme ortamıdır. Mevcut yapıda OpenCode (`@opencode/client`, `opencode serve`) ara katmanı bulunmaktaydı.

Bu projenin amacı:
1. OpenCode motorunu ve ara katman bağımlılıklarını sistemden tamamen kaldırmak (Yaklaşım 3: Tam Temizlik).
2. OpenChamber sunucusuna doğrudan **Claude Code CLI** (`claude` / `claude.cmd`) süreç yönetimini ve çift yönlü `stream-json` motorunu entegre etmek.
3. Windows, macOS ve Ubuntu üzerinde yerel abonelikle (Claude Pro/Max veya yetkilendirilmiş token) tam yetenekli (sohbet, düşünme, araçlar, interaktif izinler, plan modu) bir deneyim sağlamak.

---

## 2. Sistem Mimarisi

```
┌─────────────────────────────────────────────────────────────────┐
│     Geliştirici Arayüzü (Web Tarayıcı / Electron / Mobil PWA)    │
│  - Zustand UI Stores (Sessions, Messages, Tools, Git, Auth)     │
│  - Canlı Mesaj Bileşenleri (Text, Thinking Akordeonu, Tool Kart)│
│  - İnteraktif İzin & Onay Modalı (Allow / Deny)                │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 │ HTTP REST API & WebSocket / SSE
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│     OpenChamber Sunucusu (Node.js / Bun Express Server)         │
│  ├── ClaudeCodeEngine (Süreç Yaşam Döngüsü & CLI Runner)        │
│  ├── StreamHub (NDJSON stdout -> İstemci SSE / WS Yayını)       │
│  ├── ControlBridge (control_request <-> Kullanıcı İzin Yanıtı)  │
│  ├── LocalSessionStore (Oturum Listesi & Mesaj Geçmişi JSON/DB) │
│  └── Platform Servisleri (FS Explorer, Git Worktrees, Tunnels)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 │ Çift Yönlü NDJSON (Stdin / Stdout)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│     Claude Code CLI Motoru (2.1.301+) (Win / Mac / Ubuntu)      │
│     `claude -p --verbose --input-format stream-json             │
│             --output-format stream-json                         │
│             --include-partial-messages                          │
│             --permission-prompts host                           │
│             --session-id <uuid> --resume <uuid>`                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Temel Bileşenler ve Görev Dağılımı

### 3.1. ClaudeCodeEngine (`packages/web/server/lib/engine/claude/`)
* **Süreç Başlatma ve Yönetimi:**
  Her aktif oturum için bir `claude` alt süreci (child process) açar veya oturum devamında `--resume <uuid>` ile başlatır.
  Zorunlu CLI parametreleri:
  - `-p` / `--print`: Non-interactive headless mod.
  - `--verbose`: `stream-json` çıktı formatı için CLI tarafından zorunlu kılınan bayrak.
  - `--input-format stream-json`: Kullanıcı mesajları ve kontrol yanıtları için stdin JSON hattı.
  - `--output-format stream-json`: Claude çıktılarının NDJSON olarak stdout'a aktarılması.
  - `--include-partial-messages`: Canlı token ve düşünce parçalarının gecikmesiz akması.
  - `--permission-prompts host`: İzin onaylarının terminal yerine programatik olarak OpenChamber hostuna yönlendirilmesi.
  - `--session-id <uuid>`: Oturum kimliği.
  - `--cwd <path>`: Proje veya worktree çalışma dizini.

### 3.2. PlatformResolver (`packages/web/server/lib/engine/claude/platform.js`)
* **Windows (`win32`):**
  - CLI dosya yolu: `%APPDATA%\npm\claude.cmd` veya `where.exe claude`.
  - Süreç çalıştırma: `spawn(cmd, args, { shell: true, windowsHide: true })`.
  - Durdurma (Abort): Stdin kapatma veya Windows `taskkill /pid <pid> /T /F`.
* **macOS (`darwin`):**
  - CLI dosya yolu: `/usr/local/bin/claude`, `~/.local/bin/claude` veya `zsh -lic 'which claude'`.
  - Süreç çalıştırma: `spawn(cmd, args, { env: process.env })`.
  - Durdurma: POSIX `SIGINT`.
* **Ubuntu (`linux`):**
  - CLI dosya yolu: `/usr/local/bin/claude`, `~/.local/bin/claude` veya `bash -lic 'which claude'`.
  - Süreç çalıştırma: POSIX `spawn`.

### 3.3. ControlBridge (`packages/web/server/lib/engine/claude/control.js`)
* Claude'un `control_request` (özellikle `can_use_tool`) isteklerini yakalar.
* Oturum izin moduna göre (`manual`, `auto`, `bypassPermissions`):
  - **Bypass / Accept Everything:** Anında `{ "behavior": "allow" }` döner.
  - **Manual / Ask:** İstemciye `permission_request` olayı fırlatır; kullanıcı onaylayana kadar süreci bekletir.
  - Kullanıcı kararı geldiğinde (`POST /api/sessions/:id/permission`) Claude'un `stdin`'ine `control_response` yazar.

### 3.4. LocalSessionStore (`packages/web/server/lib/engine/claude/store.js`)
* Dosya konumu: `~/.openchamber/data/sessions.json` (veya oturum başına `.json`).
* İçerik:
  - Oturum meta verileri: `id` (UUID), `title`, `cwd`, `createdAt`, `updatedAt`, `model`, `effort`, `permissionMode`.
  - Mesaj geçmişi: Kullanıcı ve asistan mesajları, düşünce blokları (`thinking`), araç kullanım kayıtları (`tool_use`, `tool_result`).
* Claude Code'un yerel transkriptlerinden (`~/.claude/projects/`) bağımsız çalışarak hızlı arayüz yüklemesi ve güvenli oturum silme/düzenleme sağlar.

---

## 4. Olay ve Veri Akış Protokolü

### 4.1. Kullanıcı İstemi (Prompt Girişi)
Sunucu istemci tarafından `POST /api/sessions/:id/prompt` aldığında Claude'un `stdin` hattına şu satırı basar:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "Proje mimarisini açıkla" }
    ]
  }
}
```

### 4.2. Canlı Olay Akışı (Stdout -> UI SSE)
Claude'un stdout akışındaki olaylar arayüz tiplerine eşlenir:
1. **Düşünme (Thinking):**
   - Kaynak: `stream_event` -> `content_block_delta` -> `delta.type === "thinking_delta"`.
   - UI Olayı: `part: { type: "reasoning", content: delta.thinking }`.
   - UI Görünümü: Açılıp kapanabilen akordeon, anlık token sayacı.
2. **Metin (Text):**
   - Kaynak: `stream_event` -> `content_block_delta` -> `delta.type === "text_delta"`.
   - UI Olayı: `part: { type: "text", content: delta.text }`.
3. **Araç Çağrısı (Tool Use):**
   - Kaynak: `stream_event` -> `content_block_start` (`type: "tool_use"`, `name: "Read" | "Edit" | "Write" | "Bash"`) ve `input_json_delta`.
   - UI Olayı: `part: { type: "tool_use", name, input, status: "running" }`.
   - Araç Tamamlanması: `status: "success" | "error"`, sonuç içeriği veya diff önizlemesi.
4. **Tur Bitişi:**
   - Kaynak: `result` (`subtype: "success" | "error"`, `usage`, `duration_ms`).
   - UI Olayı: `session:idle`, token istatistikleri ve süre güncellemesi.

### 4.3. İzin İstekleri (`control_request`)
Claude onay istediğinde:
```json
{
  "type": "control_request",
  "request_id": "b0225af1-13c1-4897-9197-49a9f776fe20",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "input": { "command": "npm run build" }
  }
}
```
Kullanıcı yanıtı `stdin`'e:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "b0225af1-13c1-4897-9197-49a9f776fe20",
    "response": {
      "behavior": "allow"
    }
  }
}
```

---

## 5. UI Parametrelerinin CLI Bayraklarına Eşlenmesi

OpenChamber kullanıcı kontrolleri doğrudan test edilmiş CLI bayraklarıyla yönetilir:

| UI Kontrolü | Seçenekler | CLI Bayrağı | Açıklama |
| :--- | :--- | :--- | :--- |
| **Model Dropdown** | Sonnet, Opus, Haiku | `--model sonnet` / `opus` / `haiku` | Oturum veya tur bazında model belirler |
| **Reasoning Seviyesi** | Low, Medium, High, Max | `--effort low` / `medium` / `high` / `max` | Düşünce bütçesini ayarlar |
| **Plan Modu** | Aktif / Pasif | `--permission-mode plan` | Dosya değiştirmeden salt okunur plan üretir |
| **İzin Güvenliği** | Ask / Auto / Bypass | `--permission-mode manual` / `auto` / `bypassPermissions` | Araç onay sıklığını belirler |

---

## 6. Kimlik ve Oturum Yönetimi (Auth Lifecycle)

### 6.1. Durum Sorgulama (`GET /api/auth/status`)
* Çalıştırılan komut: `claude auth status --json`
* Çıktı: `{ loggedIn: true, email: "...", subscriptionType: "pro", authMethod: "claude.ai" }`
* UI'da kullanıcı profilinde e-posta ve Pro/Max rozeti listelenir.

### 6.2. Giriş Yapma (`POST /api/auth/login`)
* **Masaüstü (Desktop / Local Web):** `claude auth login --claudeai` çalıştırılarak varsayılan tarayıcıda Anthropic OAuth açılır.
* **Uzak / Headless (Pi5 / Ubuntu Sunucu / PWA):** `claude setup-token` linki UI modalında gösterilir; kullanıcı aldığı token'ı arayüze girerek kaydeder.

### 6.3. Çıkış Yapma (`POST /api/auth/logout`)
* `claude auth logout` çalıştırılarak yerel kimlik temizlenir; arayüz kilitlenir.

---

## 7. Dosya Sistemi ve Git Worktree Entegrasyonu

* **CWD:** Claude süreçleri oturumun `cwd` yolunda çalıştırılır; tüm yerel araçlar bu dizinde işler.
* **Dosya Gezgini:** OpenChamber'ın `/api/fs/*` uçları dosya ağacı ve sekmeler için çalışmaya devam eder.
* **Git Worktrees:** OpenChamber'ın yerleşik Git servisi izole dallar oluşturduğunda, ilgili oturumun `cwd` parametresi yeni worktree yoluna set edilir.

---

## 8. Uygulama Aşamaları

1. **Aşama 1: Claude Code CLI Runner ve Çapraz Platform Adaptörü**
   - `PlatformResolver` (Windows `claude.cmd`, Mac/Linux `claude`).
   - `ClaudeCodeEngine` süreç yöneticisi (`spawn`, stream-json, verbose, error handling).
2. **Aşama 2: ControlBridge ve Canlı StreamHub**
   - JSONL stdout ayrıştırıcısı.
   - `control_request` <-> `control_response` izin döngüsü.
   - `SIGINT` ile abort mekanizması.
3. **Aşama 3: LocalSessionStore ve REST Rotaları**
   - Oturum depolama servisi (`sessions.json`).
   - `/api/sessions`, `/api/sessions/:id/messages`, `/api/sessions/:id/prompt` rotaları.
4. **Aşama 4: UI Entegrasyonu & Model/Reasoning/Plan Eşlemeleri**
   - Zustand store'larının yeni temiz API ile bağlanması.
   - Model, effort ve plan modu geçişlerinin test edilmesi.
5. **Aşama 5: Auth Servisi**
   - `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`.
6. **Aşama 6: OpenCode Temizliği ve Uçtan Uca Doğrulama**
   - Eski OpenCode proxy/bağımlılık kodlarının temizlenmesi.
   - Web ve Electron ortamlarında doğrulama testleri.
