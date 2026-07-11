# re:Memory

re:Memory は、写真をすぐに見返すのではなく、時間をかけて「記憶のかけら」と再会し、その意味を育てていく静的 Web MVP です。

## 構成

- `index.html`: 操作可能なMVPアプリ
- `assets/app-ui.css`: MVPアプリで使用する、整理済みのUIスタイル
- `assets/app.js`: 画面遷移、IndexedDB保存、画像分割、画像分析、日付進行、開発メニュー

## 起動方法

```powershell
python -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開きます。
開発メニューを使う場合は `http://localhost:4173/?debug=1` を開きます。

## 実装済みの主な機能

- ログイン画面
- Google Identity Servicesを使ったGoogleログインの受け口
- Supabase AuthへのGoogle IDトークン交換とセッション管理
- ログインユーザーごとのクラウドデータ分離（RLS）
- 思い出、断片、回答履歴のSupabase同期
- 元画像と断片画像の非公開Supabase Storage同期
- GoogleクライアントID未設定時の開発用ローカルログイン
- 写真の撮影または端末内写真の選択
- 写真を元画像BlobとしてIndexedDBへ保存
- 表示用の9分割画像Blobを元画像とは別に保存
- タイトル、メモ、気持ち、一緒にいた人、再会期間の登録
- 写真を預けた直後は表示せず、最短でも翌日から最初の確認を開始
- 1日1段階の進行
- 断片は 1個、3個、5個、7個の順に開放
- 5日目に「写真を見る」「まだ見ない」を選択
- 「写真を見る」を選んだ場合だけ元画像を表示
- 回答履歴と「まだ思い出せない」の保存
- 開発モードでアプリ内日付を進めるデバッグ操作

## ログイン設定

`index.html` の次のmetaタグに、Google Cloudで作成したOAuth 2.0 クライアントIDを設定すると、Googleログインボタンが有効になります。

```html
<meta name="google-client-id" content="YOUR_CLIENT_ID.apps.googleusercontent.com">
```

クライアントIDが空の場合は、Googleログインの代わりに開発用のローカルログインを使えます。
ローカルログインはこの端末・このブラウザだけの確認用です。

Googleログイン後は、写真と記録をSupabaseへ同期し、ブラウザのIndexedDBをオフライン用キャッシュとして併用します。

## Supabase接続

公開アプリは `rememory-web` プロジェクトへ接続します。

- Project URL: `https://wwxgdysgpogfjdvecjoz.supabase.co`
- Google認証: Google Identity ServicesのIDトークンをSupabase Authへ交換
- IndexedDB: オフライン用キャッシュ
- PostgreSQL: `profiles`、`memories`、`memory_fragments`、`memory_reflections`、`user_settings`
- Storage: 非公開バケット `memory-images`
- アクセス制御: `auth.uid()` を使ったRow Level Security

所有者情報のない既存IndexedDBデータは、Supabase接続後に最初にログインしたGoogleアカウントへ一度だけ引き継がれます。それ以降はログインユーザーごとにデータが分離されます。

## 画像分析機能

外部AI/APIは使用していません。APIキーや写真データを外部へ送信しません。
ブラウザ内のCanvasだけを使い、9分割した各断片について次のようなヒューリスティック分析を行います。

- 明暗差
- エッジ量
- 彩度
- 中央への近さ
- 肌色らしい領域の比率
- 文字らしい高コントラスト領域

この結果から、各断片に次の情報を保存します。

- `analysisLabels`
- `containsFace`
- `containsPerson`
- `containsText`
- `containsImportantObject`
- `centerProximity`
- `importanceScore`
- `recognitionRisk`
- `displayPriority`
- `analysisStatus`
- `analysisVersion`
- `analysisReason`

通常進行では `recognitionRisk` が低い断片から表示します。リスクが高い2断片は、ユーザーが「写真を見る」を選ぶまで表示しません。

これは顔認識や人物特定ではありません。写真の内容を正解として説明する機能でもありません。

## フォールバック

画像分析に失敗しても、元画像と9分割画像の保存は維持します。
分析情報がない既存データでは、中央付近を最後まで隠す従来の安全なルールで補完します。
開発メニューでは、選択中の思い出について保存済みの9分割画像を再分析できます。

## 開発メニュー

`?debug=1` を付けて開くと開発メニューが表示されます。

- 開発モードON/OFF
- アプリ内判定日時の確認
- 1日進める、7日進める
- 今日の制限を解除
- 次回の回答日へ進める
- 再会選択画面まで進める
- 画像を再分析
- 選択中の思い出を最初からやり直す
- 開発用データをすべて削除

画像分析テーブルでは、各断片のindex、ラベル、スコア、表示優先度、最後まで隠す対象かどうかを確認できます。

## 既知の制約

- 静的Web MVPのため、Android/iOS/Windowsのネイティブアプリ設定はありません。
- Googleログインを本番利用するには、Google Cloud側でOAuthクライアントID、承認済みJavaScript生成元、利用規約・プライバシーポリシーの設定が必要です。
- 現時点のログインはクラウドアカウント単位のデータ分離や同期を行いません。
- カメラUIと権限ダイアログはブラウザと端末に依存します。
- Canvas分析は簡易ヒューリスティックであり、顔認識、OCR、物体検出、意味理解は行いません。
- ブラウザのIndexedDBを削除すると保存済みの思い出も消えます。
