# 领域文档

工程技能在探索代码库时应如何使用本仓库的领域文档。

## 探索前请先阅读

- 仓库根目录下的 **`CONTEXT.md`**，或者
- 若存在仓库根目录下的 **`CONTEXT-MAP.md`**：它指向每个上下文对应的 `CONTEXT.md`。请阅读与主题相关的每个文件。
- **`docs/adr/`**：阅读涉及你即将开展工作区域的 ADR。在多上下文仓库中，还需检查 `src/<context>/docs/adr/` 以获取上下文范围内的决策。

如果这些文件都不存在，**请静默继续**。不要强调它们缺失；不要预先建议创建它们。`/domain-modeling` 技能（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 触发）会在术语或决策实际确定时按需延迟创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录下存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 特定上下文的决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表中的术语

当你的输出命名领域概念时（在 issue 标题、重构方案、假设、测试名称中），请使用 `CONTEXT.md` 中定义的术语。不要漂移到词汇表明确避免的同义词。

如果你需要的概念尚未收录在词汇表中，这是一个信号：要么你创造了项目未使用的语言（需要重新考虑），要么存在真实的缺口（记录下来供 `/domain-modeling` 处理）。

## 标出 ADR 冲突

如果你的输出与现有的 ADR 冲突，请明确指出而不是静默覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但值得重新讨论，因为……_
