# 本棚 (bookshelf)

スマホのカメラで本の ISBN バーコードをスキャンして蔵書を管理する Web アプリ。

## 機能

- **棚ビュー**: 「本棚 → 段 → 本」の三層。段は横スクロールで、本が溢れても下に流れない
  (現実の本棚の再現)。ドラッグ＆ドロップで本の並べ替え・段や本棚をまたぐ移動、
  ⠿ で段の並べ替え、☰ で本棚の並べ替え。本棚・段の追加・改名 (名前タップ)・削除可
- **リストビュー**: テキスト一覧。追加日・タイトル・著者・出版日でソート
- **追加**: 📷 バーコードスキャン (ISBN 手入力可) / ✏️ テキストだけ (ISBN の無い本・同人誌など) /
  📸 **棚写真の解析** — 家の本棚の写真から段構成と背表紙を読み取り、まるごと新しい本棚として登録
- 検索はどちらのビューでも有効 (棚ビューでは該当以外が薄くなる)
- **実寸モード**: ISBN 登録時に NDL からページ数と高さ(cm) を取得し、棚ビューの本の高さを
  実寸比で描画 (文庫は低く A5 は高い)。段の 📐 から内寸 (高さ/幅 cm) を設定すると、
  厚み概算 (ページ数×紙厚) による「残り ○cm」表示と、高さが入らない本の赤枠警告が出る
- 本の編集 (タップ→モーダル): タイトル・著者・メモ (付箋表示)・★評価・読了ステータス

## 棚写真の解析 (要 Anthropic API キー)

Claude の Vision API (`claude-opus-4-8`) で写真を解析する。使うには
[console.anthropic.com](https://console.anthropic.com/) で API キーを取得し:

```
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/bookshelf/.env
```

を書いてサーバーを再起動。キー未設定の間は 📸 機能だけがエラーになり、他は普通に使える。
読み取った本はテキストのみ (ISBN なし) で登録されるので、正確な書誌情報が欲しい本は
あとからバーコードスキャンで登録し直すとよい。

## 構成

- `server.js` — Express + SQLite (better-sqlite3)。HTTPS ポート 8443
- `public/index.html` — UI 一式。バーコードは `BarcodeDetector` API (非対応なら ZXing)。
  ドラッグは SortableJS (CDN)
- `books.db` — SQLite。バックアップはこのファイルのコピーだけ

書誌情報は [openBD](https://openbd.jp/) → Google Books の順。表紙が無い場合は
Google Books の表紙直リンクで補完。

## 起動

```bash
cd ~/bookshelf
npm start
```

PC: https://localhost:8443

## 証明書 (警告なしでアクセスするには)

自前 CA (`ca.pem`) で署名した証明書を使っている。CA を端末に登録すれば警告は出ない。

- **Windows**: `certutil.exe -user -addstore Root C:\Users\jun\bookshelf-ca.crt` (登録済み)
- **Android**: スマホで `https://<WindowsのIP>:8443/ca.crt` をダウンロード →
  設定 → セキュリティ → 暗号化と認証情報 → 証明書のインストール → CA 証明書
- 証明書の SAN: `localhost`, `127.0.0.1`, `192.168.11.8`。
  Windows の LAN IP が変わったら cert.pem を作り直すこと

## スマホからのアクセス (WSL2 NAT モード)

WSL 起動後に一度、**管理者 PowerShell** で:

```powershell
powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\jun\bookshelf\setup-portproxy.ps1
```

その後スマホで `https://192.168.11.8:8443`。

## API

- `GET /api/shelves` — 本棚一覧 (段・本を position 順にネスト)
- `POST /api/shelves {name, rows?}` / `PATCH /api/shelves/:id {name}` / `DELETE /api/shelves/:id`
- `PUT /api/shelves/order {ids}` — 本棚の並び順
- `POST /api/shelves/:id/rows {name?}` — 段を追加
- `PUT /api/shelves/:id/rows/order {ids}` — 段の並び順
- `PATCH /api/rows/:id {name}` / `DELETE /api/rows/:id` (本は同じ本棚の別の段へ)
- `PUT /api/rows/:id/books {ids}` — 段内の本の並び (段・本棚をまたぐ移動も)
- `POST /api/books {isbn}` — 書誌情報を引いて登録 (ISBN-10/ハイフン可)
- `POST /api/books {title, author?, row_id?}` — テキストだけで登録
- `PATCH /api/books/:id {title?, author?, memo?}` — 編集 (本タップ→詳細モーダル)
- `DELETE /api/books/:id`
- `POST /api/analyze-shelf {image: dataURL, name?}` — 棚写真を解析して本棚を作成
