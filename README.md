# re:Memory

re:Memoryは、写真をすぐに見返すのではなく、時間をかけて「記憶のかけら」と再会する静的Webアプリです。

## 公開構成

- `app-only`ブランチ: GitHub Pagesへ公開する本番版。開発者機能・認証スキップ・テストデータ操作を含みません。
- `development`ブランチ: ローカル検証用。GitHub Pagesの公開元には設定しません。
- `index.html`: CSPと本番用の公開接続設定
- `assets/app.js`: Google/Supabase認証、IndexedDBキャッシュ、画像処理、画面遷移
- `assets/app-ui.css`: UIスタイル
- `supabase/migrations`: RLSとStorageポリシー
- `supabase/functions/delete-account`: サーバー側アカウント削除
- `tests/security-audit.mjs`: 公開成果物の静的セキュリティ検査

## ローカル起動

```powershell
python -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開きます。公開版では `?debug=1` を付けても開発メニューは起動しません。

## テスト

```powershell
npm test
```

テストはJavaScript構文、公開版への開発コード混入、詳細ログ、CSP、SDK固定、アップロード制限、RLS/Storage、アカウント削除関数を確認します。

## 認証と保存

- GoogleログインはSupabase AuthのOAuth PKCEフローを使用します。
- OAuth Client Secret、service role key、アクセストークンはフロントエンドへ含めません。
- ブラウザのIndexedDBはオフラインキャッシュです。ログイン中の`user_id`に一致するデータだけを画面へ読み込みます。
- PostgreSQLの`memories`、`memory_fragments`、`memory_reflections`はRLSで所有者を検証します。
- Storageの`memory-images`はPrivate bucketとし、`user-id/...`配下だけを本人が操作できます。
- アカウント削除はEdge Function経由で実行し、成功後に端末キャッシュを削除します。

## 画像の取り扱い

- 対応形式: JPEG、PNG、WebP
- 最大ファイルサイズ: 15MB
- 最大画像サイズ: 1辺12,000pxかつ40メガピクセル以下
- 保存前にCanvasへ描画し直してJPEG化するため、EXIF位置情報や元ファイル名をStorageへ送信しません。
- 保存IDには`crypto.randomUUID()`または`crypto.getRandomValues()`を使用します。
- 画像分析はブラウザ内Canvasだけで行い、外部AIサービスへ写真を送信しません。

## Supabase適用手順

1. `supabase/migrations/20260711130000_harden_rememory_security.sql`をステージング環境で実行します。
2. 既存テーブル名・`user_id uuid`・`memory-images` bucketが一致しない場合、変更前にトランザクションが停止します。
3. 既存ポリシーをSupabase Dashboardで確認し、広すぎるポリシーが残っていないことを確認します。
4. `delete-account` Edge Functionをデプロイし、`ALLOWED_ORIGINS`へ本番originだけを設定します。
5. 2つのテストアカウントでRLSとStorageの相互アクセス拒否を確認します。

## 公開前に必要な手動設定

- Google OAuthのリダイレクトURLを本番URLと必要な開発URLだけに限定する
- `app-only`だけをGitHub Pagesの公開元にする
- `development`で本番Supabaseを使わない
- SupabaseのRLS、Storage bucket、Edge Functionをステージングで確認してから本番へ適用する
- GitHub Pagesでは設定できないHTTPレスポンスヘッダーを、独自CDNへ移行する場合に追加する

詳細は `SECURITY-AUDIT.md` を参照してください。
