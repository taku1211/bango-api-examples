# Bango API Examples

[Bango API](https://bango-api.jp/) を使った実装サンプル集です。

各サンプルは独立して実行できます。

## Examples

| Example | Description |
| --- | --- |
| [nextjs-corporate-number-autofill](./examples/nextjs-corporate-number-autofill) | 法人番号から会社名・住所・インボイス登録状況を自動補完 |
| [nextjs-company-autocomplete](./examples/nextjs-company-autocomplete) | 会社名から企業候補を検索し、選択した法人情報を自動補完 |
| [nextjs-invoice-issuer-lookup](./examples/nextjs-invoice-issuer-lookup) | T番号から登録事業者情報とインボイス登録状況を取得 |
| [nextjs-invoice-validity-check](./examples/nextjs-invoice-validity-check) | 請求書登録時にT番号の現在の有効性を自動確認 |

## API Key

各サンプルの実行には Bango API の API キーが必要です。

[Bango API](https://bango-api.jp/)

各サンプルディレクトリで `.env.example` を `.env.local` にコピーし、APIキーを設定してください。

```bash
cp .env.example .env.local
```

```env
BANGO_API_KEY=YOUR_API_KEY
```

## Run an example

例:

```bash
cd examples/nextjs-company-autocomplete
npm ci
npm run dev
```

ブラウザで以下を開きます。

```text
http://localhost:3000
```

各サンプルの詳細は、それぞれの README を参照してください。

## Dependency and security notice

このリポジトリのサンプルは、**各サンプル作成時点のライブラリバージョンで動作確認したもの**です。

公開後に依存ライブラリの新しいバージョンやセキュリティ修正がリリースされている場合があります。また、作成時点では把握されていなかった脆弱性が、後から報告される可能性もあります。

実際のプロダクトへ組み込む場合は、このリポジトリの依存バージョンをそのまま採用するのではなく、**利用時点で各ライブラリの最新の安定版、セキュリティアドバイザリ、変更履歴を確認し、必要なアップデートと動作確認を行ってください。**

## License

MIT
