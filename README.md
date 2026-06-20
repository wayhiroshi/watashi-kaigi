# AIで考える、これからの私会議 LP

Cloudflare Pagesにそのままアップできる静的HTML/CSS/JSです。

## ファイル構成

- `index.html`
- `style.css`
- `script.js`

## 使い方

1. `script.js` の `OWNER_EMAIL` を申込受信用メールアドレスに変更します。
2. Cloudflare Pagesでこのフォルダをデプロイします。
3. この静的版では、送信時にメール作成画面が開きます。

## 別アカウントでCloudflareにアップする場合

優月なごみ用とは別のCloudflareアカウントで問題ありません。
Cloudflare Pagesのプロジェクト名は `watashi-kaigi` や `ai-tea-kobe` などにしてください。

## 次の拡張

フォームを自動送信・DB保存にする場合は、Cloudflare Pages Functions / Workers / D1 / Turnstile などを追加してください。
