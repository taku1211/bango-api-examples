# Next.js Company Autocomplete Example

[Bango API](https://bango-api.jp/) を使って、**会社名から企業候補を検索し、選択した法人の詳細情報をフォームへ自動補完する** Next.js サンプルです。

会社名を入力すると候補を最大10件表示し、ユーザーが1社を選択すると、その法人番号を使って会社情報を取得します。

## What this example does

- 会社名を入力
- 400ms の debounce 後に企業名検索
- 最大10件の企業候補を表示
- 候補には会社名・会社名カナ・法人番号を表示
- ユーザーが候補から1社を選択
- 選択した `corporate_number` で法人詳細を取得
- 法人番号・郵便番号・住所・インボイス登録状況を自動補完
- 入力途中の古い検索リクエストを `AbortController` で中断
- 選択後に会社名を書き換えた場合は、以前の法人情報をクリア
- APIキーはブラウザへ露出せず、Next.js Route Handler から利用

## Tech stack

- Next.js 16
- React 19
- TypeScript
- App Router
- React Hook Form
- Next.js Route Handler
- Bango API

## APIs

このサンプルでは2つの Bango API エンドポイントを利用します。

```text
GET /v1/companies/search
GET /v1/companies/{corporate_number}
```

役割は次のように分けています。

```text
Search
→ ユーザーが「どの法人か」を選ぶための候補を取得する

Lookup
→ 選択された法人の詳細情報を取得する
```

検索結果の1件目を自動的に確定せず、候補からユーザー自身に法人を選んでもらいます。

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
会社名を入力
  ↓
400ms debounce
  ↓
Browser
  ↓
/api/companies/search
  ↓
Bango API
GET /v1/companies/search
  ↓
最大10件の候補
  ↓
ユーザーが1社を選択
  ↓
corporate_number
  ↓
/api/company/{corporateNumber}
  ↓
Bango API
GET /v1/companies/{corporate_number}
  ↓
会社情報 + インボイス情報
  ↓
React Hook Form
  ↓
フォームを自動補完
```

Bango API はどちらも Next.js Route Handler から呼び出し、API キーをブラウザへ露出しません。

## Why search and lookup are separated

会社名検索 API のレスポンスは、候補選択に必要な情報を中心に返します。

このサンプルでは検索結果から、

```text
corporate_number
name
name_kana
```

だけをブラウザ向けの候補データへ変換します。

候補が選択されたあと、その `corporate_number` を使って法人詳細 API を呼び、住所やインボイス登録状況を取得します。

検索結果だけでフォーム全体を埋めず、**法人候補の検索と、確定した法人の詳細取得を分離**しています。

## Search score

企業名検索のレスポンスには `score` がありますが、このサンプルではブラウザへ返していません。

`score` は検索順位付けに使う相対値であり、正解確率や「この候補を自動確定してよい」という信頼度ではありません。

そのため、

```text
検索結果の1位
→ 自動的に法人を確定
```

とはせず、

```text
候補を表示
→ ユーザーが法人を選択
```

という UI にしています。

## Debounce and stale request handling

会社名入力のたびに即座に API を呼ぶのではなく、入力が止まってから 400ms 後に検索します。

また、debounce だけでは、すでに開始された古いリクエストの応答順序までは保証できません。

そこで `AbortController` を使い、入力内容が更新されたら以前の検索リクエストを中断します。

```text
トヨ
↓
トヨタ
↓
トヨタ自動車
```

と素早く入力しても、古い検索結果で最新候補が上書きされないようにしています。

## Form behavior

候補から法人を選択すると、次の項目を自動補完します。

- 会社名
- 法人番号
- 郵便番号
- 都道府県
- 市区町村
- 番地
- インボイス登録状況

法人番号とインボイス登録状況は読み取り専用で表示します。

会社名や住所は、自動補完後も必要に応じて編集できます。

また、選択後に会社名を書き換えた場合は、以前取得した法人番号・住所・インボイス登録状況をクリアし、新しい会社名で検索をやり直します。

## Search / error states

このサンプルでは次の状態を扱います。

- 2文字未満では検索しない
- 検索待ち
- 検索中
- 候補あり
- 候補なし
- 検索APIエラー
- 法人詳細取得中
- 法人詳細取得エラー
- 選択後の会社名変更
- 古い検索リクエストの中断

## Production considerations

このサンプルは API 連携の流れが分かりやすいよう、Autocomplete UI をシンプルに実装しています。

実運用では必要に応じて、次のような改善を検討してください。

- キーボードの上下キーによる候補移動
- `Enter` での候補選択
- ARIA Comboboxとしてのアクセシビリティ対応
- フォーカスが外れた場合の候補リスト制御
- 都道府県などによる追加絞り込み
- キャッシュ
- アプリ側の rate limit
- debounce時間や検索開始文字数の調整
- API障害時でも手入力を継続できるUI

## Dependency and security notice

このサンプルは、**作成時点のライブラリバージョンで動作確認したもの**です。

公開後に依存ライブラリの新しいバージョンやセキュリティ修正がリリースされている場合があります。また、作成時点では把握されていなかった脆弱性が、後から報告される可能性もあります。

実際のプロダクトへ組み込む場合は、このサンプルの依存バージョンをそのまま採用するのではなく、**利用時点で各ライブラリの最新の安定版、セキュリティアドバイザリ、変更履歴を確認し、必要なアップデートと動作確認を行ってください。**

## Bango API

- [Bango API](https://bango-api.jp/)
- [API Docs](https://bango-api.jp/docs)
- [Playground](https://bango-api.jp/playground)

## Notes

このサンプルでは動作確認用として公開法人情報を利用しています。各法人との提携・推奨関係を示すものではありません。

Bango API は国税庁の法人番号公表データ・適格請求書発行事業者公表データを取得・加工して提供しています。内容は国税庁によって保証されるものではありません。
