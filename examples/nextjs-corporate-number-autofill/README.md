# Next.js Corporate Number Autofill Example

[Bango API](https://bango-api.jp/) を使って、**法人番号から会社名・住所・インボイス登録状況を自動補完するフォーム**を実装した Next.js サンプルです。

法人番号を入力して「会社情報を取得」を押すと、Bango API の法人詳細取得 API を呼び出し、会社情報をフォームへ反映します。

## What this example does

- 法人番号13桁を入力
- Bango API から法人情報を取得
- 会社名を自動補完
- 郵便番号・都道府県・市区町村・番地を自動補完
- インボイス登録状況を表示
- 法人番号を書き換えた場合は、以前の補完値をクリア
- 法人番号が存在しない場合はエラーメッセージを表示
- APIキーはブラウザへ露出せず、Next.js Route Handler から利用

## Tech stack

- Next.js 16
- React 19
- TypeScript
- App Router
- React Hook Form
- Next.js Route Handler
- Bango API

## API

このサンプルでは次の Bango API エンドポイントを利用します。

```text
GET /v1/companies/{corporate_number}
```

法人番号から、会社名・所在地・インボイス情報などをまとめて取得します。

## Setup

依存関係をインストールします。

```bash
npm install
```

環境変数ファイルを作成します。

```bash
cp .env.example .env.local
```

`.env.local` に Bango API の API キーを設定してください。

```env
BANGO_API_KEY=YOUR_API_KEY
```

API キーには `NEXT_PUBLIC_` を付けず、サーバー側だけで利用します。

## Run locally

```bash
npm run dev
```

ブラウザで以下を開きます。

```text
http://localhost:3000
```

## Architecture

```text
Browser
  ↓
Next.js Route Handler
  ↓ x-api-key
Bango API
GET /v1/companies/{corporate_number}
  ↓
会社情報 + インボイス情報
  ↓
React Hook Form
  ↓
フォームを自動補完
```

ブラウザから Bango API を直接呼ばず、Next.js Route Handler を経由しています。

これにより、Bango API の API キーをクライアントへ露出しません。

## Form behavior

取得した会社名・住所は、自動補完後も編集できます。

登記上の所在地と、サービス上で利用したい請求先・連絡先が必ず同じとは限らないため、自動補完は入力を強制するものではなく、入力作業を減らす補助機能として扱っています。

一方、インボイス登録状況は API から取得した判定結果として読み取り専用で表示します。

また、一度法人情報を取得したあとに法人番号を変更すると、以前取得した会社情報をクリアします。

```text
法人番号 → 新しい値
会社名・住所 → 古い法人の情報
```

という不整合を防ぐためです。

## Validation / error handling

このサンプルでは最低限、次のケースを扱います。

- 法人番号が13桁でない
- 法人番号が見つからない
- API利用上限に達した
- Bango API の取得に失敗した
- APIキーが設定されていない

自動補完に失敗しても、会社名や住所は手入力できます。

## Related article

実装の考え方やコードの解説は Zenn にまとめています。

[Next.jsで法人番号から会社名・住所を自動補完するフォームを作る](https://zenn.dev/takuma_kanazawa/articles/8cf1b5f89c4bcb)

## Bango API

- [Bango API](https://bango-api.jp/)
- [API Docs](https://bango-api.jp/docs)
- [Playground](https://bango-api.jp/playground)

## Notes

このサンプルでは動作確認用として公開法人情報を利用しています。各法人との提携・推奨関係を示すものではありません。

Bango API は国税庁の法人番号公表データ・適格請求書発行事業者公表データを取得・加工して提供しています。内容は国税庁によって保証されるものではありません。
