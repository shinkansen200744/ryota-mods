# ryota-mods

Claude Code 用の mod（プラグイン）集です。

## usage-meter

5時間・週間の使用量とリセットまでの時間をゲージで表示するパネルです。ほかに、サブエージェントの一覧と、完了したときの通知も出します。

### 入れ方（1行）

ターミナルで次の1行を実行します（`<owner>` はこのリポジトリを置いた GitHub のユーザー名）。

```sh
claude plugin marketplace add <owner>/ryota-mods && claude plugin install usage-meter@ryota-mods
```

Claude Code の中で入れる場合は、次の2行です。

```
/plugin marketplace add <owner>/ryota-mods
/plugin install usage-meter@ryota-mods
```

入れたあと、Claude Code を開き直すか `/reload-plugins` を実行すると、パネルが出ます。

### 使い方

- `/usage-meter`（短縮は `/um`）：パネルを開きます。
- パネルを自分で閉じると、次に `/usage-meter` を実行するまで自動では開きません。
- `/reload-plugins` のあとは、自動でパネルを開き直します。
  - 端末の幅が狭くてすぐに置けないときは、次にプロンプトを送ったときに開きます。

### 更新

```sh
claude plugin marketplace update ryota-mods && claude plugin update usage-meter@ryota-mods
```
