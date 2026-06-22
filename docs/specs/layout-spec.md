# Git Braid — Commit Graph Layout 演算法規格

> 版本：v0.1
> 對應：專案規劃書 §4（本檔為其抽出與展開）
> 實作目標檔：`crates/core/src/layout.rs`
> 性質：純函式規格。`layout(ordered_commits, boundary_state?) → (rows, next_boundary_state)`

---

## 1. 目的與範圍

把一串「已排序的 commit（含 parent 關係）」轉換成可渲染的 graph 幾何：替每個 commit 指定一個 **lane（欄）** 與 **color**，並產出每個 row 下方 gap 的 **線段（segments）**。輸出餵給二進位協定 → Canvas 虛擬化渲染。

### 範圍內
- Lane 配置、顏色配置、線段產生。
- 增量載入時的邊界續傳狀態。
- 決定論與 append-only 穩定性保證。

### 範圍外（由其他模組處理）
- Commit 的取得與排序（§4.3，本規格的輸入前提）。
- Ref（branch / tag / HEAD）標籤——那是附加在節點上的裝飾，不影響 lane 幾何，由獨立的 decoration pass 處理。
- 像素座標、列高、配色 hex——渲染層的事。本規格只給 lane index 與 color id。

---

## 2. 名詞與符號

| 名詞 | 定義 |
| --- | --- |
| **row** | 一個 commit 佔一列；row 0 為輸入序列第一個（最新）。 |
| **lane** | 欄索引（u16），0 為最左。 |
| **active lane** | 一條正在向下延伸、等待某個 commit 出現的線。以它「等待的 OID」標識。 |
| **gap(i, i+1)** | row i 與 row i+1 之間的垂直區間；線段歸屬於 gap。 |
| **incoming** | 在某 commit 的 row，所有 `waiting_for == 該 commit oid` 的 active lane（即它的子節點連進來的線）。 |
| **tip** | 沒有任何 active lane 等待的 commit（在已載入範圍內無子節點）。 |
| **converge** | 多條 lane 等待同一 commit 時，於該 commit 的 row 收斂到最左 lane，其餘終止。 |
| **merge-out** | merge commit 的非第一 parent 分岔出新 lane（向右）。 |
| **continuation token / boundary state** | 視窗底部的延續狀態，使增量載入可從邊界續算。 |

---

## 3. 輸入契約

```
Input:
  commits: &[CommitIn]      // 已依排序政策排好，最新在前
  boundary: Option<BoundaryState>   // 增量載入時，前一視窗的底部狀態

CommitIn {
  oid: Oid                  // 20/32 bytes，唯一
  parents: SmallVec<[Oid; 2]>   // 0 = root，1 = 一般，2 = merge，3+ = octopus
}
```

前提（呼叫端保證，本規格不驗證）：
- `commits` 已是有效的拓撲序——**任一 commit 的 parent 不早於它自己出現**（parent 在序列中位於其後，或不在視窗內）。排序政策見 §4.3（topo-order / date-order）。
- 同一 OID 不重複出現。

---

## 4. 輸出契約（資料模型）

```
Output:
  rows: Vec<RowLayout>
  next_boundary: BoundaryState

RowLayout {
  oid:      Oid
  lane:     u16          // 節點所在欄
  color:    ColorId      // 節點 / 其分支線的顏色
  segments: SmallVec<[Segment; 4]>   // 此 row 下方 gap 的線段
  flags:    RowFlags     // is_merge / is_root / parent_offscreen / is_tip …
}

Segment {
  from_lane: u16         // 在 gap 頂端（本 row 這側）的欄
  to_lane:   u16         // 在 gap 底端（下一 row 這側）的欄
  color:     ColorId
  kind:      SegKind     // Straight | MergeOut | ConvergeIn
}

SegKind 語意：
  Straight   from == to，垂直線。
  MergeOut   from = 該 merge commit 的 lane，to = 新分岔出的 lane（向右）。
  ConvergeIn from = 終止的 lane，to = 收斂目標 lane（通常向左），落在 parent 的 row。
```

`color` 在 `Segment` 與 `RowLayout` 都是 `ColorId`（調色盤索引），不是 hex。調色盤由渲染層持有。

---

## 5. 不變式（Invariants）

實作與測試都以這些為準：

1. **每個 parent 邊都連通**：對視窗內每個 commit 的每個 parent，若該 parent 也在視窗內，則存在一條由 lane 線段組成、從 commit 連到 parent 的連續路徑；若 parent 在視窗外，則該線在底部邊界保持 active（`parent_offscreen`）。
2. **Lane 不中途換位（no mid-life shift）**：一條 active lane 從建立到終止，lane index 不變。唯一的對角線只發生在「建立（merge-out）」與「終止（converge-in）」兩個時點。**不做 compaction 造成的位移**，以換取穩定與可預期。
3. **寬度有界**：任一 row 的最大 lane index < 同時並存的 active 分支數上限。實務上由 repo 的並行分支數決定，與總 commit 數無關。
4. **決定論**：`layout` 是純函式。相同 `(commits, boundary)` 必產生逐 byte 相同的 `rows` 與 `next_boundary`。顏色、lane、線段皆不得依賴 hash 迭代序、時間、或任何外部狀態。
5. **Append-only 穩定性（關鍵）**：以序列前 N 筆算出的前 N 個 `RowLayout`，必須與「前 N+k 筆算出的前 N 個」**完全相同**。因為演算法單向 top-down、不回溯；新增只會在底部邊界延續，不改動上方。這是虛擬化與增量載入正確性的基礎。
6. **第一 parent 直行**：commit 的 lane 延續給其第一 parent（首親鏈在同一欄垂直向下），除非該 commit 為 root。

---

## 6. 核心演算法（單趟）

狀態：
```
lanes:  Vec<Option<LaneEntry>>     // index = lane，None = 空欄
LaneEntry { waiting_for: Oid, color: ColorId }

waiting_index: HashMap<Oid, SmallVec<[u16; 2]>>   // oid → 等待它的 lane 們（O(1) incoming 查詢）
next_color: u32                    // 顏色配發計數器
pending_mergeouts: SmallVec<...>   // 上一 row 產生、待併入其下方 gap 的 merge-out 線段
```

主迴圈（對每個 commit C，row index = i）：

```
1. incoming = waiting_index.get(C.oid)            // 等待 C 的所有 lane
2. 決定 commit_lane 與 color：
     if incoming 非空:
         commit_lane = min(incoming)               // 最左收斂
         color       = lanes[commit_lane].color
     else:                                          // tip
         commit_lane = 最左空欄（無則 push）
         color       = palette_alloc()              // 見 §8
3. 產生本 row 下方 gap 的 segments（見 §7 線段產生）。
4. 處理 parents：
     設 P = C.parents
     if P 為空: lanes[commit_lane] = None           // root，lane 終止
     else:
         // 第一 parent：commit_lane 延續
         lanes[commit_lane] = LaneEntry{ P[0], color }
         更新 waiting_index：移除舊的 C 條目，加入 P[0]→commit_lane
         // 其餘 parent：合併去重，否則開新 lane
         for Pk in P[1..]:
             if 已有 lane 等待 Pk:
                 target = 該 lane
                 記錄 MergeOut(commit_lane → target, color=該 lane.color) 到 pending_mergeouts
             else:
                 new_lane = 最左空欄（無則 push）
                 c = palette_alloc()
                 lanes[new_lane] = LaneEntry{ Pk, c }
                 waiting_index 加入 Pk→new_lane
                 記錄 MergeOut(commit_lane → new_lane, color=c) 到 pending_mergeouts
5. 收尾：把 incoming 中非 commit_lane 的 lane 標記終止（converge 已於步驟 3 產生其 ConvergeIn），並從 lanes / waiting_index 清除。
6. 輸出 RowLayout{ C.oid, commit_lane, color, segments, flags }。
```

迴圈結束後，`next_boundary` = 當前 `lanes` / `waiting_index` / `next_color` 的快照（見 §11）。

---

## 7. 線段產生（一個 gap 的組成）

一個 `gap(i-1, i)` 的線段在「處理 row i（底列）」時最終確定，由兩部分組成：

A. **上列遺留的 merge-out**：`pending_mergeouts`（row i-1 產生）併入。  
B. **本列計算的 straight / converge-in**：對處理 row i 之前的每條 active lane `j`：
   - 若 `j` ∈ incoming 且 `j == commit_lane`：該線進入節點 → `Straight(j→j)`，以 lane 色。
   - 若 `j` ∈ incoming 且 `j != commit_lane`：終止 → `ConvergeIn(j → commit_lane)`，以 **lane j 自身的色**（顯示這條線從哪來）。
   - 若 `j` ∉ incoming：旁路通過 → `Straight(j→j)`，以 lane 色。

實作上保留一個單列回看的 `pending_mergeouts` 緩衝即可，O(1) lookback，維持 append-only。

> 色彩約定：收斂時**存活 lane（最左）保留自己的色**，節點色 = 該色；終止 lane 的 ConvergeIn 段用終止 lane 的色。

---

## 8. 顏色配置（`palette_alloc`）

需求：決定論、可重現、相鄰 lane 盡量不同色。

**主規則（必須）**：維護 `next_color`，每次配發新 lane（tip 或新 merge lane）時取 `ColorId = next_color % PALETTE_SIZE`，然後 `next_color += 1`。給定輸入序列，配發順序固定 → 決定論成立。

**相鄰避色（建議，可選）**：若主規則選出的色與「當前相鄰 active lane（commit_lane ± 1）」同色，往後跳到下一個不衝突的色再配發。此精修仍是純函式（只依賴當前 lanes 狀態），不破壞決定論與 append-only。是否啟用列為可調參數（§13）。

> 不採用「lane index mod N」——它讓重用同一 lane 的不同分支永遠同色，且整張圖配色隨 lane 位置僵化。以分支建立序配色，視覺較自然。

---

## 9. 逐步範例

DAG（最新在前；箭頭為 parent）：

```
F → {E, C}     (merge：第一親 E，第二親 C)
E → {D}
D → {B}
C → {B}
B → {A}
A → {}         (root)
```

逐列追蹤（`cN` = 第 N 個配發的色）：

| row | commit | lane | color | 下方 gap 的 segments |
| --- | --- | --- | --- | --- |
| 0 | F | 0 | c0 | `Straight 0→0 c0`；`MergeOut 0→1 c1` |
| 1 | E | 0 | c0 | `Straight 0→0 c0`；`Straight 1→1 c1` |
| 2 | D | 0 | c0 | `Straight 0→0 c0`；`Straight 1→1 c1` |
| 3 | C | 1 | c1 | `Straight 0→0 c0`；`ConvergeIn 1→0 c1` |
| 4 | B | 0 | c0 | `Straight 0→0 c0` |
| 5 | A | 0 | c0 | —（root，lane 終止） |

對應的圖（直覺）：

```
row0  ●  F        col0；E、C 的 merge
      |\
row1  ● |  E      col0 主線；col1 側線下行
      | |
row2  ● |  D      col0
      | |
row3  | ●  C      節點落在 col1
      |/
row4  ●  B        col0；側線在此收斂回主線
      |
row5  ●  A        col0（root）
```

讀法：F 在 gap0 向右分岔出側線（第二親 C），側線沿 col1 經過 E、D，於 row3 抵達節點 C；C 的 parent 是 B，於 gap3 對角收斂回 col0 的 B。主線 F-E-D-B-A 全程直行 col0。這正是「一條從 B 分出、被 F 合併回來的 feature branch」的標準畫面。

---

## 10. 邊界案例

| 案例 | 處理 |
| --- | --- |
| **root**（0 parent） | commit_lane 設 None，lane 終止。 |
| **多 root** | 各自為獨立 tip，各開新 lane。 |
| **merge**（2 parent） | 第一親直行，第二親 merge-out 開新 lane。 |
| **octopus**（3+ parent） | 第一親直行，其餘每個各開一條 merge lane（或併入既有等待同 OID 的 lane）。 |
| **多子節點收斂** | 多條 lane 等待同一 OID，於該 row 收斂到最左，其餘 ConvergeIn 終止。 |
| **共享 parent / 交叉** | 不特例化：第一親照常延續本 lane，於 parent row 自然收斂；額外親若已有 lane 等待同 OID 則去重併入。 |
| **parent 在視窗外**（分頁） | 該 lane 在底部邊界維持 active，row 標 `parent_offscreen`；下批載入時由邊界續傳重新接上（§11）。 |
| **孤兒 / 斷裂分支** | 視為 tip；其 parent 不在視窗則於底部保持 active 或自然在 root 終止。 |
| **uncommitted changes** | 由呼叫端插入一個合成節點於 HEAD 之上，parent = HEAD；走一般流程。`flags` 標記。 |
| **stash** | stash 是帶特殊 parent 的 commit（base + index/untracked）；以一般 commit 處理其 parent 邊；`flags` 標記。 |
| **HEAD / detached HEAD** | 不影響 lane；屬 ref 裝飾，範圍外。 |
| **first-parent-only 模式** | 略過所有 `P[1..]`，不產生 merge lane。 |
| **空 repo**（0 commit） | 輸出空 `rows`，`next_boundary` 為初始空狀態。 |

---

## 11. 增量載入與邊界續傳狀態

虛擬化與分頁仰賴：**算完一個視窗後，能從底部精確續算下一批，且不重算、不改動已輸出的列。**

```
BoundaryState {
  lanes:       Vec<Option<LaneEntry>>   // 視窗最後一列之後的 lane 配置
  next_color:  u32
  // waiting_index 可由 lanes 重建，不必序列化
}
```

- 首次呼叫：`boundary = None` → 初始空狀態。
- 後續批次：傳入上一批回傳的 `next_boundary`，演算法以它為起始 `lanes` / `next_color` 繼續。所有在邊界保持 active（`parent_offscreen`）的 lane，會在新批次中遇到其等待的 commit 時自然收斂——接點與顏色與「一次算完整段」完全一致（由不變式 4、5 保證）。

此 `BoundaryState` 即是規劃書 §3.5 二進位協定裡，host 在批次之間需保存的最小延續狀態。

---

## 12. 效能與資料結構

| 項目 | 設計 |
| --- | --- |
| 時間 | 單趟 O(n)。incoming 查詢用 `waiting_index`（HashMap）做到每 commit O(parents) 攤銷，避免掃描所有 lane 的 O(n·L)。 |
| 空間 | `lanes` + `waiting_index` = O(L)（L = 並行分支數），與 n 無關。輸出每列 segments 數 ≈ O(L)，但實務 L 小。 |
| 配置 | `RowLayout.segments` 用 `SmallVec`（多數列 ≤ 4 段，免堆配置）。 |
| 大 repo | 100k commit 在 Rust 單趟內可壓在效能目標（規劃書 §6）內；layout 不是瓶頸，瓶頸在 ODB 讀取與序列化。 |

---

## 13. 可調參數

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `MAX_LANES` | 軟上限（如 64） | 超過時的退化策略（如把過深的並行線收束）待定，見 §15。 |
| `merge_lane_placement` | 最左空欄 | 另選「commit_lane 右側第一個空欄」可讓 merge 一致向右流，視覺更可預期但較寬。 |
| `adjacent_color_avoidance` | on | §8 的相鄰避色精修。 |
| `first_parent_only` | off | 對應 git `--first-parent`。 |
| `compaction` | **off（鎖定）** | 維持不變式 2。若未來要做 compaction，須重新評估 append-only 穩定性。 |

---

## 14. 測試策略

**Golden tests（決定論 + 正確性）**：固定一組 DAG fixtures（含 §10 每個邊界案例）→ 比對逐 byte 的 `rows` 輸出。§9 範例即首個 golden case。

**Property tests（不變式）**，對隨機生成的合法 DAG：
1. **連通性**：每個視窗內 parent 邊都有連續 lane 路徑（不變式 1）。
2. **寬度有界**：max lane < 並行分支數上限（不變式 3）。
3. **Append 穩定性**：`layout(commits[..N])` 的前 N 列 == `layout(commits[..N+k])` 的前 N 列（不變式 5）。這條最重要——直接守住增量載入的正確性。
4. **續傳一致**：`layout(all)` == 串接 `layout(batch1)` 後以其 `next_boundary` 算 `layout(batch2)`（不變式 4、5）。

**對照測試（選用）**：與 `git log --graph` 的 ASCII 輸出做結構性對照（lane 數、收斂點），抓明顯偏差；不要求逐字相同（配色/位移策略不同）。

---

## 15. 待決定（Open decisions）

1. **MAX_LANES 退化策略**：超深並行時要不要收束、如何收束（影響不變式 2）。
2. **merge lane 方向**：最左空欄 vs 一律右側——影響視覺一致性與寬度，建議 M2 拿真實 repo A/B 決定。
3. **stash 的視覺位置**：純走一般流程，或給 stash 專屬靠邊 lane。
4. **octopus merge 的線段密度**：3+ 親時多條 merge-out 是否需要視覺去重或限制。

---

## 16. 與其他規格的介面

- **上游**：消費 §4.3 排序政策產出的 `CommitIn` 序列。排序改變 → layout 改變（決定論的前提，不是 bug）。
- **下游**：`RowLayout` 經 §3.5 二進位協定送至 webview；`BoundaryState` 由 host 在批次間保存。
- **平行**：ref（branch/tag/HEAD）裝飾是獨立 pass，吃 `RowLayout` 的節點位置，往上貼標籤，不回饋影響 lane。

---

*本規格為 v0.1，預期隨 M1 實作與 §15 的 A/B 決策迭代。*
