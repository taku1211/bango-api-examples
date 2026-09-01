# Next.js Invoice Issuer Lookup Example

[Bango API](https://bango-api.jp/) を使って、**インボイス登録番号（T番号）から登録事業者情報を取得する** Next.js サンプルです。

法人のT番号では会社名・法人番号・所在地・インボイス登録情報を表示し、個人事業者ではプライバシー保護方針に従ってインボイス登録情報のみを表示します。

## What this example does

- T番号（`T` + 13桁）を入力
- Next.js Route Handler 経由で `GET /v1/invoice/{registration_number}` を呼び出す
- 法人では事業者名・法人番号・所在地・登録日・現在の有効性を表示
- 個人事業者ではT番号・登録日・現在の有効性を表示
- `kind` を使って法人 / 個人事業者のUIを分岐
- 入力値を変更した場合は以前の照会結果をクリア
- APIキーはブラウザへ露出せず、Next.js Route Handler から利用
- `valid` を「有効 / 無効」の表示用ステータスへ変換

## Tech stack

- Next.js 16
- React 19
- TypeScript
- App Router
- React Hook Form
- Next.js Route Handler
- Bango API

## API

このサンプルでは Bango API の Invoice Lookup API を利用します。

```text
GET /v1/invoice/{registration_number}
```

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

APIキーには `NEXT_PUBLIC_` を付けず、サーバー側だけで利用します。

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
T番号を入力
  ↓
Browser
  ↓
/api/invoice/{registrationNumber}
  ↓
Next.js Route Handler
  ↓ x-api-key
Bango API
GET /v1/invoice/{registration_number}
  ↓
ブラウザ向けDTOへ変換
  ↓
法人 / 個人事業者を kind で分岐
  ↓
事業者情報を表示
```

Bango API は Next.js Route Handler から呼び出し、APIキーをブラウザへ露出しません。

## Browser DTO

Bango API の生レスポンスをそのままブラウザへ返さず、画面で必要な情報だけに変換します。

```ts
{
  kind,
  registrationNumber,
  registrationDate,
  valid,
  corporateNumber,
  name,
  postalCode,
  address,
}
```

これにより、React側はAPIの生レスポンス構造を直接扱わずに済みます。

## Corporation and individual handling

Invoice Lookup API の `kind` は次のどちらかです。

```ts
"corporation" | "individual"
```

法人では次の情報を表示します。

- 事業者名
- 法人番号
- 所在地
- T番号
- 登録日
- 登録状態

個人事業者では次の情報を表示します。

- 事業者種別
- T番号
- 登録日
- 登録状態

Bango APIでは、個人事業者の氏名・屋号・住所などについて、元データ側や内部データベースで値を取得・保持できる場合でも、**個人情報・プライバシー保護のため公開APIでは再配布しない**方針としています。

そのため、個人事業者では空欄の法人項目を並べず、表示項目自体を分けています。

## Validity status

T番号に一致する登録情報が見つからない場合は404になります。

成功レスポンスでは `valid` を使って、現在時点でその登録番号が有効かを表示します。

```ts
function getInvoiceStatus(valid: boolean): "有効" | "無効" {
  return valid ? "有効" : "無効";
}
```

## Error states

このサンプルでは主に次のエラーを扱います。

- T番号の形式不正
- 登録番号が見つからない
- APIの利用上限
- Bango API の取得失敗

## Verify

```bash
npm run lint
npm run build
```

## Production considerations

このサンプルは Invoice Lookup API の連携フローを分かりやすくするため、UIとエラー処理をシンプルにしています。

実運用では必要に応じて、次のような改善を検討してください。

- アプリ側の rate limit
- キャッシュ
- ログ・監視
- API障害時のフォールバック
- 日付表示のローカライズ
- より詳細なアクセシビリティ対応
- 無効・取消・失効状態に応じた業務ロジック

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
