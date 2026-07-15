# わたし会議

「AIで考える、これからの私会議」の静的ランディングページです。

## 構成

- `index.html`: ページ本文、メタ情報、申し込みフォーム
- `style.css`: 全体のデザインとレスポンシブレイアウト
- `mobile-hero.css`: スマートフォン向けトップ画像表示調整
- `script.js`: フォームの入力チェックとStripe決済ページへの移動処理
- `src/worker.js`: Stripe Checkout Sessionを作成するCloudflare Worker API
- `assets/`: サイト内で使用する画像
- `wrangler.jsonc`: Cloudflare 用設定

## ローカル確認

```sh
python3 -m http.server 4173
```

ブラウザで `http://127.0.0.1:4173/` を開いて確認します。

Stripe決済まで含めて確認する場合は、Wranglerで起動します。

```sh
cp .dev.vars.example .dev.vars
# .dev.vars にStripeのテスト秘密鍵を設定
npm run dev
```

## Stripe設定

CloudflareにはStripeの秘密鍵をシークレットとして設定します。

```sh
npm run secret:stripe
```

本番ドメインを明示したい場合は、Cloudflareの環境変数 `PUBLIC_SITE_URL` に公開URLを設定します。未設定の場合は、アクセスされたURLをもとに決済完了後の戻り先を作ります。

## 公開URL

- `https://watashi-kaigi.aether42.com`
- `wrangler.jsonc` のCustom Domain設定により、CloudflareがDNSレコードとTLS証明書を管理します。

## よく使うコマンド

```sh
npm run dev
npm run verify
npm run deploy
npm run git:publish -- "コミットメッセージ"
```

`git:publish` は確認、git add、commit、pushをまとめて行います。

## メモ

- 申し込みフォームは、入力内容をもとに3,000円のStripe Checkout決済ページへ移動する方式です。
- PC版とスマートフォン版でトップ画像の見え方が異なるため、ヒーロー周りを変更したときは両方の表示を確認してください。
