# Issue 跟踪器：本地 Markdown

本仓库的 Issue 与规格说明作为 Markdown 文件存放在 `.scratch/` 中。

## 规范约定

- 每个特性一个目录：`.scratch/<feature-slug>/`
- 规格说明为 `.scratch/<feature-slug>/spec.md`
- 实现 issue 为每个 ticket 一个独立文件，路径为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，编号从 `01` 开始，绝不是单个合并的 tickets 文件
- 分流（Triage）状态记录在每个 issue 文件顶部的 `Status:` 行中（具体角色字符串见 `triage-labels.md`）
- 评论与对话历史追加在文件底部的 `## Comments` 标题下

## 当技能提示 "publish to the issue tracker" 时

在 `.scratch/<feature-slug>/` 下创建新文件（如有需要则创建目录）。

## 当技能提示 "fetch the relevant ticket" 时

读取引用路径下的文件。用户通常会直接传入路径或 issue 编号。

## 探路导航（Wayfinding）操作

供 `/wayfinder` 使用。**Map** 是一个文件，对应每个 ticket 有一个**子文件**。

- **Map**：`.scratch/<effort>/map.md`（包含 Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，并在正文中包含问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**：顶部附近的 `Blocked by: NN, NN` 行。当所列出的每个文件都为 `resolved` 时，该 ticket 解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/` 中处于 open、unblocked 且 unclaimed 的文件；按编号优先胜出。
- **Claim**：在开展任何工作前，设置 `Status: claimed` 并保存。
- **Resolve**：在 `## Answer` 标题下追加答案，设置 `Status: resolved`，然后在 `map.md` 的 Decisions-so-far 中追加上下文指针（要点 + 链接）。
