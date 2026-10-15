# 検証専用Webhook・Pull runbook

これは公開教材とは別の、単一組織・公開法人1件・単一プロセス用の検証入口です。2026-10-15のowner承認環境では、init、新watch登録、baseline、署名付き`endpoint.test`のHTTP 200を確認しました。通常変更イベントは未観測です。空のPullを1ページ実行し、watchとendpointのcleanupを行いましたが、Pullではcursor前進を実証しておらず、Railwayの設定復元・volume削除は保留です。実410回復も未観測のため、全体のE2Eは未完了です。通常変更や410を人為的に作りません。

`src/verification-cli.ts` は既存の署名検証・SQLite inboxを再利用し、checkpointをファイルに保存します。外部API操作はGETだけです。watch登録・停止、endpoint管理、鍵発行、名寄せPOST、顧客DB更新、クラウド構築は実装していません。受信とPullはinbox保存までで、業務反映workerは起動しません。

## 開始前にownerが確定するもの

以下が空欄ならlive実施を開始しません。値はowner管理の非公開実行票に記入し、秘密値をIssue/PR/チャットへ貼らないでください。

| 項目 | 確定する内容 |
| --- | --- |
| 操作者・組織 | owner/admin、組織ID、他の操作を並行させない時間帯。既存watchを変更しない。active/stoppedの全一覧が100件以内で、検証法人が未登録であること |
| APIキー | その組織の検証用キーの**管理名と安全な保管先**。キー自体は環境変数へ供給 |
| 公開法人 | 名称・法人番号13桁を1件。公表サイトで照合し、既存watchではないことを確認 |
| 通知先 | owner管理のHTTPS URLと対象service/environment。既存の本番routeを流用しない |
| 署名鍵 | 今回の通知先専用の鍵を供給する経路と責任者。旧endpointの鍵を取り出して流用しない |
| 永続化 | 専用ディレクトリまたは専用volume、保存先・保持期限・バックアップ・削除責任者 |
| 予算・時間 | API試行上限、検証window、クラウドの支出上限と監視担当。料金は実行時の現行契約を確認 |
| 承認する操作 | watch PUT 1件、endpoint作成1件・test 1回、必要ならそのendpointのresume、終了時pause/削除・watch停止。対象IDを確定後に実行 |
| rollback | 元のサービス設定、元の稼働状態、今回新設した資産だけの回収範囲。既存資産を削除しない |

2026-10-15の[公開Docs](https://bango-api.jp/docs#change-monitoring)では、FreeはAPI 500回/月・batch 50件/月・active watch 5件・active endpoint 1件・保持7日です。Proはwatch 10,000件・endpoint 3件・保持90日。今回の1法人・1通知先はFreeの機能枠で可能ですが、**実際の組織の残枠とFreeでの成功は別途確認が必要**です。既存endpointがpausedでも、再開時の競合を確認します。有料プランへの変更は不要で、勝手に変更しません。

## ローカルで準備する

```sh
cd examples/partner-master-sync
npm ci
npm run typecheck
npm test
```

新しい空の状態保存先を選びます。以前のDraft `345f50d`で作成したDBは、新コードで再開しません。2026-10-15の実施は固定HEAD `461542f`で行いました。次回はowner承認済みの新しい固定HEADと新しい空DBを選び、initから各段階のstatus・serve・Pullまで同じHEADと保存先を使います。`461542f`を次回も使う指定ではありません。旧DBの移行や互換性を推測せず、教材のDB、他組織のDB、本番DBと共有しません。以下の値は非秘密の例です。実行時は承認済みの値へ置き換えます。

```sh
export BANGO_VERIFICATION_DIR=/absolute/private/path/verification-645
export BANGO_VERIFICATION_ORG=owner-confirmed-organization-id
export BANGO_PUBLIC_CORPORATE_NUMBER=owner-confirmed-13-digit-number
# BANGO_API_KEY / BANGO_WEBHOOK_SECRET は承認済み秘密管理経路から供給する。
# 値をシェル引数・履歴・ログに書かない。set -x は使わない。
```

組織IDはownerの申告を状態と結びつけるラベルです。APIキーの所属組織をこのラベルだけで証明できません。事前にDashboardの選択組織とキーの所属を確認してください。APIキーの切り替えや別組織の状態再利用はしません。

CLIは専用保存先を排他利用します。`serve`中に別のCLIで同じ状態へ書き込まず、正常終了してから次のコマンドへ進みます。状態は`verification.sqlite`、lockは`.verification.lock`です。異常終了でlockが残った場合は、旧deployment全体を停止し、DB/volumeを使う他のprocessやcontainerがないことをownerが確認してから、DBをバックアップしてlockだけを除去します。lock内のPIDだけで別containerのprocessかどうかを決めつけません。稼働中deploymentや他processが使うDBのlockは削除しません。

今回、npm run経由の`serve`停止後にlockファイルが残りました。旧deploymentが完全に削除・offlineで、ほかに稼働中processがないことを外部確認した後、操作者が既知のPID 25のlockだけを除去しました。直接Nodeを起動した場合のgraceful shutdownはliveで未再検証です。

## 承認後の実行順序

`--confirm` は操作前提を確認した操作者の明示指定であり、本書やPRの存在が実環境操作の承認になるわけではありません。各コマンドの終了コードと時刻を記録し、失敗したら次へ進みません。

1. **初期状態を記録。** Dashboardで組織・残枠・watch全状態・endpoint全状態を確認。既存watchはそのまま残します。停止済みや法人番号/T番号の別表記を含め同じ法人のwatchがある場合は、新規検証対象に使いません。既存watchも自分が管理する公開法人だけであることを確認し、顧客・非公開データが含まれる場合は停止します。
2. **checkpointを先に保存。** 全状態の一覧（`status=all&limit=100`）と`start=now`の計2 GETです。既存watchのID・状態・識別子・subject対応を専用DBに記録し、対象法人が未登録であることを検査します。1ページに収まらなければ停止し、自動でページを追加取得しません。checkpointはwatch作成前の**無filter**で取得し、後から`watch_target_id`を追加しません（cursorのfilter bindingが変わるため）。

   ```sh
   npm run verification -- init --confirm
   npm run verification -- status
   ```

3. **承認したwatch 1件を登録。** owner/adminが正規APIで法人番号をPUTします。201と作成ID・subject IDを秘密を除いて記録します。200、timeout、同時操作があった場合は、この実行の新規作成と決めず停止して所有権を照合します。再PUTや自動cleanupはしません。
4. **baselineを保存。** 全状態の一覧が「保存した既存watch集合のまま＋今回のactive対象1件」であることと、GET baselineのwatch/subject対応を検査します。2 GETです。既存watchの停止・削除・再開、別の追加、対象subjectの衝突があれば停止します。今回のwatch IDも固定し、同じ法人の別watch periodへ自動で乗り換えません。

   ```sh
   npm run verification -- baseline --confirm
   npm run verification -- status
   ```

5. **承認したendpointを作成し、安全に鍵を供給。** JWTによる通知先管理とAPIキーによるデータ取得を混同しません。新規作成時の一度限りのsecretを、承認済み秘密管理経路で`BANGO_WEBHOOK_SECRET`へ設定します。作成結果不明なら再作成や既存鍵のrotationをせずowner確認へ戻します。
受信入口は既存の署名検証を再利用し、検証CLIではbaselineと同じsubjectの通常イベントだけをinboxへ保存します。通知先には法人単位のfilterがないため、既存watchのイベントも届く可能性があります。正しい署名・構造で対象外のsubjectなら保存せず200を返し、不要な再送を避けます。不正署名や不正構造は従来どおり拒否します。検証中はwatchの並行編集や別組織の署名鍵への差し替えをしません。

6. **受信を開始。** 既定はloopback。クラウドでは承認したserviceだけで`HOST=0.0.0.0`、既存の公開portを設定します。既存入口は`POST /webhooks/demo`、最大body 64 KiBです。healthcheck専用routeはありません。providerで既存`/health`チェックをそのまま設定しないでください。

   ```sh
   npm run verification -- serve --confirm
   ```

   `BANGO_VERIFICATION_WINDOW_SECONDS`は既定600秒、最大1800秒です。BANGO側の停止を自動実行するコマンドではありません。時間終了前に操作者が次の停止手順を行い、通信が落ちたまま通知先を放置しないでください。
7. **ownerが承認したtestを1回実行。** senderの`success=true`、受信HTTP 200を照合します。これは署名と疎通の証拠だけです。testは業務inboxへ入らず、通常eventや永続化の成功件数に含めません。必要なresumeはこの通知先について別途明示承認された範囲だけで行います。
8. **自然な通常変更を観測。** 通常イベントを作るためのDB変更・writer手動起動・古いcursor投入はしません。署名検証済み受信の200とsenderの同event ID/attemptを照合します。window内に届かなければ「未観測・未検証」です。
9. **受信windowを閉じ、Pullへ。** ownerが今回の通知先をpauseし、in-flightがなくなったことを確認してからSIGTERMで受信を閉じます。停止に失敗したら受信だけを先に消さずownerが判断します。`status`のinbox ID（最新100件まで）を記録した後、1ページだけPullします。

   ```sh
   npm run verification -- status
   npm run verification -- pull --confirm
   npm run verification -- status
   ```

   Pullは1回につき1 GET、最大100イベントです。無filterのページから対象subjectだけをinboxへ保存し、対象外イベントは保存・ログ出力せず破棄します。対象外だけのページでも返却されたcheckpointを原子的に進めます。これは今回専用DBのcursorだけで、他のconsumerや既存watchには影響しません。`hasMore=true`なら承認した回数上限内だけ手動で繰り返します。空ページは「実APIでcheckpointを保存して継続できた」証拠であり、欠落イベントを回復した証拠ではありません。`eventCount`はページ件数、`inserted`は今回追加したinbox件数です。`ignoredCount`は対象外件数です。同じIDをWebhookとPullで受けてもinboxは1件です。Pull前後の差とsender側記録で経路を区別します。

## 410とcheckpointの扱い

Pullが実際に410を返したときは、旧checkpointを残して停止します。認証・429・ネットワーク失敗ではcheckpointを捨てません。エラー解消のために`init`を再実行したり、DBを削除したりしないでください。

```sh
# 実410を記録した状態だけで、ownerが復旧の開始を判断する。
npm run verification -- recover --confirm
npm run verification -- pull --confirm
```

`recover`は新`start=now` → 全状態のwatch一覧の保存集合照合 → 対象1件のfresh baselineの順で計3 GET。snapshotと新checkpointを一つのtransactionで確定します。途中失敗なら旧checkpointを維持し、保存した既存watchの変更、別watch IDや別subjectへの変更なら停止します。旧inboxを消さず、保持期限外の過去履歴が復元されたとは扱いません。410がなければこの操作は実施せず、回復はローカル合成試験だけと記録します。

無filterのPullと組織単位のWebhookでは、対象外の公開法人payloadを一時的にメモリで受け取ることがあります。対象外payload・IDを保存やログへ残しません。既存watchのpayloadまで保存するためにscopeを広げたり、既存consumerのcursorを流用したりしません。

状態をrollbackする場合、受信停止・DB接続終了後に保存ディレクトリ全体を保護領域へバックアップします。SQLiteの稼働中の本体ファイルだけをコピーしません。復元は**同じ組織・同じ法人**に限り、古いcheckpointからの再取得と重複排除を前提にします。旧checkpointが失効していれば410手順へ戻ります。秘密値やDBそのものをPR/Issueへ添付しません。

## 既存クラウドでの運用

既存の検証用Nodeサービスが使える場合だけ、そのserviceの用途と所有者を再確認します。署名確認だけのsmokeサービスにvolumeがない場合、コンテナの一時ディスクをdurableと呼びません。新DBサービスを増やさず、承認された専用volumeとSQLiteを候補にします。

| 設定 | 準備値 |
| --- | --- |
| source | 次回実施時にownerが承認する固定HEAD（公開教材PRと別）。全段階で同じHEADを使い、自動更新を避ける。今回の実施HEADは`461542f` |
| root / build | `examples/partner-master-sync` / `npm ci --include=dev` |
| Node | 検証済み22または24。CIと同じmajor |
| storage | 新規検証専用volume `/data`、ownerが指定する新しい空の状態保存先。以前のDraft用DBは再利用せず、既存volumeは共有しない |
| replica / restart | 1 / NEVER。自動loopやcronなし |
| network | 既存owner管理HTTPS domain、port 3000、path `/webhooks/demo`。本番Vercelのroute変更は不要 |
| shutdown | drain猶予20秒以上。受信window上限とownerの停止時刻を別に設定 |
| healthcheck | 既存`/health`を無効化する案を承認対象に含める（このCLIには未実装） |
| runtime env | 上のorg・法人・保存先、`HOST=0.0.0.0`、`PORT=3000`、承認済み2種類の秘密値 |

Railwayではvolumeはruntimeのみでmountされます。build/pre-deployで初期化しません。今回のnpm run経由のStart Commandでは、停止時にnpmのSIGTERMログは出ましたが、受信processの正常終了記録はなくlockが残りました。子processへのsignal伝達が原因かは未確定です。RailwayのStart Commandはnpm runを経由せず、`node --experimental-strip-types src/verification-cli.ts <command> [--confirm]`を直接実行します。`status`には`--confirm`は不要です。直接Nodeを起動した場合のgraceful shutdownはliveで未再検証です。各段階で同じvolume・env・owner承認済み固定HEADを維持します。ローカルの`railway run`はそのvolumeを共有しないため使いません。[Railway volumes](https://docs.railway.com/volumes)

承認後に操作者がRailway Dashboardの対象service/environmentでStart Commandを変更し、差分が今回の対象だけであることを確認してDeployします。MCPを使う場合は`update_service`に対象のproject/service/environment ID、`staged: true`、次表の`startCommand`だけを渡し、`get_staged_changes`を確認してから承認済みの`accept_deploy`を実行します。`accept_deploy`はenvironmentの全staged変更を含むため、無関係の差分があれば適用しません。source/root/volume/secretの初回変更も別の承認対象です。

初回sourceは`connect_service_source`の`repo: taku1211/bango-api-examples`、承認した`commitSha`、対象environment、`staged: true`で固定します。branch追従のままにせず、deployのsource SHAが承認HEADと一致することを確認します。既存healthcheckの解除はDashboardで設定を消し、差分と実設定を確認します。volumeは同じenvironment/service、`/data`、承認した最小容量（例: 512 MB）に限定してstageします。CLIの秘密値は値を出力しないRailwayのシークレット変数として操作者が設定し、環境変数一覧の値を証拠へ保存しません。

| 段階 | runtime Start Command | 次へ進む条件 |
| --- | --- | --- |
| checkpoint | `node --experimental-strip-types src/verification-cli.ts init --confirm` | exit0、initialized/checkpointPresent=true。ここでownerがwatchを登録 |
| baseline | `node --experimental-strip-types src/verification-cli.ts baseline --confirm` | exit0、対象subjectId/subjectVersion一致、checkpointPresent=true。endpointを作成して鍵を供給 |
| HTTPS受信 | `node --experimental-strip-types src/verification-cli.ts serve --confirm` | listening=true後にownerがtest。通常event観測。期限前にpause/drain。正常停止 |
| 受信証拠 | `node --experimental-strip-types src/verification-cli.ts status` | exit0、Pull前のinbox IDを保存。秘密値なし |
| Pull | `node --experimental-strip-types src/verification-cli.ts pull --confirm` | exit0とeventCount/inserted/ignoredCount/hasMore。必要時のみ上限内で同じ段階を反復 |
| 終了証拠 | `node --experimental-strip-types src/verification-cli.ts status` | exit0、Pull後のinbox ID・checkpointPresentを保存 |
| 実410のみ | `node --experimental-strip-types src/verification-cli.ts recover --confirm` | exit0後にPullへ。失敗なら旧checkpointのまま停止 |

各短期コマンドが終了するとサービスのHTTPは停止します。これは予定した段階動作であり、継続稼働のhealthcheckを付けません。restart NEVERで`init`やPullを自動再実行させず、各段階の終了コード・出力・HEADを確認してから次へ進みます。2026-10-15時点でlive確認したのはinit、新watch、baseline、署名付き`endpoint.test`のHTTP 200、空Pull 1ページ、watch/endpoint cleanupです。通常eventは未観測、Railway設定復元とvolume削除はRailwayの本人認証待ち、実410も未発生です。

1サービス・1volumeの短時間検証を提案しますが、料金ゼロや支出上限の自動保証はありません。ownerが金額・時間・保存期限を指定するまでは作成・再deploy・既存secret変更を行いません。旧smokeの署名鍵を取得して再利用しません。

## 受入表と後始末

| 項目 | 記録する証拠 | 2026-10-15時点のlive結果 |
| --- | --- | --- |
| 組織・対象・残枠 | owner実行票、watch/endpoint事前一覧、対象法人1件 | owner承認済み。既存watchのない公開法人1件とFree枠を確認 |
| checkpoint先行 | init成功時刻 < watch作成時刻、再起動後checkpointPresent | 2026-10-15 owner承認環境で確認済み |
| baseline | 既存watch集合が不変、今回watch/subject/version、再起動後の状態 | 2026-10-15 owner承認環境で確認済み |
| HTTPS test | 署名付きtest結果、HTTP200、通常inbox増加0 | 2026-10-15 owner承認環境で確認済み |
| 通常配送 | 同eventのsender成功、Pull前のinbox ID、再起動後の保持 | 未観測 |
| Pull | `eventCount`/`inserted`/`ignoredCount`/`hasMore`/`gap`、前後inbox件数、checkpoint digest | 空page 1回: 0/0/0/false/false、inbox前後0、digest同一。cursor前進の証拠ではない |
| 欠落補完 | Webhookで未受信だった実eventがPullで追加された証拠 | 未検証 |
| 410回復 | 自然発生410、復旧前後時刻、baselineとcheckpointのatomic確定 | 未発生・未検証 |
| watch/endpoint cleanup | 新watchのDELETE応答、endpoint pause/delete、既存watchが不変 | 完了。今回watchはHTTP 200でstopped、endpointはpause後に削除、既存active+stoppedの2 watchは不変 |
| Railway cleanup | 元のservice設定復元、volume削除、稼働/費用確認 | receiver停止済み。設定復元・volume削除はRailwayの本人認証待ち |

証拠はJST/UTC・検証HEAD・Node版・コマンド（秘密値なし）・終了コード・HTTP status・件数・ID/version・証拠digestに限定します。payload、署名、cursor、APIキー、secret、秘密の受信URLは含めません。

終了時は、今回新規作成したことが事前記録・201/ID・owner確認で確定したwatchだけ停止し、endpointをpause/削除します。停止済み/既存/所有不明の資産は変更しません。APIキーの失効、署名鍵削除、volume削除はそれぞれownerが証拠保存と利用終了を確認した後の承認範囲だけです。サービスを検証前のsource/start/health/restart設定と稼働状態へ戻し、誤って旧smokeを再開しません。保存volumeは停止だけでは課金が止まるとは限らないため、保持期限と削除承認を実行票へ残します。
