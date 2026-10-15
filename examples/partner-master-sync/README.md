# 取引先マスタの名寄せ・変更監視・同期回復（オフライン実装例）

Bango API の「名寄せ → 統合取得 → watch → 署名付き変更通知 → 重複排除 → Pull補完 → 410欠落時の再baseline」を、**架空の会計SaaS**の取引先マスタで学ぶ最小サンプルです。

> **これはフェーズ②の第1実装（Draft）です。** 現在実装されているのは**完全オフラインの模擬実行**だけです。Bango API本番への接続、実キーでの名寄せ・watch操作、公開HTTPSでの `endpoint.test`、実変更イベントの受信は**未実装・未実証**です。例に出る会社・法人番号・イベント・cursor・チェックポイントは全て合成値です。実業務上の名寄せ精度や運用工数の削減を示すものではありません。

## 実行方法

Node.js **22.16以降**が必要です。Node 24系を推奨します。TypeScriptの実行と `node:sqlite` を使うため、Node.jsのバージョンによってExperimentalWarningが出る場合があります。外部パッケージ不要でオフライン実行できます。

```bash
cd examples/partner-master-sync
npm ci
npm test
npm run demo
```

`npm run demo` は `:memory:` SQLiteを使い、localhostの短命なHTTPサーバーへ**自作のテスト署名**付きイベントを送ります。公開ポート・クラウドデプロイ・実APIキーは不要です。出力には `simulation: true` が明示され、最後に以下が示されます。

- `partner-1`: `confident` → 架空法人へ紐付け（`subject_version: "4"`）。会社名の変更がマスタへ反映される。
- `partner-2`: `review` → **自動確定しない**。
- `partner-3`: `unmatched` → **紐付けない**。
- Webhook 2回受信 → inbox 1件。
- 同じイベントがPullにも出現 → inboxが重複しない。
- 模擬410 gap → **新checkpoint取得 → 最新baseline → incremental再開**。消失したイベント履歴そのものは取り戻せない。

## 顧客実装とBango APIの責任分界

| 処理 | Bango API本体の機能 | このサンプルが示す顧客側の仕事 |
|---|---|---|
| 企業名リスト | バッチ名寄せ・候補・`confident/review/unmatched` | 確定/目視/保留の判断と取引先ID紐付け |
| 初期状態 | 法人/T番号取得・過去日付判定・watch baseline | 取引先マスタの保持 |
| 変更通知 | `data.current.company` / `invoice` を含む変更イベント・署名と再送 | raw bytesの検証、durable inbox、重複排除、状態反映 |
| 再同期 | Pull incrementalと `CHANGE_EVENT_HISTORY_GAP` 検知 | cursor保存、現在値からの再baseline、古い版数の排除 |

実装では、履歴cursorではなく **incremental `next_cursor`** をcheckpointに保存します。初回は **checkpoint → watch登録** の順序を守ります。更新判定はイベント到着順やevent IDではなく **`subject.version`（10進文字列を `BigInt` に変換）** によって行い、更新後の `company` と `invoice` を同時に置き換えます。削除で `null` が来た場合も反映します。

## 実装の構成

- `src/mock.ts`: Bangoを模した**合成レスポンスと合成イベント**。データモデルの全項目を網羅したものではありません。
- `src/core.ts`: `node:sqlite`で取引先、subject、inbox、checkpointを保存。Pullページとcheckpointを同一トランザクションで記録。
- `src/webhook.ts`: テスト用HMAC署名の検証、raw body取得、正常受信後のCOMMIT→200応答。`endpoint.test`は業務データを変更しません。
- `src/sync.ts`: 模擬Pullと410時の再baseline。
- `src/cli.ts`: 1回のオフライン実演。
- `tests/offline.test.ts`: 模擬名寄せ、HTTP署名検証、改竄、重複、古い版数、null削除、再起動、トランザクション失敗、gap回復を自動テスト。

## 商用利用に向けた注意・未実装

1. **署名検証:** この第1実装は**Standard Webhooksの通信形式をNode標準cryptoで模擬した教育用実装**です。実際のBango署名との公式SDK互換テストは未実施。**本番受信には公式 `standardwebhooks` ライブラリを使い、実署名fixtureと互換テストで確認してください。** 自作署名器の成功をBango本番配信成功と混同しないでください。
2. **SQLiteは単一プロセス・教育用。** Bango本体で検証済みのPostgreSQL受信例（非公開）は、durable inbox、並列処理、再送、副作用のoutboxを含みます。本サンプルは複数ワーカー、キュー、外部副作用、商用SLA、監査ログの完全性を実装していません。
3. **本番には公開HTTPSが必要。** BangoのWebhook管理はログインしたowner/adminのDashboard/JWTによる別系統。APIキーだけでWebhook URLを自動登録するサンプルではありません。
4. **gapで失った過去イベントは復元できません。** 現在のsnapshotへ整合を回復しても、過去の業務イベント・副作用・監査上の完全履歴を再現したとは言えません。watch編集中の競合、長期間の停止、保持・再送制約は別途設計が必要です。
5. **数値は架空:** `1234567890123`、`mock:0` 等は実際の法人番号やAPI cursorではありません。APIレスポンス例は現行公開OpenAPIと混同しないでください。顧客の実データ・認証情報をリポジトリへ追加しないでください。

### 関連資料

- [Bango API](https://bango-api.jp/) / [Docs](https://bango-api.jp/docs) / [API仕様](https://bango-api.jp/openapi.json)
- [Webhook初回導入](https://bango-api.jp/docs#change-monitoring)
- [キャンペーン進捗 Issue #645](https://github.com/taku1211/houjin-search/issues/645)
- [Bango APIサンプル一覧](https://github.com/taku1211/bango-api-examples)

既存4つのNext.js例は入力UI中心ですが、この例は**顧客側で必要となる継続同期の責務**に焦点を当てています。

### ライセンス・依存セキュリティ

ルートのMITライセンスが適用されます。Node.js / npm / OSの脆弱性や公開されているセキュリティ修正は、利用時点の最新版で確認し直してください。このサンプルをそのまま本番にデプロイすることは推奨しません。
