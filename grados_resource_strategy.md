# GRaDOS MCP 折中改造建议

## 背景

当前 `grados` 是一个典型的 tool-only MCP server。它已经能够通过 MCP 正常启动，但在某些 Codex Desktop 对话运行时里，模型侧只拿到了 `resources` 相关探测接口，没有直接拿到 `tools/list` / `tools/call` 的桥。

这会带来两个实际问题：

1. Codex App 能连上 `grados`，但当前对话里的模型仍然不知道它能做什么。
2. 当模型只能调用 `resources/list` 时，`grados` 会返回 `Method not found`，表现得像“不可用”，而不是“在线但仅支持 tools”。

因此，给 `grados` 增加一层只读 `resources` 能力，是一个很有价值的折中方案：

- 不改变现有 `tools` 设计。
- 让只具备 resource 探测能力的客户端，至少能发现 `grados` 的能力边界。
- 让模型先读到状态、说明、缓存内容，再决定是否需要进一步的工具调用桥。

## 目标

这次改造的目标不是把 `tools` 全部替换成 `resources`，而是：

1. 让 Codex App 至少能知道 `grados` 是什么、能干什么。
2. 让客户端能区分：
   - `grados` 未启动
   - `grados` 已启动但仅暴露 tools
   - `grados` 已启动且存在可读资源
3. 让模型在没有 tool bridge 的情况下，仍可读取：
   - 服务状态
   - 配置摘要
   - 已缓存论文索引
   - 已解析全文结果
   - 最近失败记录

## 为什么不把核心动作都改成 resources

不建议把以下能力改造成资源主入口：

- `search_academic_papers`
- `extract_paper_full_text`
- `save_paper_to_zotero`

原因：

1. 它们本质上是动作，不是静态上下文。
2. 它们可能涉及长时间运行、网络访问、失败重试和副作用。
3. MCP 规范里，`tools` 才是模型主动调用外部能力的标准机制；`resources` 更适合只读内容暴露。

因此，更合理的方案是：

- 保留现有 `tools`
- 额外增加一层只读 `resources`

## 推荐新增的 resources

### 1. `grados://about`

用途：

- 给客户端和模型一个“自我介绍”入口。

建议内容：

- 服务名称与版本
- 核心能力列表
- 对应 tool 名称
- 当前工作目录
- 配置文件位置
- 重要目录位置（papers、pdfs、cache）
- 已启用的搜索源、抽取路线、解析器

这是最值得优先添加的资源，因为它能直接解决“Codex App 不知道 GRaDOS 能干什么”的问题。

### 2. `grados://status`

用途：

- 快速健康检查。

建议内容：

- server online / ready 状态
- 配置是否成功加载
- `papersDirectory`、`downloadDirectory` 是否存在
- API key 是否配置（只显示是否存在，不暴露明文）
- Zotero 是否配置
- Marker worker 是否可发现
- 最近一次初始化时间

### 3. `grados://config`

用途：

- 暴露“安全脱敏后的配置视图”。

建议内容：

- 搜索源启用状态
- 抽取策略顺序
- 解析器顺序
- 各目录路径
- `academicEtiquetteEmail`
- 脱敏后的 key 状态

不要直接返回完整密钥。

### 4. `grados://tools`

用途：

- 用资源的方式暴露已有 tools 的说明，帮助不具备 `tools/list` 的客户端理解能力边界。

建议内容：

- `search_academic_papers`
- `extract_paper_full_text`
- `save_paper_to_zotero`

每个 tool 包含：

- 名称
- 简要描述
- 参数说明
- 返回结果说明
- 常见失败原因

这不是替代 `tools/list`，而是为受限客户端提供只读的“能力清单”。

### 5. `grados://papers/index`

用途：

- 列出已解析输出的 Markdown 论文。

建议内容：

- DOI
- 标题
- 来源方式（TDM/OA/Sci-Hub/Headless）
- 抽取时间
- Markdown 文件路径
- PDF 是否存在

### 6. `grados://paper/<safe_doi>`

用途：

- 读取某篇已缓存论文的摘要信息或全文摘要。

建议内容：

- DOI
- 标题
- 本地文件路径
- 提取来源
- 章节列表
- 正文预览
- 若合适，可嵌入对应 Markdown 文本

### 7. `grados://failures`

用途：

- 记录和暴露最近的抽取失败案例。

建议内容：

- DOI
- 标题
- 失败阶段
- 错误摘要
- 时间
- 建议重试路线

这对调试非常有帮助。

## 推荐新增的 resource templates

如果客户端支持资源模板，再进一步加：

- `grados://paper/{safe_doi}`
- `grados://doi/{doi}`
- `grados://query/{topic}`

但模板不是第一优先级。对很多客户端来说，固定资源比模板更容易被发现和使用。

## 实现优先级

### 第一阶段：低风险、高收益

优先新增：

- `grados://about`
- `grados://status`
- `grados://tools`

只要这三个资源存在，Codex App 就至少能知道：

- `grados` 在线
- `grados` 的定位
- `grados` 的 tool 名称和用途

### 第二阶段：增强可观测性

新增：

- `grados://config`
- `grados://papers/index`
- `grados://failures`

### 第三阶段：内容读取

新增：

- `grados://paper/<safe_doi>`
- 对应模板

## 对 Codex App 的实际改善

加完以上 resources 后，即使当前聊天运行时没有直接的 MCP tool bridge，模型仍然可以：

1. 发现 `grados` 已在线。
2. 读取 `grados` 的能力说明。
3. 读取 `grados` 当前配置和状态。
4. 查看已缓存和已解析的论文结果。

这至少可以避免当前这种情况：

- 服务已经连上
- 但模型因为只能探测 resources，而错误地把 `grados` 判断成“不可用”

## 对 skill.md 的关系

`skill.md` 适合告诉模型：

- 应该优先使用哪些 MCP
- 每个 MCP 的工具名是什么
- 推荐的调用流程是什么

但 `skill.md` 不能替代 MCP runtime 本身的能力暴露。

也就是说：

- `skill.md` 可以帮助模型“知道应该用 `grados`”
- `skill.md` 不能让一个没有 `tools/call` 桥的运行时突然具备 tool 调用能力

因此，最好的组合是：

1. `skill.md` 写清楚 `grados` 与 `mcp-local-rag` 的 tools 和分工
2. `grados` / `mcp-local-rag` 自身增加可读 resources
3. 客户端后续再完善 tool bridge

## 最终建议

推荐按以下顺序改 `grados`：

1. 先新增 `grados://about`、`grados://status`、`grados://tools`
2. 再新增 `grados://config`、`grados://papers/index`、`grados://failures`
3. 最后再考虑 `grados://paper/<safe_doi>` 与 resource templates

这样改动最小，但能明显提升 Codex App 对 `grados` 的可发现性、可解释性和可调试性。
