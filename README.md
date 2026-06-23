# AIで考える、これからの私会議｜再現実装版

提供いただいたデザイン画像を基準に、実際に運用可能な HTML / CSS / 画像素材として組み直した版です。

## 含まれるファイル
- `index.html`
- `style.css`
- `script.js`
- `assets/`：トップ、キーコンセプト、3か月プラン、サポート表示に使う画像素材

## 反映方法
既存リポジトリの中身をこの一式で上書きし、以下を実行してください。

```bash
cd ~/Documents/watashi-kaigi
git add .
git commit -m "Recreate landing page design with assistant concept"
git push
```

## フォーム
現在は既存仕様の `mailto:` です。Cloudflare Worker + Resend に切り替えるまで、申込時にメールアプリが開きます。


## 今回の調整
申込フォームを、3カラム内の小さなフォームではなく、ページ下部の大きな専用申込セクションに戻しました。


## 最新のトップ画像実装
- `assets/top.png`：今回採用した、文字なしの水彩トップイラスト
- トップのタイトル・説明・ボタンはすべて `index.html` のHTML文字です
- `assets/hero-right.png` は削除せず、「この会のキーコンセプト」内の補助ビジュアルとして使用しています

