# Bango API Examples

[Bango API](https://bango-api.jp/) を使った実装サンプル集です。

各サンプルは独立して実行できます。

## Examples

| Example | Description |
| --- | --- |
| [nextjs-corporate-number-autofill](./examples/nextjs-corporate-number-autofill) | 法人番号から会社名・住所・インボイス登録状況を自動補完 |
| [nextjs-company-autocomplete](./examples/nextjs-company-autocomplete) | 会社名から企業候補を検索し、選択した法人情報を自動補完 |

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

## License

MIT
