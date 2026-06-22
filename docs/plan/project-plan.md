# Git Braid 專案規劃書

> 專案名稱：**Git Braid**（Git Graph 的 clean-room 重新實作）
> 命名狀態：git/vscode 領域初步查無同名工具；定案前仍需在 Marketplace、`npm view`、GitHub 各做一次權威確認。npm 套件名暫定 `git-braid`。
> 版本：v0.1（初版規劃）
> 性質：Clean-room 重新實作，**非** fork

---

## 0. 一頁摘要（TL;DR）

做一個 VS Code 的 Git 視覺化套件，核心賣點是**大型 repo 也能順**與**AI 輔助理解歷史**——這兩點是原版 Git Graph、VS Code 內建版、GitLens 都沒有同時做好的空白。

- **不 fork**：原專案無開源授權，著作權全保留，只能參考其 UI 概念與功能行為做乾淨重寫。
- **效能戰場**：原版把整個 commit history 載入 webview，數千 commit 即卡。用 Rust 核心 + Canvas 虛擬化渲染解決。
- **差異化戰場**：AI（語意搜尋、PR/release notes 生成、衝突脈絡摘要），目前無人做。
- **MVP 先行**：第一階段只證明「一萬 commit 滑動順」這一件事，兩週內可驗證。做不出來就只賠兩週。

---

## 1. 專案定位

### 1.1 問題陳述

VS Code 生態目前的 Git 視覺化選項各有缺口：

| 選項 | 優點 | 缺口 |
| --- | --- | --- |
| 原版 Git Graph (mhutchie) | UI 直覺、操作完整 | 已停更約 5 年、無開源授權、大 repo 卡頓 |
| VS Code 內建 (1.93+) | 官方、免安裝 | 功能陽春、無豐富操作、無 AI |
| GitLens (GitKraken) | 編輯器深度整合、大 repo 順 | 功能龐大笨重、graph 只是其一環、商業化 |

空白點：**一個專注於 graph、效能優先、且帶 AI 輔助的輕量套件**。

### 1.2 目標（Goals）

1. 在萬級～十萬級 commit 的 repo 上維持流暢的載入與滑動。
2. 提供原版核心操作（checkout / merge / rebase / cherry-pick / tag / stash 等）的等價功能。
3. 引入 AI 輔助：語意搜尋、歷史摘要、PR/release notes 生成、衝突脈絡解釋。
4. 乾淨的開源授權（MIT 或 Apache-2.0），可長期社群維護。

### 1.3 非目標（Non-Goals）— 嚴格守住

> 這一節是給「容易做到一半失去動力」的自己看的。範圍蔓延是這個專案最大的死因。

- **不**做 GitLens 那種編輯器內 inline blame 全套整合（至少 v1 不做）。
- **不**做自己的 diff viewer——直接用 VS Code 內建 diff。
- **不**做 GUI 衝突解決編輯器——交給 VS Code / git。
- **不**在 MVP 階段做任何 git 寫入操作（純讀、純渲染）。
- **不**支援非 Git 版本控制。

### 1.4 成功標準

- **技術**：10k commit repo 首次繪製 < 500ms；滑動穩定 60fps；記憶體不隨 repo 大小線性膨脹。
- **產品**：MVP 能在 demo 中明顯比原版 / 內建版滑得順。
- **個人**：完成一個橫跨 Rust 核心、解析器、前端渲染、AI 整合的完整作品集專案。

---

## 2. 法律與授權策略

### 2.1 為什麼不能 fork

原專案 LICENSE 非標準開源授權。在著作權法下，未附開源授權 = 保留所有權利：他人可瀏覽、可在 GitHub 按 fork，但**不得在自己專案中使用、修改或散布**其原始碼。社群（issue #804 / #838）的共識即是「只能重新實作，不能 fork」。

### 2.2 Clean-room 原則

| 可以做 | 不可以做 |
| --- | --- |
| 參考其 UI 佈局、互動概念、功能清單（idea / behaviour 不受著作權保護） | 複製、改寫其原始碼 |
| 觀察其外部行為後自行實作 | 直接搬用其檔案結構與函式 |
| 看公開的 git 文件、graph 演算法論文 | 看它的 source 然後「照著打一遍」 |

實作上：先寫一份「功能行為規格」（看 README + 實際操作觀察），再依規格獨立開發，過程不開啟原 repo 的 src。保留開發紀錄（commit log 本身就是證據鏈）。

### 2.3 自身授權與命名

- **授權**：建議 MIT（最寬鬆、生態友善）或 Apache-2.0（含專利條款，較保險）。
- **命名**：定為 **Git Braid**（隱喻 braided river——河道分流又匯流，對應 git 的 branch / merge，也呼應多 lane 的圖形外觀）。不可使用「Git Graph」（避免混淆 / 商標疑慮）。發布者 ID 用個人 handle，extension ID 形如 `<handle>.git-braid`。定案前仍需查 Marketplace、`npm view git-braid`、GitHub repo 名與「電腦軟體」類別商標。
- 若未來考慮商業化（付費 AI 功能等），務必先諮詢律師確認 clean-room 流程乾淨。

> 我不是律師，2.x 節僅為一般原則，嚴肅商業化前請取得專業意見。

---

## 3. 技術架構

### 3.1 整體分層

```
┌─────────────────────────────────────────────────────────┐
│  Webview (前端 / 渲染層)                                   │
│  - Canvas / WebGL 虛擬化渲染                               │
│  - 互動：滑動、選取、右鍵選單、Find                          │
│  - 接收二進位 commit 批次，直接餵給 renderer                  │
└──────────────────▲───────────────────┬──────────────────┘
                   │  binary message    │  user actions
┌──────────────────┴───────────────────▼──────────────────┐
│  Extension Host (Node / TypeScript)                       │
│  - 生命週期、指令註冊、設定、狀態                            │
│  - 呼叫 Rust 核心取得 log + layout                          │
│  - git 寫入操作（shell out git CLI）                        │
│  - AI 協調層                                               │
└──────────────────▲───────────────────┬──────────────────┘
                   │  napi-rs (FFI)     │  child_process
┌──────────────────┴────────┐   ┌──────▼──────────────────┐
│  Rust 核心 (native addon)   │   │  git CLI (寫入操作)       │
│  - gitoxide 讀 ODB          │   │  checkout/merge/rebase…  │
│  - log walk + 拓撲排序        │   └──────────────────────────┘
│  - graph layout 計算         │
│  - 二進位序列化               │
└────────────────────────────┘
```

### 3.2 讀寫分離（關鍵設計決策）

效能瓶頸只在「讀 + layout」這條熱路徑，而 git 寫入操作（checkout、merge…）不是效能敏感、但正確性敏感。因此：

- **讀路徑（熱）**：Rust + gitoxide，自己讀 `.git` ODB，不 spawn 子行程。
- **寫路徑（冷）**：直接 shell out `git` CLI。理由：git 操作的邊角案例（hooks、submodule、設定）極多，自己用 library 重做容易出錯且收益低；交給官方 git 最穩。

### 3.3 為什麼選 gitoxide 而非 git2-rs（libgit2）

| 維度 | gitoxide (gix) | git2-rs (libgit2 bindings) |
| --- | --- | --- |
| 語言 | 純 Rust | C library 綁定 |
| 編譯 | 單純，可同時打包 native 與 WASM | 需處理 C 依賴 |
| log walk 效能 | 設計上對遍歷高度最佳化 | 成熟但 C FFI 邊界開銷 |
| 成熟度（讀） | 讀路徑非常完整 | 完整 |
| 成熟度（寫） | 寫操作仍在發展 | 完整 |

因為我們**只用它讀**（寫交給 git CLI），gitoxide 的寫成熟度不是問題，而它「純 Rust 可同時 native + WASM」對未來保留彈性很有價值。

### 3.4 napi-rs vs WASM 的取捨

| | napi-rs（native addon） | WASM |
| --- | --- | --- |
| 跑在哪 | Extension Host (Node) | Host 或 Webview 皆可 |
| 檔案系統 / ODB 直讀 | 直接（最快） | 需把資料餵進去，較麻煩 |
| 打包 | 需各平台 prebuild（win / mac-x64 / mac-arm64 / linux） | 單一 binary，跨平台 |
| 效能 | 最高 | 高，略遜 |

**決策**：v1 用 **napi-rs**（host 端 native addon），因為要直讀 `.git` 且追求最高效能；用 GitHub Actions 做各平台 prebuild。保留未來把 layout 計算搬進 webview WASM 的可能性（gitoxide 純 Rust 讓這條路開著）。

> 注意你的 Mac 是 arm64 native 環境——prebuild matrix 記得同時涵蓋 darwin-x64 與 darwin-arm64。

### 3.5 通訊協定（Host ↔ Webview）

原版卡頓的一大來源是用 JSON 傳整包 commit。改為：

- **分頁 + 增量**：初次只送可視範圍 + buffer，捲動時再要下一批。
- **二進位**：用扁平 typed-array 佈局，欄位定長（hash、parent index、lane、color index、timestamp…），webview 端零解析直接餵給 Canvas renderer，避免逐物件 JSON 反序列化與 GC 壓力。
- 字串池（author、message）另開 table，commit row 只存 index。

---

## 4. 核心資料模型與契約（System Contracts）

> 沿用你 SCOUT 的「System Contracts」習慣，把跨層的不變式先釘死。

### 4.1 Commit 正規化模型（Rust 端輸出）

```
CommitRow (定長, 餵給 renderer):
  oid_index      u32   // 指向 oid table
  parents        [u32; N]  // 指向 commit index，N 上限 ( merge 多親 )
  lane           u16   // 所在欄
  color_index    u8
  author_index   u32   // 指向字串池
  commit_time    i64   // unix epoch
  flags          u8    // is_merge / is_head_ancestor / has_stash …
```

### 4.2 Graph Layout 演算法契約

- **輸入**：拓撲 + 時間排序後的 commit 序列。
- **輸出**：每個 commit 的 `lane`、`color`、以及進出邊（edges）。
- **不變式**：
  - 同一條分支的 commit 盡量維持同一 lane。
  - 合併 / 分岔時 lane 的分配需穩定（避免重繪時整張圖跳動）。
  - 顏色分配可重現（相同輸入產生相同配色）。
- 演算法核心：逐 commit 處理，維護 active lanes 集合；遇到有子節點時佔用 lane，分岔則開新 lane，合併則收回 lane。此計算放 Rust 跑（CPU-bound）。

### 4.3 排序政策

- 預設 commit 順序對齊 `git log` 的 `--topo-order` / `--date-order`，設定可切換。
- 時間統一 unix epoch（i64），時區顯示在前端處理。

### 4.4 邊界與時間

- 空 repo、初始 commit（無 parent）、孤兒分支、淺 clone（shallow）皆需明確定義行為。
- detached HEAD、worktree 多工作目錄需在模型層先有表示。

---

## 5. 功能範圍與分期

### Phase 0 — MVP「只證明一件事：大 repo 也順」（目標 1～2 週）

僅含：
- Rust 核心：gitoxide 讀 log + 拓撲排序 + layout 計算。
- napi-rs 綁定，host 取得二進位批次。
- Webview：Canvas 虛擬化渲染 commit graph（節點 + 線 + 基本欄位）。
- **無**任何 git 操作、**無** AI、**無**設定。

驗收：拿 10k commit 的 repo，跟原版 + 內建版比首繪時間與滑動流暢度，錄成 demo。

### Phase 1 — 核心可用（graph + 讀操作）

- 點 commit 看 detail / file changes，接 VS Code 內建 diff。
- 分支 / tag / stash refs 顯示與 hover tooltip。
- Find（先做字串比對版）。
- 多 repo / workspace 偵測。
- 基本設定（顯示欄位、配色、初始載入數量）。

### Phase 2 — 寫操作（接 git CLI）

- checkout / create / delete / merge / rebase / cherry-pick / revert / reset。
- tag 增刪、stash apply/pop/drop。
- 右鍵選單系統。
- 所有寫操作走 git CLI，並把 stderr 友善呈現。

### Phase 3 — AI 差異化（核心賣點）

- 語意化 commit 搜尋（embedding）。
- 選取 commit range → 生成 PR 描述 / release notes。
- merge / 衝突 commit 的脈絡摘要。
- commit message 品質建議。

### Phase 4+ — 進階

- 互動式 rebase 拖拉 UI。
- multi-worktree、monorepo 強化。
- inline blame（補編輯器整合）。

---

## 6. 效能目標與基準方法

### 6.1 量化目標

| 指標 | 目標 | repo 規模 |
| --- | --- | --- |
| 首次繪製 (first paint) | < 500ms | 10k commits |
| 捲動 frame rate | 穩定 60fps | 10k～100k |
| 載入更多批次延遲 | < 100ms | 任意 |
| 記憶體 | 有界（windowed，不隨總量線性成長） | 100k |
| 仍可導航 | 是 | 100k commits |

### 6.2 基準方法

- 準備測試 repo 集：1k / 10k / 100k commits（可用 script 合成，或用 linux kernel、chromium 等大 repo）。
- 自動化 benchmark：量首繪、捲動 fps、記憶體峰值。
- 每次效能相關 PR 跑 benchmark 防回歸（對應你 cliagent 裡 gating 的習慣，可把效能門檻做成 CI gate）。
- 三方對照：本專案 vs 原版 vs VS Code 內建。

---

## 7. AI 整合設計

### 7.1 模型接取策略

- **優先**用 VS Code Language Model API（`vscode.lm`），讓使用者用自己已有的訂閱，套件不需管理金鑰。
- **備援**支援 BYO API key（Anthropic 等），給沒有 LM API 的使用者。
- 抽象一層 `AIProvider` 介面，底層可換（你做 cliagent 的 provider 抽象經驗可直接套）。

### 7.2 功能與設計

| 功能 | 輸入 | 設計重點 |
| --- | --- | --- |
| 語意 commit 搜尋 | 查詢字串 | embedding 比對；embedding 來源：本地小模型或 API；需快取與增量更新 |
| PR 描述 / release notes | 選取的 commit range | 把 commit message + diff stat 餵模型，產生結構化輸出 |
| 衝突 / merge 脈絡摘要 | merge commit | 摘要兩邊改了什麼、為何衝突 |
| commit message 建議 | 暫存區 diff | 產生符合 conventional commits 的訊息 |

### 7.3 隱私（必須明確）

- commit 內容常含專有程式碼。**所有 AI 功能預設 opt-in**。
- 啟用時清楚告知「什麼資料會送出、送去哪」。
- 提供「只送 metadata 不送 diff」的等級選項。
- 本地 embedding 選項給高敏感環境。

---

## 8. 開發路線圖與里程碑

| 里程碑 | 內容 | 產出 | 概估 |
| --- | --- | --- | --- |
| M0 | 環境 + Rust 核心讀 log | 能在 CLI 印出排序後 commit | 3–5 天 |
| M1 | layout 演算法 + napi 綁定 | host 拿到 layout 結果 | 1 週 |
| M2 | Canvas 虛擬化渲染 | **MVP demo（Phase 0 驗收）** | 3–5 天 |
| M3 | detail / diff / refs / find | Phase 1 可用 | 2–3 週 |
| M4 | 寫操作 + 右鍵選單 | Phase 2 | 3–4 週 |
| M5 | AI 第一個功能（建議從 release notes 生成切入，最具體） | Phase 3 起步 | 2 週 |
| M6 | 上架 Marketplace（先 preview） | 公開版本 | — |

> 心法：M2（MVP demo）是 go/no-go 關卡。demo 不漂亮就停損，別硬推到 M4。

---

## 9. 風險與緩解

| 風險 | 影響 | 緩解 |
| --- | --- | --- |
| 範圍蔓延（最大死因） | 做不完、失去動力 | 嚴守 §1.3 非目標；M2 設停損點 |
| napi 各平台打包複雜 | 發佈卡關 | 早在 M1 就把 CI prebuild matrix 跑通，別拖到最後 |
| gitoxide 某些讀路徑不足 | 功能缺口 | 缺的部分 fallback 到 git CLI |
| 官方內建版持續強化 | 差異化被吃掉 | 把賭注壓在 AI 與效能，不跟官方拼基本功能 |
| 授權 clean-room 爭議 | 法律風險 | 保留開發紀錄；不開原 repo src；商業化前諮詢 |
| AI 隱私疑慮 | 使用者不敢用 | 預設 opt-in + 透明告知 + 本地選項 |

---

## 10. 技術選型總表

| 層 | 選型 |
| --- | --- |
| Rust 核心 | Rust + gitoxide (gix) |
| FFI | napi-rs（native addon），未來保留 WASM |
| 寫操作 | git CLI（child_process） |
| Extension | TypeScript + VS Code Extension API |
| 渲染 | Canvas 2D（v1），WebGL（超大規模時升級） |
| 序列化 | 自訂二進位 / MessagePack |
| AI | vscode.lm 優先 + BYO key 備援 |
| 測試 | Rust: cargo test；TS: Jest / Vitest；效能 benchmark CI gate |
| CI | GitHub Actions（多平台 prebuild + benchmark） |

---

## 11. 建議 Repo 結構

```
git-braid/
├── crates/
│   └── core/                 # Rust 核心：讀 log + layout
│       ├── src/
│       │   ├── walk.rs        # gitoxide log walk + 拓撲排序
│       │   ├── layout.rs      # graph lane / color 演算法
│       │   ├── serialize.rs   # 二進位輸出
│       │   └── lib.rs
│       └── Cargo.toml
├── bindings/
│   └── napi/                 # napi-rs 綁定 + prebuild 設定
├── src/                      # Extension Host (TypeScript)
│   ├── extension.ts
│   ├── gitActions.ts         # 寫操作 (git CLI)
│   ├── ai/                   # AIProvider 抽象 + 各功能
│   └── webviewBridge.ts      # 通訊協定
├── web/                      # Webview 前端
│   ├── renderer/             # Canvas 虛擬化渲染
│   └── ui/                   # 互動、選單、find
├── tests/
├── benchmarks/               # 效能基準 + 三方對照
└── package.json
```

---

## 12. 下一步

1. 對 **Git Braid** 做最後權威可用性確認（Marketplace 發布者/名稱、`npm view git-braid`、GitHub repo 名、商標），確認後即註冊 publisher 與占位 repo。
2. 撰寫「功能行為規格」（clean-room 基礎），列出要對齊原版的可觀察行為。
3. 動手 M0：Rust 核心讀 log + 排序，先在 CLI 印出來。
4.（可選）把 §4 的 layout 演算法獨立寫成一份演算法規格再開工。

---

*本規劃為初版，預期隨 M0–M2 的實作回饋迭代。*
