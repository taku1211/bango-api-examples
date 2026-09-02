# Next.js Invoice Validity Check Example

[Bango API](https://bango-api.jp/) を使って、**請求書登録フォームにインボイス登録番号（T番号）の現在の有効性確認を組み込む** Next.js サンプルです。

T番号を入力してフォーカスを外すと、Next.js Route Handler 経由で Bango API の Invoice Validity API を呼び出し、現在時点で登録番号が有効かをフォーム内に表示します。

## What this example does

- 請求書登録フォームにT番号・請求日・金額・メモを入力
- T番号（`T` + 13桁）の形式を React Hook Form で検証
- 正しい形式のT番号からフォーカスを外したタイミングで有効性を自動確認
- Next.js Route Handler 経由で `GET /v1/invoice/{registration_number}/valid` を呼び出す
- `date` を省略し、JSTの今日を基準に現在時点の有効性を確認
- 有効な場合は判定基準日・登録日を表示
- 現在有効でない場合は、存在する登録日・取消日・失効日を表示
- 登録番号が見つからない場合と `valid: false` を別の状態として扱う
- T番号を変更したら以前の判定結果を即座にクリア
- `AbortController` を使い、古いブラウザリクエストの結果がUIへ反映されることを防止
- APIキーはブラウザへ露出せず、Next.js Route Handler からのみ利用

## Tech stack

- Next.js 16
- React 19
- TypeScript
- App Router
- React Hook Form
- CSS Modules
- Next.js Route Handler
- Bango API

## API

このサンプルでは Bango API の Invoice Validity API を利用します。

```text
GET /v1/invoice/{registration_number}/valid
```

このサンプルでは `date` クエリを指定しません。

そのため、Bango API 側で **JST（日本標準時）の今日** が判定基準日として解決されます。

例:

```text
GET /v1/invoice/T1180301018771/valid
```

成功レスポンスの `data` には次のような情報が含まれます。

```json
{
  "registration_number": "T1180301018771",
  "date": "2026-09-02",
  "valid": true,
  "registration_date": "2023-10-01",
  "cancel_date": null,
  "expire_date": null
}
```

請求日や取引日時点の有効性を確認したい場合は、Bango API では次のように `date` を指定できます。

```text
GET /v1/invoice/{registration_number}/valid?date=YYYY-MM-DD
```

ただし、このサンプルでは **現在時点の有効性確認** にスコープを絞っています。

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
請求書登録フォーム
  ↓
T番号を入力
  ↓
onBlur
  ↓
Browser
  ↓
/api/invoice-valid/{registrationNumber}
  ↓
Next.js Route Handler
  ↓ x-api-key
Bango API
GET /v1/invoice/{registration_number}/valid
  ↓
ブラウザ向けDTOへ変換
  ↓
有効 / 無効 / 見つからない / エラーを表示
```

Bango API は Next.js Route Handler から呼び出し、APIキーをブラウザへ露出しません。

## Browser DTO

Bango API の生レスポンスには `object` / `schema_version` / `links` / `meta` なども含まれますが、このサンプルでは画面に必要な項目だけをブラウザへ返します。

```ts
type InvoiceValidity = {
  registrationNumber: string;
  date: string;
  valid: boolean;
  registrationDate: string | null;
  cancelDate: string | null;
  expireDate: string | null;
};
```

Route Handler のレスポンス例:

```json
{
  "registrationNumber": "T1180301018771",
  "date": "2026-09-02",
  "valid": true,
  "registrationDate": "2023-10-01",
  "cancelDate": null,
  "expireDate": null
}
```

これにより、React 側は Bango API の生レスポンス構造を直接扱わずに済みます。

## Validation timing

T番号は1文字入力するたびにAPIへ問い合わせず、次の条件を満たした場合だけ確認します。

```text
T + 13桁の数字
```

入力後にフォーカスが外れた `onBlur` のタイミングで API を呼び出します。

```text
入力中
  ↓
形式チェック
  ↓
onBlur
  ↓
有効性確認
```

これにより、不完全な入力値で不要なAPIリクエストを送信しません。

## UI states

有効性確認処理は `valid` のbooleanだけではなく、確認処理そのものの状態を分けて扱います。

```ts
type CheckStatus =
  | "idle"
  | "checking"
  | "valid"
  | "invalid"
  | "not_found"
  | "error";
```

### valid

現在有効な登録番号の場合:

```text
✓ 現在有効な登録番号です

判定基準日: 2026-09-02
登録日: 2023-10-01
```

### invalid

登録番号は存在するものの、判定基準日時点で有効でない場合:

```text
現在は有効ではありません

判定基準日: 2026-09-02
登録日: 2023-10-01
失効日: 2025-07-01
```

`valid: false` はAPIエラーではありません。

登録番号自体は存在しており、Bango API が正常に有効性を判定した結果として扱います。

### not found

登録番号そのものが見つからない場合は404として扱います。

```text
登録番号が見つかりませんでした
```

`valid: false` と404は意味が異なるため、UIでも別の状態として表示します。

### error

APIのレート制限・利用上限・依存サービス障害・通信失敗などは、有効性の判定結果とは分けて表示します。

```text
現在確認できません。時間を置いて再試行してください
```

「確認できなかった」を「無効」として扱わないことが重要です。

## Preventing stale results

一度有効性を確認したあとにT番号を変更した場合、以前の判定結果をそのまま表示し続けると誤解につながります。

そのため、このサンプルでは入力値が変更された時点で以前の結果をクリアします。

```ts
function clearValidityCheck() {
  requestControllerRef.current?.abort();
  requestControllerRef.current = null;

  setCheckStatus("idle");
  setValidity(null);
  setCheckError(null);
}
```

また、ブラウザ側の進行中の `fetch` は `AbortController` で中断します。

これにより、

```text
T番号Aを確認
  ↓
レスポンス待ち
  ↓
T番号Bへ変更
  ↓
遅れて返ったT番号Aの結果を表示
```

という stale result がUIへ反映されることを防ぎます。

なお、これは主にブラウザ側の stale result 対策です。ブラウザ側で `fetch` を中断しても、すでに Next.js Route Handler 側で処理が始まっている場合、Route Handler から Bango API への上流リクエストまで必ずキャンセルされるとは限りません。

## Invoice date

フォームには請求日がありますが、このサンプルでは **請求日をインボイス有効性の判定には利用していません**。

判定対象はあくまで現在時点です。

```text
請求日
2026-09-01

        ↓ 判定には渡さない

GET /v1/invoice/{registration_number}/valid
```

請求日や取引日時点での有効性を確認する場合は、`date` クエリを指定する実装へ拡張できます。

## Submit behavior

このサンプルはインボイス有効性確認のUIとAPI連携に焦点を当てているため、請求書のデータベース保存処理は実装していません。

フォーム送信時は入力値を確認するだけです。

```ts
function onSubmit(values: FormValues) {
  console.log(values);
}
```

また、`valid: false` の場合でも、このサンプルでは請求書登録そのものを一律にブロックしません。

実際のプロダクトでは業務要件に応じて、例えば次のような制御を追加できます。

- 警告だけ表示して登録を許可する
- 確認ダイアログを表示する
- 未確認の場合は再確認する
- 特定条件では登録をブロックする
- submit直前にもう一度APIで確認する

## Error states

このサンプルでは主に次のケースを扱います。

- T番号の形式不正
- 登録番号が見つからない
- 現在有効ではない登録番号
- APIのレート制限
- 月間API利用上限
- Bango API の依存サービス障害
- その他のAPI取得失敗
- 通信中にT番号を変更した場合

## Verify

```bash
npm run lint
npm run build
```

動作確認時には、少なくとも次を確認してください。

- 有効なT番号で `valid: true` が表示される
- 現在有効ではないT番号で `valid: false` が表示される
- 存在しないT番号で404表示になる
- 形式不正なT番号ではAPIを呼び出さない
- T番号を変更すると以前の判定結果が消える
- APIキーがブラウザへ露出していない

## Production considerations

このサンプルは Invoice Validity API の連携フローを分かりやすくするため、UIとエラー処理をシンプルにしています。

実運用では必要に応じて、次のような改善を検討してください。

- submit直前の再確認
- アプリ側の rate limit
- キャッシュ戦略
- ログ・監視
- API障害時のフォールバック
- APIレスポンスのランタイムバリデーション
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

このサンプルでは動作確認用として公開されているインボイス登録情報を利用しています。各事業者との提携・推奨関係を示すものではありません。

Bango API は国税庁の法人番号公表データ・適格請求書発行事業者公表データを取得・加工して提供しています。内容は国税庁によって保証されるものではありません。

また、Bango API が返すインボイス有効性は公開データに基づく情報であり、それ自体が個別の税務判断を保証するものではありません。
