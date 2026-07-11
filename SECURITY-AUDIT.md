# re:Memory セキュリティ監査報告

監査日: 2026-07-11

## 結論

公開ブランチに含まれていた開発者モード、ローカルログイン、ゲストログイン、日時変更、再解析・全削除操作を本番コードから削除した。認証、端末キャッシュ、画像アップロード、ログ出力、依存ライブラリも本番向けに強化した。

Supabase の RLS、Storage、アカウント削除 Edge Function は実装ファイルを追加したが、本番データを保護するため自動適用していない。公開前にステージングでSQLを検証し、本番へ適用・デプロイする必要がある。これが完了するまで監査は条件付き合格とする。

## 指摘と対応

| 重要度 | 指摘 | 状態 | 対応 |
| --- | --- | --- | --- |
| Critical | 公開コードに開発者メニューと認証回避経路が含まれていた | 修正済み | 本番JS/CSSから関連コードを削除。開発版は `development` ブランチで管理 |
| High | IndexedDBのキャッシュがアカウント切替・通信失敗時に別ユーザーへ表示され得た | 修正済み | 認証ユーザーIDと所有メモリーIDでキャッシュを絞り込み、ログアウト時にメモリと一時URLを破棄 |
| High | RLSとStorageポリシーをリポジトリから検証できなかった | 適用待ち | 所有者限定RLSと非公開Storageのマイグレーションを追加 |
| High | アカウント削除がなかった | デプロイ待ち | 本人JWTを検証し、本人のStorage・DB・Authユーザーを削除するEdge FunctionとUIを追加 |
| Medium | MIMEの前方一致だけで画像を受理し、元画像のEXIFが保持された | 修正済み | JPEG/PNG/WebPの許可リスト、15MB、辺長12,000px、4,000万画素制限を追加。Canvas再エンコードでメタデータを除去 |
| Medium | 例外の詳細をブラウザコンソールへ出力していた | 修正済み | 詳細ログを削除し、利用者には一般化したエラーのみ表示 |
| Medium | OAuthがimplicit flowで、未使用のGoogle Identity経路も存在した | 修正済み | Supabase OAuthのPKCEに一本化 |
| Medium | Supabase SDKのCDNバージョンが固定されていなかった | 修正済み | `2.110.2`へ固定し、SRIを追加 |
| Low | Supabase URLと公開可能キーが静的HTMLに含まれる | 許容 | ブラウザ用キーは秘密情報として扱わず、RLSを実際の認可境界とする。service role等は未検出 |

匿名REST確認では既知テーブルからデータは取得できなかった。ただしAPI応答だけではRLS有効性を証明できない。Storageの匿名ルート一覧APIが成功応答を返したため、マイグレーション適用後に匿名ダウンロード・一覧取得が拒否されることを必ず再試験する。

## 変更ファイル

- `index.html`: CSP、Referrer Policy、固定版Supabase SDKとSRI
- `assets/app.js`: 本番用認証、キャッシュ分離、画像検証・EXIF除去、アカウント削除
- `assets/app-ui.css`: 開発者UI削除、アカウント管理UI
- `supabase/staging/01_rls_and_account_delete.sql`: ステージング用RLSと削除RPC
- `supabase/staging/02_storage_policies.sql`: ステージング用Storageポリシー
- `supabase/staging/rollback.sql`: 監査時点の本番ポリシー構成へのロールバック
- `supabase/staging/TEST-DATA.md`: 合成テストデータ作成手順
- `supabase/staging/VALIDATION.md`: ユーザーA/B・匿名状態の検証項目
- `supabase/functions/delete-account/index.ts`: サーバー側アカウント削除
- `supabase/config.toml`: Edge FunctionのJWT検証
- `tests/security-audit.mjs`: 本番成果物の回帰検査
- `.gitignore`: 秘密情報・ローカル設定の除外
- `package.json`: セキュリティテストコマンド

## Supabase適用手順

1. 本番のバックアップを取得し、同じスキーマのステージング環境を用意する。
2. 本番とは別のステージングSQL Editorで`01_rls_and_account_delete.sql`と`02_storage_policies.sql`を順番に実行する。想定外のテーブル・バケット・ポリシー構成では処理が停止する。
3. Storageの既存オブジェクトが `ユーザーUUID/...` 形式で、`owner_id` が本人UUIDであることを確認する。
4. `delete-account` Edge Functionをデプロイし、`ALLOWED_ORIGINS` に公開元を設定する。service role keyはEdge Functionの環境変数だけに置く。
5. ユーザーA/Bと匿名状態で、相互のSELECT/INSERT/UPDATE/DELETE、画像一覧・取得・更新・削除が拒否されることを検証する。
6. テストユーザーでアカウント削除を実行し、Storage、3テーブル、任意の設定テーブル、Authユーザーが消えることを確認する。

## 公開前チェック

- [x] 本番JS/CSSに開発者モードと認証回避コードがない
- [x] 公開リポジトリと履歴にservice role、OAuth client secret、DB接続文字列を検出しない
- [x] GoogleログインをSupabase OAuth PKCEへ統一
- [x] 端末キャッシュを認証ユーザーごとに分離
- [x] 画像形式・容量・寸法を制限し、EXIFを除去
- [x] 詳細な本番ログを削除
- [x] CDN依存を固定しSRIを付与
- [ ] Supabaseマイグレーションをステージング・本番へ適用
- [ ] `delete-account` Edge Functionをデプロイ
- [ ] 匿名・ユーザー間のRLS/Storage侵入テストを実施
- [ ] Supabase AuthのSite URLとRedirect URLを公開URLだけに制限
- [ ] Google Cloud OAuthの承認済みオリジン・リダイレクトURIを公開URLとSupabase callbackだけに制限
- [ ] GitHub Pages公開後に `?debug=1` でも開発者UIが出ないことを再確認

共有機能、外部AI API、動画アップロードは現行コードに存在しないため対象外。今後追加する場合は、公開範囲の明示、同意、送信先・保持期間の表示、動画向け容量・形式制限を別途設計する。
