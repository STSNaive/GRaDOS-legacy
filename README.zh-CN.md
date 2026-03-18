# GRaDOS

[English](./README.md) | [简体中文](./README.zh-CN.md)

<div align="center">
  <pre style="display:inline-block; margin:0; font-family:'Bitstream Vera Sans Mono', 'SF Mono', Consolas, monospace; font-size:15px; line-height:1.02; font-weight:bold; white-space:pre; text-align:left;">&nbsp;&nbsp;.oooooo.&nbsp;&nbsp;&nbsp;&nbsp;ooooooooo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;oooooooooo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.oooooo.&nbsp;&nbsp;&nbsp;&nbsp;.oooooo..o
&nbsp;d8P'&nbsp;&nbsp;`Y8b&nbsp;&nbsp;&nbsp;`888&nbsp;&nbsp;&nbsp;`Y88.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`888'&nbsp;&nbsp;&nbsp;`Y8b&nbsp;&nbsp;&nbsp;d8P'&nbsp;&nbsp;`Y8b&nbsp;&nbsp;d8P'&nbsp;&nbsp;&nbsp;&nbsp;`Y8
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;.d88'&nbsp;&nbsp;.oooo.&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;Y88bo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888ooo88P'&nbsp;&nbsp;`P&nbsp;&nbsp;)88b&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;`"Y8888o.&nbsp;
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ooooo&nbsp;&nbsp;888`88b.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.oP"888&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`"Y88b
`88.&nbsp;&nbsp;&nbsp;&nbsp;.88'&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;`88b.&nbsp;&nbsp;d8(&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;d88'&nbsp;`88b&nbsp;&nbsp;&nbsp;&nbsp;d88'&nbsp;oo&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.d8P
&nbsp;`Y8bood8P'&nbsp;&nbsp;&nbsp;o888o&nbsp;&nbsp;o888o&nbsp;`Y888""8o&nbsp;o888bood8P'&nbsp;&nbsp;&nbsp;&nbsp;`Y8bood8P'&nbsp;&nbsp;8""88888P'&nbsp;</pre>
</div>

<p align="center">
  <strong style="font-size:1.75rem;">Graduate Research and Document Operating System</strong>
</p>

面向学术检索与全文提取的 MCP 服务器，适合 Codex、Claude 等 AI agent 使用。

GRaDOS 可以帮助 agent 检索学术数据库、按 DOI 走多级回退链路抓取全文、解析 PDF，并把结果保存到本地目录，方便后续复用、RAG 检索和文献整理。它尤其适合校园网或已有机构访问权限的环境，但即使不配置任何 API Key，也仍然可以使用 Crossref、PubMed、Unpaywall 和 Sci-Hub 等路径。

## 架构概览 🧭

GRaDOS 通常运行在一个 agent 工作流里：

1. 如果配合 `mcp-local-rag`，先查本地论文库
2. 按配置顺序检索远程学术数据源
3. 按 `TDM -> OA -> Sci-Hub -> Headless` 的顺序抓取全文
4. 按 `LlamaParse -> Marker -> Native` 的顺序解析 PDF
5. 对提取结果做 QA 校验后再返回
6. 将原始 PDF 保存到 `downloads/`，将解析后的 Markdown 保存到 `papers/`

**MCP 工具：**

| 服务 | 工具 | 说明 |
|---|---|---|
| GRaDOS | `search_academic_papers` | 按优先级串行搜索 Scopus、Web of Science、Springer、Crossref、PubMed，并按 DOI 去重 |
| GRaDOS | `extract_paper_full_text` | 按 4 级抓取策略 + 3 级解析策略提取全文，并做 QA 校验 |
| GRaDOS | `save_paper_to_zotero` | 通过 Zotero Web API 保存已引用论文的元数据 |
| mcp-local-rag | `query_documents` | 对本地已索引论文做语义检索和关键词检索 |
| mcp-local-rag | `ingest_file` | 把 Markdown 论文索引进本地 RAG 数据库 |
| mcp-local-rag | `list_files` | 查看已索引文件及状态 |

## 安装 🚀

### 方式 A：npm（推荐） 📦

```bash
npm install -g grados

# 在你希望作为运行目录的地方生成配置
grados --init

# 然后编辑 mcp-config.json
```

### 方式 B：源码安装 🛠️

```bash
git clone https://github.com/STSNaive/GRaDOS.git
cd GRaDOS
npm install
npm run build

cp mcp-config.example.json mcp-config.json
```

### 配置 MCP 客户端 🔌

**Claude Code：**

```bash
claude mcp add --transport stdio grados -- npx -y grados
```

**Codex：**

```bash
codex mcp add grados -- npx -y grados
```

如果你希望 GRaDOS 稳定读取某个固定的 `mcp-config.json`，下面这种带 `cwd` 的手动配置方式会更可靠。

也可以手动配置。

Claude Code（`.claude/settings.json`）：

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados"],
      "cwd": "/path/to/directory/containing/mcp-config.json"
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
cwd = "/path/to/directory/containing/mcp-config.json"
```

#### 提示：`cwd` 到底代表什么 💡

`cwd` 就是 GRaDOS 的运行工作目录。当前实现里它会被用来：

- 查找 `mcp-config.json`
- 解析 `./downloads`、`./papers` 这类相对输出目录
- 解析 `./scihub-mirrors.txt` 这类相对资源文件
- 在启用 Marker 时定位 `./marker-worker`

所以 `cwd` 不是 “npm 把包安装到了哪里”，而是 “GRaDOS 运行时把哪个目录当作项目根目录”。

如果你希望配置文件在一个目录里、论文保存在另一个目录里，是支持的。做法是让 `cwd` 指向配置/运行目录，再在 `mcp-config.json` 里把输出目录写成绝对路径：

```json
{
  "extract": {
    "downloadDirectory": "E:/academic-cache/downloads",
    "papersDirectory": "E:/academic-cache/papers"
  }
}
```

如果你写的是相对路径，它们就会相对于 `cwd` 解析。

### 可选：安装 Marker（更高质量的本地 PDF 解析） 🧠

Marker 使用深度学习模型把 PDF 转成 Markdown，相比内置 `pdf-parse` 精度更高，适合生产使用。

> **当前路径行为：** Marker 会从 `cwd` 下的 `./marker-worker` 查找运行目录。所以如果你要启用 Marker，`cwd` 最好指向包含 `marker-worker/` 的目录（例如项目根目录），或者把 `marker-worker/` 复制到你的运行目录中。

**前置要求：** Python 3.12。可选：NVIDIA GPU + CUDA。

**安装：**

```powershell
cd marker-worker
.\install.ps1              # 自动检测 CPU/GPU
.\install.ps1 -Torch cuda  # 强制使用 CUDA
.\install.ps1 -Torch cpu   # 强制使用 CPU
```

安装脚本会：
1. 创建 Python 3.12 虚拟环境（通过 `uv`）
2. 安装 Marker 和对应的 PyTorch 后端
3. 把模型和字体下载到 `marker-worker/.cache/`

**配置启用：**

```json
{
  "extract": {
    "parsing": {
      "markerTimeout": 120000,
      "order": ["Marker", "Native"],
      "enabled": {
        "LlamaParse": false,
        "Marker": true,
        "Native": true
      }
    }
  }
}
```

Marker 属于渐进式解析链路的一部分；如果失败或超时，GRaDOS 会自动回退到 `Native`。`markerTimeout` 的单位是毫秒，默认 120 秒。

**验证：**

```bash
node tests/mcp-smoke.mjs
```

如果 Marker 正常启用，日志里会出现：

```text
[Marker] Converting PDF with local Marker worker...
Marker successfully converted PDF to Markdown.
```

### 本地论文知识库 🗂️

GRaDOS 和 `mcp-local-rag` 可以很好地配合使用：GRaDOS 负责抓取和解析，`mcp-local-rag` 负责索引保存下来的 Markdown 文件，供后续语义检索和关键词检索使用。

**存储分离：** 为避免重复索引，PDF 和 Markdown 分开保存：

| 目录 | 内容 | 作用 | 对应配置 |
|---|---|---|---|
| `downloads/` | 原始 `.pdf` 文件 | 归档，不参与索引 | `extract.downloadDirectory` |
| `papers/` | 解析后的 `.md` 文件（带 YAML front-matter） | 供 `mcp-local-rag` 索引 | `extract.papersDirectory` |

Markdown 文件会带上结构化 front-matter，例如：

```yaml
---
doi: "10.1038/s41598-025-29656-1"
title: "Triple-negative complementary metamaterial..."
source: "Unpaywall OA"
fetched_at: "2026-03-17T12:00:00.000Z"
---
```

**工作流：**

1. **Extract** - GRaDOS 下载 PDF、解析内容，并把 `.pdf` 保存到 `downloads/`，`.md` 保存到 `papers/`
2. **Ingest** - agent 调用 `ingest_file`，把新的 `.md` 建立向量索引
3. **Query** - 后续问题可以先用 `query_documents` 查本地库
4. **Manage** - 用 `list_files` / `delete_file` 管理索引文件

> **注意：** `mcp-local-rag` 不会自动扫描目录。新论文仍然需要显式调用 `ingest_file`。如果你使用 `skills/GRaDOS/SKILL.md` 中的流程，这一步可以交给 agent 按协议执行。

### 可选：安装 mcp-local-rag（本地 RAG 论文库） 🔎

[`mcp-local-rag`](https://github.com/shinpr/mcp-local-rag) 提供本地论文语义检索。GRaDOS 会自动把解析后的 Markdown 写入 `papers/`，而 `mcp-local-rag` 负责索引该目录。

**注册到 MCP 客户端：**

```bash
# Claude Code
claude mcp add local-rag -- npx -y mcp-local-rag

# Codex（显式设置 BASE_DIR）
codex mcp add local-rag --env BASE_DIR=/absolute/path/to/papers -- npx -y mcp-local-rag
```

对 Claude Code 来说，下面的手动配置方式更容易保证 `BASE_DIR` 和你的 `papers` 目录完全一致。

也可以手动配置。

Claude Code（`.claude/settings.json`）：

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados"],
      "cwd": "/path/to/project-or-config-directory"
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/absolute/path/to/papers"
      }
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
cwd = "/path/to/project-or-config-directory"

[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]
env = { BASE_DIR = "/absolute/path/to/papers" }
```

> **重要：** `BASE_DIR` 必须和 `mcp-config.json` 里的 `extract.papersDirectory` 指向同一个绝对目录。如果 `extract.papersDirectory` 写的是相对路径，需要先基于 `cwd` 把它解析成绝对路径。

上面的 **本地论文知识库** 一节已经说明了存储分离和 ingest/query 工作流。这里额外需要记住的是：`mcp-local-rag` 不会自动扫描目录，agent 仍然需要对每个新 Markdown 文件调用一次 `ingest_file`。

### 可选：Zotero Web Library 集成 📚

GRaDOS 可以在每次研究任务结束后，把引用过的论文自动保存到你的 [Zotero](https://www.zotero.org/) Web Library，无需桌面客户端。

**配置方法：**

1. 在 `https://www.zotero.org/settings/keys` 创建有写权限的 API Key
2. 记录同页显示的 `userID`
3. 把它们写进 `mcp-config.json`

```json
{
  "zotero": {
    "libraryId": "1234567",
    "libraryType": "user",
    "defaultCollectionKey": ""
  },
  "apiKeys": {
    "ZOTERO_API_KEY": "your-api-key-here"
  }
}
```

## 配置说明 ⚙️

所有配置都在 `mcp-config.json` 中。可以先运行 `grados --init` 生成模板，再按需修改。

### API Keys 🔑

| Key | 来源 | 必填 | 免费 |
|---|---|---|---|
| `ELSEVIER_API_KEY` | [Elsevier Developer Portal](https://dev.elsevier.com/) | 否 | 是（机构访问） |
| `WOS_API_KEY` | [Clarivate Developer Portal](https://developer.clarivate.com/) | 否 | 是（starter） |
| `SPRINGER_meta_API_KEY` | [Springer Nature API](https://dev.springernature.com/) | 否 | 是 |
| `SPRINGER_OA_API_KEY` | 同上（OpenAccess endpoint） | 否 | 是 |
| `LLAMAPARSE_API_KEY` | [LlamaCloud](https://cloud.llamaindex.ai/) | 否 | 有免费额度 |
| `ZOTERO_API_KEY` | [Zotero Settings -> Keys](https://www.zotero.org/settings/keys) | 否 | 是 |

Crossref、PubMed、Sci-Hub、Unpaywall 不需要 API Key。

**没有任何 API Key 也能运行**。GRaDOS 会自动跳过未配置的服务，至少可以走 Crossref + PubMed + Sci-Hub 这几条路径。

### 搜索优先级 🔎

`search.order` 控制优先搜索哪些数据库；一旦拿到足够多的唯一 DOI，GRaDOS 就会停止继续搜索。

```json
{
  "search": {
    "order": ["Elsevier", "Springer", "WebOfScience", "Crossref", "PubMed"]
  }
}
```

### 全文抓取优先级 🌊

`extract.fetchStrategy.order` 控制全文抓取的回退顺序：

```json
{
  "extract": {
    "fetchStrategy": {
      "order": ["TDM", "OA", "SciHub", "Headless"]
    }
  }
}
```

### 存储目录 🗄️

- `extract.downloadDirectory` 默认是 `./downloads`，用于保存原始 PDF
- `extract.papersDirectory` 默认是 `./papers`，用于保存解析后的 Markdown
- 相对路径都基于 `cwd` 解析；如果想把数据放到别处，建议直接写绝对路径
- `mcp-local-rag` 的 `BASE_DIR` 必须和 `extract.papersDirectory` 指向同一个绝对目录

## SKILL.md 🤖

`skills/GRaDOS/SKILL.md` 是配套的结构化提示词，描述了围绕 GRaDOS 和 `mcp-local-rag` 的研究流程。把它放到 agent 的技能目录后，agent 就可以按这套协议调用这两个 MCP 服务。

## License 📄

MIT
