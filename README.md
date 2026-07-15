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
npm run secret:stripe-webhook
npm run secret:resend
```

Stripe本番環境のイベント送信先には、次のURLを設定します。

```text
https://watashi-kaigi.aether42.com/api/stripe-webhook
```

受信イベントは `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed` です。WebhookはStripe署名を検証し、決済結果と申込メタデータをCloudflareの構造化ログへ記録します。

決済結果と申込情報はCloudflare D1の `registrations` テーブルにも保存します。初回デプロイ前にマイグレーションを適用します。

決済完了時はResendの `notify.aether42.com` から主催者へ申込内容を通知します。送信済み日時とResendメッセージIDもD1へ保存し、StripeのWebhook再送による重複通知を抑止します。

```sh
npm run db:migrate:local
npm run db:migrate:remote
```

本番の申込者一覧は次のコマンドで確認できます。

```sh
npm run db:registrations
```

## 申込管理画面

本番の申込状況は次の管理画面で確認できます。

```text
https://watashi-kaigi.aether42.com/admin/
```

管理画面では申込総数、決済状況、通知エラー、申込者情報を確認でき、氏名・メールアドレス・電話番号による検索と決済状況による絞り込みができます。現在は閲覧専用です。

`/admin/*` はCloudflare Accessで保護し、許可したメールアドレスだけがワンタイムコードまたはCloudflareアカウントでログインできます。Worker側でもAccess JWTの署名、発行元、Application Audienceを検証します。許可ユーザーの追加・停止はCloudflare Zero Trustの `Access controls > Policies` で行います。

ローカルで管理画面を確認するときだけ、次のように認証を迂回します。`ADMIN_LOCAL_BYPASS` は本番設定には追加しません。

```sh
ADMIN_LOCAL_BYPASS=true npm run dev
```

本番ドメインを明示したい場合は、Cloudflareの環境変数 `PUBLIC_SITE_URL` に公開URLを設定します。未設定の場合は、アクセスされたURLをもとに決済完了後の戻り先を作ります。

## 公開URL

- `https://watashi-kaigi.aether42.com`
- `https://watashi-kaigi.aether42.com/admin/`（Cloudflare Access認証必須）
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
