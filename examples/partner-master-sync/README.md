# 取引先マスタの名寄せ・変更通知・同期回復

架空の会計SaaSの取引先マスタを題材に、名寄せ → 統合照会 → checkpoint → watch → Webhook → Pull補完 → 410欠落からの再baselineを学ぶ、TypeScript / Node.js / SQLiteのサンプルです。

**オフラインデモと実API照会は別コマンドです。** デモは合成データのみで完結します。`live:read` はBango APIのバッチ名寄せ・法人照会・指定日のインボイス有効性・incremental checkpoint取得を実行します。watchの作成/停止、公開HTTPSの作成、Webhook管理、顧客DBの更新は行いません。

## まずオフラインで試す

Node.js **22.16.0以降**が必要です。Node 24系を推奨します。TypeScriptはNodeのtype strippingで直接実行し、型チェックは別コマンドで行います。`node:sqlite` は実行環境によってExperimentalWarningが出るAPIです。lockfileに固定した依存の初回取得にはネット接続が必要ですが、インストール後のテスト・デモはBangoへの接続もAPIキーも不要です。

```sh
cd examples/partner-master-sync
npm ci
npm run typecheck
npm test
npm run demo
```

デモはメモリ内SQLiteと `127.0.0.1` の一時HTTPサーバーを使います。出力は `simulation: true` で、最後の `finalState` から取引先・subject・inbox・checkpointを確認できます。

- `partner-1`: `confident` → 架空法人に紐付け、最終 `subject_version: "4"`。
- `partner-2`: `review` → 自動確定しない。`partner-3`: `unmatched` → 紐付けない。
- 同一イベントをWebhookで2回受け、Pullでも取得しても、inboxは1件。
- 模擬410では **新checkpoint → active watchのfresh baseline → incremental再開**。失効した過去イベントの復元ではありません。

`1234567890123`、`mock:0`、デモ署名鍵などは合成値です。モックは処理順を説明する最小モデルであり、公開APIの全レスポンス項目を再現するものではありません。名寄せ精度や工数削減の実測値も示していません。

## 任意の実API照会

[APIキー管理](https://bango-api.jp/dashboard/api-keys)で発行したキーを、サンプル直下の `.env.local` に設定します。既存ファイルがある場合は上書きせず編集してください。

```sh
cp .env.example .env.local
chmod 600 .env.local
# エディタで BANGO_API_KEY を設定（キーをコマンド行に直接書かない）
npm run live:read -- --confirm --date 2024-10-01 'トヨタ自動車株式会社'
```

企業名は1〜3件の位置引数です。自分が利用してよい公開法人だけを指定し、顧客の取引先一覧を渡さないでください。`--confirm` と実在する暦日 `YYYY-MM-DD` を必須にしています。既存の環境変数がある場合は `.env.local` より優先されます。

実行内容:

1. `POST /v1/batch/match` で名寄せジョブを1回作成。
2. `GET /v1/batch/{job_id}` を上限付きで確認し、完了後に `download?format=json` を取得。
3. `confident` の候補だけを法人照会し、レスポンスにインボイス登録番号があれば指定日の有効性を照会。`review` / `unmatched` は自動紐付けしません。
4. `GET /v1/change-events?mode=incremental&start=now` で現在末尾のcheckpoint取得を確認。

`live:read` はwatchやマスタを変更しませんが、**バッチPOSTはサーバーにジョブを作り、利用枠を消費します**。成功結果は `simulation: false` とAPI呼び出し数を表示します。失敗時にモックへ切り替えません。実APIのデータをデモのSQLiteに混ぜず、checkpointの取得だけで同期を開始・完了したとは扱いません。

### 利用枠とエラー

2026-10-15に確認した公開DocsではFreeは通常API **500回/月**、バッチ名寄せ **50件/月**、active watch **5件**、Webhook通知先 **1件**、変更履歴 **7日**です。[最新のDocs](https://bango-api.jp/docs#change-monitoring)と[料金プラン](https://bango-api.jp/pricing)を実行前に確認してください。実行中の他処理やリトライも枠を消費します。

呼び出し上限は、POST 1回 + status最大10回（2秒間隔）+ download 1回 + 法人/有効性照会を最大2回×入力件数 + checkpoint 1回です。入力3件なら最大19回、1件なら最大15回。名寄せ件数は入力数の1〜3件です。各HTTPリクエストは10秒で打ち切ります。CLIの `callsMade` は送信試行数で、サーバーの課金・枠消費確定値ではありません。

HTTPエラーの `status` / Problem `code` / `Retry-After` を確認して停止します。キー、本文、署名、ジョブの自由文エラーは例外ログへ出しません。タイムアウト、ジョブ失敗、429等でPOSTを自動再送しないため、成功が不明なまま同じ名寄せを繰り返さないでください。

### 後始末

- オフラインデモのDBとHTTPサーバーは終了時に破棄します。テスト用ファイルDBもテストが削除します。
- 実APIモードはwatch / Webhook通知先を作成しないため、その削除操作は不要です。名寄せジョブと利用枠消費は取り消しません。使い終わった検証キーはDashboardで失効し、不要な `.env.local` は削除してください。
- `.env.local`、SQLiteファイル、`node_modules` はGit対象外です。CLI出力や画面収録にも機密情報が含まれていないか確認してください。
- **watchの自動作成・cleanupは未実装。** 冪等PUTの結果だけでは、並行操作や応答不明時に「このサンプルが新規作成した対象」と確実に判定できません。既存watchの誤停止を避け、今回は照会に限定しています。

## 署名検証と永続化

受信処理は公式 `standardwebhooks` SDKのverifierを使います。JSONを再serializeせず、受信したraw bodyと `webhook-id` / `webhook-timestamp` / **全体の** `webhook-signature` を渡します。署名が通った後に `body.id` と構造を検証し、通常イベントはinboxのCOMMIT後に200を返します。署名不正は401、payload不正は400、DB失敗は500です。

鍵を複数渡せるため、rotation中は新旧鍵を併置できます。graceful rotationの新→旧2署名をSDKにそのまま渡し、新鍵のみ・旧鍵のみの受信者も確認します。旧鍵を削除する時期はBangoのrotation手順に従ってください。SDKの時刻許容幅±300秒は署名の鮮度の条件で、inboxの重複排除期間ではありません。

`endpoint.test` も必ず署名検証し、業務inbox / subjectは更新しません。テスト成功は署名・疎通確認であり、通常の公表変更の配送成功ではありません。

Bango実装の署名関数・鍵選択を**ローカルで実行して生成した、合成データ・固定テスト鍵のfixture**と照合します。実際に本番から配送されたメッセージではありません。fixtureの生成元・リビジョン・hashはfixture内に記録し、署名済みメッセージと署名はそのまま保持します。テストでは32バイトの `0x07` / `0x09` を `whsec_` + Base64にして鍵を実行時に組み立て、シリアライズしたfixtureに認証情報を置かないようにしています。テスト専用鍵を実環境へ設定しないでください。

## 同期の責任分界

| Bango APIが返すもの | 受信側が実装すること |
| --- | --- |
| 名寄せ結果と候補 | 自社取引先IDへの対応付け、曖昧候補の人手確認 |
| 統合情報・有効性・watch baseline | ローカルマスタへの保存 |
| full snapshotと署名付き変更イベント | raw body検証、durable inbox、重複排除、版数比較 |
| incremental cursor・履歴欠落エラー | ページとcheckpointの原子保存、fresh baselineによる現在値の回復 |

新旧判定には10進文字列の `subject.version` を `BigInt` で比較します。到着順やevent IDでは判定しません。`data.current.company` と `invoice` をnullも含め丸ごと置換し、`data.changes` をJSON Patchとして実行しません。削除後も版数を残すため、古いイベントで復活しません。

保存するcheckpointはincrementalの `next_cursor` のみです。history cursorや最後のWebhook IDを昇格させません。初回は **checkpoint取得 → watch → baseline**、gap時は **新checkpoint → fresh baseline → incremental** の順です。実APIモードに汎用Pullエンジンやライブのgap復旧は含まず、この順序はオフラインで検証します。

## ファイルと検証範囲

- `src/mock.ts` / `src/cli.ts`: 合成データとオフライン実演。
- `src/core.ts`: SQLite、inbox、版数比較、Pullとcheckpointの原子保存。
- `src/webhook.ts`: 公式SDKによる検証、HTTP受信、COMMIT後の応答。
- `src/sync.ts`: モックPullと410からの回復。
- `src/live.ts` / `src/live-cli.ts`: 公開OpenAPIに沿った実API照会と明示的な起動。
- `src/verification.ts` / `src/verification-cli.ts`: 単一法人の検証専用ファイルDB・受信・checkpoint/Pull。実行条件は[検証runbook](./VERIFICATION.md)。実HTTPS E2Eは未実施。
- `tests/`: 署名fixture、HTTP/SQLiteの動作、実APIアダプターのモック契約テスト。

`npm test` は外部APIを呼びません。署名改竄・raw body・鍵rotation・時刻境界・endpoint.test・COMMIT失敗・再送重複・順序逆転・大整数版数・削除・再起動・Pull/410のほか、liveのジョブ遷移とエラーを検証します。型チェックは `npm run typecheck`。専用の[GitHub Actions](../../.github/workflows/partner-master-sync.yml)は、対象ディレクトリまたはworkflowの変更があるmain向けPRと元の教材ブランチ向けの検証PR（Draftを含む）、およびmainへのpushで、Node 22/24の `npm ci`・typecheck・test・demoを実行します。Bangoのキーや実APIは使いません。サンプル自体のlint設定はありません。

### 前回の実行記録（2026-10-15 JST、今回の行対応修正前）

| 確認対象 | 結果 |
| --- | --- |
| 元PRの10テストとデモ | Node 22.16.0 / 24.13.0で独立再実行、10/10成功 |
| 更新後 `npm ci` / `npm run typecheck` / `npm test` / `npm run demo` | Node 22.16.0（npm 10.9.2）/ 24.13.0（npm 11.15.0）で成功、28/28テスト |
| 実APIの名寄せ → status → download → checkpoint | 公開法人名1件、HTTP 202/200/200/200、4リクエストで終了0 |
| 実APIの法人照会・指定日有効性 | Docs掲載の `1180301018771` / `T1180301018771` を別途明示指定、各1リクエストで200。`2024-10-01` の `valid: true` |

名寄せ結果は `review` だったため、自動紐付け・その候補の自動照会を行いませんでした。confidentからの連続照会はモック契約テストで確認し、実APIでは未確認です。実接続は計6リクエスト、名寄せ入力1件。レスポンスのquotaは `unlimited: true` で、**Freeプランの実枠消費や上限内動作は未実証**です。Free向けの呼び出し上限は上記の計算と契約テストによる確認です。認証情報・ジョブID・cursorはこの記録へ載せていません。

この前回記録の時点ではGitHub CIは未実施でした。Nodeを明示する前の依存インストールは環境のnpm cache権限で一度失敗し、作業専用cacheと明示したNodeで再実行して成功しました。API本体や価格・契約には変更を加えていません。

行対応修正後は、Node 22.23.3 / 24.13.0（ともにnpm 11.15.0）で `npm ci`・typecheck・36/36テスト・demoが成功しました。件数・行番号・送信した名称の対応を検証し、内部表記を独自に正規化せず、正しい重複入力も受け付けます。今回のテストは合成レスポンスで実行し、実Bango APIには接続していません。コミットごとのCI結果は[PR #4](https://github.com/taku1211/bango-api-examples/pull/4)のChecksと実行記録で確認できます。

### 実APIの手動検証（2026-10-15時点）

owner承認環境で、固定HEAD `461542f`によるinit、新watch登録、baseline、署名付き`endpoint.test`のHTTP 200を確認しました。通常eventは未観測です。空Pullを1ページ実行し、`eventCount=0`、`inserted=0`、`ignoredCount=0`、`hasMore=false`、`gap=false`、前後inbox件数0を確認しました。checkpoint digestは前後同一で、cursor前進の証拠ではありません。endpoint.testがinboxに保存されないことも確認しました。今回watchはDELETE HTTP 200でstopped、endpointはpause後に削除し、既存active/stopped watch 2件は不変でした。Railwayの元設定復元と専用volume削除も完了し、元の停止状態（running 0）を確認しました。実410は未発生です。全体のE2Eは未完了です。秘密値や組織・watch・receiverの識別情報は掲載していません。

`live:read` はバッチ名寄せ等とcheckpoint取得を行いますが、cursorを次回用に保存せず、watchやendpointも管理しません。`demo` の受信先はloopback上の一時HTTPサーバーと合成鍵です。`verification`は署名検証・永続inbox・checkpoint/Pullを備えますが、実環境での通常event、Pull補完、410回復は未検証です。確認範囲と次の手順は[検証runbook](./VERIFICATION.md)を参照してください。

この入口は業務反映を行わず、上の教材デモや下の一連のE2E全体を実証済みにするものではありません。

以下は教材全体のE2E手順で、空の検証組織を前提とします。既存watchを保持したまま受信・Pullだけ検証する場合は、上の検証runbookを使ってください。開始前に、組織ownerが専用の検証組織、対象となる公開法人1社と識別子、受信HTTPS URLとevent type、1回の `endpoint.test`、Pullの利用枠消費、後述の停止・削除対象を明示的に承認してください。組織は自分が管理し、他の利用者や並行操作者がいない状態にします。既存のwatchまたはendpointがある、所有者を確認できない、利用枠が不明、対象が顧客データ、または実データ変更を意図的に起こす必要がある場合は停止します。プラン変更・顧客データの投入・公表データの改変はこの手順に含めません。

1. **名寄せと対象確定:** 必要なら上記の `live:read` で公開会社名を1件だけ照合します。バッチ名寄せはPOSTで利用枠を消費します。結果が `confident` でない場合、または法人番号を公開情報と照合できない場合は停止し、review候補を自動確定しません。1社につき法人番号または対応するT番号のどちらか一つを使い、対象名・選んだ識別子・開始時点のwatch/endpoint状態を記録します。
2. **checkpointを先に保存:** APIキーで `GET /v1/change-events?mode=incremental&start=now` を実行し、返る `next_cursor` を秘密情報として安全に保存します。これはwatch登録より先です。`start=now` は呼び出し時点の末尾を示すため、後から取得するとその間の変更を飛ばすおそれがあります。Pullは月間APIコールを消費し、history cursorはcheckpointに使えません。
3. **watchとbaseline:** 選んだ一つの識別子で `PUT /v1/watch-targets/{identifier}` を実行します（request bodyなし）。返った現在のfull baselineと `subject.version` を自社の検証DBに保存します。同じ対象へのPUTは冪等で、既存のactive watchを返すことがあります。法人番号とT番号を混在させた重複PUT、並行操作、応答timeoutのいずれからも、この実行がwatchを新規作成したとは判断できません。200応答も新規所有の証明ではありません。timeout時にPUTを自動再送・DELETEせず、ownerが一覧・状態と事前記録を照合して判断します。
4. **HTTPS endpointとtest:** 受信実装を先に公開HTTPSで稼働させます。owner/adminはログイン利用者の `Authorization: Bearer <JWT>` で管理します。APIキーとは別の認証です。[変更監視画面](https://bango-api.jp/dashboard/change-monitoring)でendpointを作成すると直ちにactiveになります。作成時に一度だけ返るsecretを受信側へ設定し、続けて署名付き `endpoint.test` を一度送ります。作成からsecret設定までに通常eventが届く可能性があるため、先に保存したcheckpointから後でPull補完します。raw bodyの署名検証と受信応答、およびDashboard/API結果の `success=true` を確認してください。HTTP 200だけでは成功と判定しません。安全でない宛先と判定されるとendpointがdisabledになる場合があるため、承認済みの自分のURLだけを設定します。testは通常eventとは別で業務snapshotを更新しません。test結果が失敗なら通常eventを待たず停止し、ownerが状態を確認します。
5. **通常の公表変更を待つ:** 実在する公表変更を待ち、変更を作る目的で公表データや顧客DBを編集しません。署名付き通常イベントが届いたら、署名検証後にevent IDで重複排除し、COMMIT後に2xxを返したこと、full snapshotをversion比較して適用したことを確認します。実際の公表変更が観測されなければ、この受信経路は未検証です。`endpoint.test` 成功を通常eventの受信証明に数えません。
6. **Pull補完と410回復:** 保存済みcursorで `GET /v1/change-events?mode=incremental&cursor=<saved>` を実行し、Webhookと同じevent IDが重複しても業務副作用が一度だけであること、inbox処理と `next_cursor` 保存が原子的であることを確認します。`410 CHANGE_EVENT_HISTORY_GAP` が返った場合は、まず `GET /v1/change-events?mode=incremental&start=now` で新checkpointを保存し、次に `GET /v1/watch-targets` でactive watchを列挙し、各対象の `GET /v1/watch-targets/{identifier}` でfresh baselineをversion比較により反映します。復旧時にPUTを使って停止済みwatchを再開しないでください。その間はwatch編集を止め、編集があった場合は再列挙して照合します。最後に新checkpointからincrementalを再開します。再度410ならこの順をやり直します。失効した過去eventは復元できません。実環境で410を意図的に起こす目的で古いcursorを放置せず、発生しなかった場合はgap回復を未検証と記録します。

終了時はまず受信を止める必要があるかをownerが判断し、承認済みのendpointをDashboardでpauseします。pause後も送信中の試行が完了することがあるため、受信先は直ちに停止せず、その処理を確認してからendpointをdeleteします。承認済みの正確なidentifierだけを `DELETE /v1/watch-targets/{identifier}` で停止します。timeoutや作成結果不明のときに自動cleanupせず、ownerが状態を照合して削除を判断します。停止後の再開は過去eventを自動回収しません。検証キーの失効もownerが完了を確認してから行います。

受入チェックリスト:

- [ ] checkpointをwatchより先に保存し、baselineのversionとともに保持した。
- [ ] 対象名・identifier一件と開始時点のwatch/endpoint状態を記録した。
- [ ] HTTPSで `endpoint.test` の署名を検証し、結果 `success=true` を確認した。
- [ ] 通常の公表変更を受信・永続化・重複排除した。実際の変更がなければ未検証と記録した。
- [ ] Pull補完でcheckpointを進めた。
- [ ] 410が実際に起きた場合は新checkpoint→fresh baseline→incrementalの順で回復した。未発生なら未検証と記録した。
- [ ] ownerが停止・削除対象を照合してcleanupを判断した。
- [ ] 証拠記録に日時・operationのHTTP status・event ID/version・証拠ファイルのSHA-256を残し、API key・secret・cursor・署名は除外した。

一つでも実際に確かめられなかった項目は合格扱いにしません。詳細な公開契約は[変更監視・Webhookの初回導入](https://bango-api.jp/docs#change-monitoring)と[OpenAPI仕様](https://bango-api.jp/openapi.json)を参照してください。

### 制約

SQLiteは単一org・単一consumer・単一プロセスの学習用です。複数ワーカー、負荷試験、高可用性、outbox、外部副作用のexactly-onceは対象外です。公開HTTPSでの署名付き `endpoint.test` は確認済みですが、通常変更イベントの実配送は未検証です。検証CLIはHTTP受信とローカル永続化を提供しますが、TLS終端やクラウド環境の自動構築は含みません。

実運用のWebhook管理にはowner/adminのDashboard/JWTが必要です。APIキーでは通知先を作成できません。公開HTTPS・時刻同期・秘密管理・監視・DB運用は利用者側で整備し、サンプルをそのまま本番へ配置しないでください。保持期限外の過去履歴を復元できるとは保証しません。

関連: [Bango Docs](https://bango-api.jp/docs) / [公開OpenAPI](https://bango-api.jp/openapi.json) / [Webhook初回導入](https://bango-api.jp/docs#change-monitoring) / [サンプル一覧](../../README.md)。契約参照日は2026-10-15です。ルートのMITライセンスが適用されます。依存の更新時には互換テストを再実行してください。
