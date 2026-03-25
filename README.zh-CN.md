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

### MCP 工具 🔧

| 服务 | 工具 | 说明 |
|---|---|---|
| GRaDOS | `search_academic_papers` | 按优先级串行搜索 Scopus、Web of Science、Springer、Crossref、PubMed，并按 DOI 去重；可通过 `continuation_token` 续搜下一批未见论文 |
| GRaDOS | `extract_paper_full_text` | 按 4 级抓取策略 + 3 级解析策略提取全文，并做 QA 校验。全文自动保存到 `papers/` 目录，返回给 agent 的是**紧凑且不可直接引用的已保存论文摘要**（标题、DOI、规范路径/URI、短 preview、section headings），以减少上下文窗口占用 |
| GRaDOS | `parse_pdf_file` | 解析本地 PDF 文件，复用已有的解析 waterfall（LlamaParse → Marker → Native）。用于浏览器辅助下载 PDF 后的解析；如果提供 DOI，则返回与 `extract_paper_full_text` 相同的已保存论文摘要契约 |
| GRaDOS | `read_saved_paper` | 已保存论文的标准深读工具。接受 `doi`、`safe_doi` 或 `grados://papers/{safe_doi}`，返回用于综合和引文核查的段落窗口 |
| GRaDOS | `save_paper_to_zotero` | 通过 Zotero Web API 保存已引用论文的元数据 |
| mcp-local-rag | `query_documents` | 对本地已索引论文做语义检索和关键词检索 |
| mcp-local-rag | `ingest_file` | 把 Markdown 论文索引进本地 RAG 数据库 |
| mcp-local-rag | `list_files` | 查看已索引文件及状态 |
| mcp-local-rag | `delete_file` | 删除过期或不再需要的本地索引条目 |
| mcp-local-rag | `status` | 检查本地 RAG 数据库状态与配置告警 |

### SKILL.md（配套 Skill） 🤖

`skills/grados/SKILL.md` 是配套的结构化提示词，描述了围绕 GRaDOS 和 `mcp-local-rag` 的研究流程。把它放到 agent 的技能目录后，agent 就可以按这套协议调用这两个 MCP 服务。

### 本地论文知识库 🗂️

GRaDOS 提取论文后，会将 PDF 和解析后的 Markdown 分开保存，避免重复索引：

| 目录 | 内容 | 作用 | 对应配置 |
|---|---|---|---|
| `downloads/` | 原始 `.pdf` 文件 | 归档，不参与索引 | `extract.downloadDirectory` |
| `papers/` | 解析后的 `.md` 文件（带 YAML front-matter） | 可供语义检索和关键词检索 | `extract.papersDirectory` |

Markdown 文件会带上结构化 front-matter，例如：

```yaml
---
doi: "10.1038/s41598-025-29656-1"
title: "Triple-negative complementary metamaterial..."
source: "Unpaywall OA"
fetched_at: "2026-03-17T12:00:00.000Z"
---
```

配合 [`mcp-local-rag`](https://github.com/shinpr/mcp-local-rag)，可以对 `papers/` 中的文件建立向量索引，实现本地论文语义检索和关键词检索。完整工作流如下：

1. **Extract** - GRaDOS 下载 PDF、解析内容，并把 `.pdf` 保存到 `downloads/`，`.md` 保存到 `papers/`
2. **Ingest** - agent 调用 `ingest_file`，把新的 `.md` 建立向量索引
3. **Query** - 后续问题可以先用 `query_documents` 查本地库
4. **Manage** - 用 `list_files` / `delete_file` 管理索引文件

> **注意：** `mcp-local-rag` 不会自动扫描目录。新论文仍然需要显式调用 `ingest_file`。如果你使用 `skills/grados/SKILL.md` 中的流程，这一步可以交给 agent 按协议执行。

此外，GRaDOS 还会把已保存论文暴露为与安装方式无关的 MCP 能力：

- `read_saved_paper`：模型驱动的标准深读入口
- `grados://papers/index`：已保存论文索引
- `grados://papers/{safe_doi}`：单篇已保存论文的规范 Markdown resource

## 安装 🚀

### 安装 GRaDOS

#### 方式 A：Claude Code 插件（最省事） 🔌

如果你使用 [Claude Code](https://code.claude.com/)（CLI 或 Desktop），可以把 GRaDOS 安装成 plugin。它会自动注册 GRaDOS、mcp-local-rag 和 Playwright 三个 MCP 服务，无需手工配置。

> Plugin 中运行的是与下文相同的 GRaDOS stdio MCP server，并不是另一套独立的论文读取 API。

**1. 添加 marketplace 并安装：**

```bash
# 在 Claude Code 中
/plugin marketplace add https://github.com/STSNaive/GRaDOS.git
/plugin install grados@grados-marketplace
```

**2. 运行 setup 命令：**

```
/grados:setup
```

这会生成 `${CLAUDE_PLUGIN_DATA}/mcp-config.json`，并引导你填写 API Key。Plugin 还会自动把 `local-rag` 指向 `${CLAUDE_PLUGIN_DATA}/papers`，所以默认流程下不需要再配置环境变量或 shell profile。

**3. 重载并验证：**

```
/reload-plugins
/grados:status
```

> **Plugin 内含内容：** GRaDOS MCP server、[mcp-local-rag](https://github.com/shinpr/mcp-local-rag)（本地论文检索）、[Playwright MCP](https://github.com/microsoft/playwright-mcp)（浏览器辅助下载 PDF）、研究工作流 skill，以及 setup/status 命令。

#### 方式 B：npm（手动配置） 📦

```bash
npm install -g grados

# 在当前工作目录生成配置文件
grados --init

# 编辑配置并填入 API Key
# （所有选项见 mcp-config.example.json）
```

检查更新：`npm outdated -g grados`——如果有新版本，重新运行 `npm install -g grados` 即可。

#### 方式 C：源码安装 🛠️

```bash
git clone https://github.com/STSNaive/GRaDOS.git
cd GRaDOS
npm install
npm run build

cp mcp-config.example.json mcp-config.json
# 编辑 mcp-config.json 并填入 API Key
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

如果你希望 GRaDOS 加载一个固定的 `mcp-config.json`，请使用 `--config`（推荐）或 `GRADOS_CONFIG_PATH`：

Claude Code（`.claude/settings.json`）：

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "/path/to/mcp-config.json"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados", "--config", "/path/to/mcp-config.json"]
```

无论 GRaDOS 是通过 `npx`、源码目录，还是 Claude plugin 内置方式启动，暴露给模型的核心 MCP API 都相同；差别只在于 stdio server 的启动方式和配置文件所在位置。

### 可选：安装 Marker（更高质量的本地 PDF 解析） 🧠

Marker 使用深度学习模型把 PDF 转成 Markdown，相比内置 `pdf-parse` 精度更高，适合生产使用。

> **路径行为：** Marker 会从 grados 包安装目录（`PACKAGE_ROOT`）中的 `marker-worker/` 查找，而不是从 `cwd` 或配置文件目录查找。通过 `npm install -g grados` 安装时，它会自动位于正确位置。

**前置要求：** Python 3.12。可选：Windows/Linux 上的 NVIDIA GPU + CUDA 加速。

**安装（macOS/Linux）：**

```bash
cd marker-worker
chmod +x ./install.sh
./install.sh               # 统一走 uv；Linux 检测到 NVIDIA 时会询问是否安装 CUDA 版
./install.sh --device cpu  # 强制使用 CPU
./install.sh --device cuda # 仅 Linux
```

**安装（Windows PowerShell）：**

```powershell
cd marker-worker
.\install.ps1              # 统一走 uv；检测到 NVIDIA 时会询问是否安装 CUDA 版
.\install.ps1 -Device cpu  # 强制使用 CPU
.\install.ps1 -Device cuda # 强制使用 CUDA
```

安装脚本会：
1. 通过 `uv` 创建或同步 Python 3.12 虚拟环境
2. 写入 `marker-worker/local.env`，记录 `MARKER_PYTHON` 和可选的 `TORCH_DEVICE`
3. 把模型权重和字体预热到 `marker-worker/.cache/`（除非使用 `--skip-prewarm`）
4. 运行 `verify.py` 做真实握手验证，只有 GRaDOS 能成功拉起本地 Marker worker 时才算安装成功

默认情况下，Marker 会自动选择合适的 torch 设备。对 macOS 来说，这意味着在可用时可以自动使用 PyTorch 的 MPS。CUDA 仍然是显式可选分支；如果 CUDA 安装后的验证失败，安装脚本会自动回退到 CPU 兼容模式，确保 GRaDOS 仍然可以使用 Marker。

> **local.env 行为：** GRaDOS 会优先读取 `marker-worker/local.env` 中的 `MARKER_PYTHON`，只有没有配置时才回退到标准 `.venv/` 解释器路径。这样无论是脚本安装还是手工安装，都可以在不改主配置文件的情况下把 GRaDOS 指向正确的 Python 环境。

**启用配置：** 安装完成后，在 `mcp-config.json` 中启用 Marker：

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

Marker 属于渐进式解析回退链路的一部分；如果失败或超时，GRaDOS 会自动回退到 `Native`（`pdf-parse`）。`markerTimeout` 的单位是毫秒，用来控制回退前的最长等待时间，默认 120 秒。

**验证：**

```bash
node tests/mcp-smoke.mjs
```

如果 Marker 正常启用，日志里会出现：

```text
[Marker] Converting PDF with local Marker worker...
Marker successfully converted PDF to Markdown.
```

### 可选：安装 mcp-local-rag（本地 RAG 论文库） 🔎

[`mcp-local-rag`](https://github.com/shinpr/mcp-local-rag) 为本地论文提供语义检索和关键词检索能力。纯 Node.js，不需要 Python。

> **版本说明：** 当前 `mcp-local-rag` 0.10.x 需要 Node.js 20 或更高版本。
>
> **检查更新：** `npm outdated -g mcp-local-rag`——如果有新版本，重新运行 `npm install -g mcp-local-rag` 即可。

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

> **重要：** `BASE_DIR` 必须和 `mcp-config.json` 里的 `extract.papersDirectory` 指向同一个绝对目录。如果 `extract.papersDirectory` 写的是相对路径，请先按 `PROJECT_ROOT`（通常是配置文件所在目录）把它解析成绝对路径。


### 可选：Zotero Web Library 集成 📚

GRaDOS 可以在每次研究任务结束后，把引用过的论文自动保存到你的 [Zotero](https://www.zotero.org/) Web Library。无需桌面客户端，直接通过 Zotero Web API 即可完成。

**配置方法：**

1. 在 `https://www.zotero.org/settings/keys` 创建一个 **有写权限的 API Key**
2. 记录同页显示的 **library ID**（也就是 “Your userID for use in API calls” 中的数字）
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

保存到 Zotero 的条目类型为 `journalArticle`，包含标题、DOI、作者、摘要、期刊、年份、URL 和标签。研究主题会自动作为标签写入，方便按课题整理文献。

### 可选：Playwright MCP（LLM 友好的浏览器回退） 🌐

当 GRaDOS 内置的无头浏览器（Puppeteer）无法提取 PDF 时——通常是因为复杂的出版商页面布局或 CAPTCHA 验证——AI agent 可以回退到 [Playwright MCP](https://github.com/microsoft/playwright-mcp)，它通过 accessibility tree 快照让 LLM 直接控制浏览器。

**为什么选 Playwright MCP 而不是原始 Puppeteer？** Puppeteer 使用硬编码的 CSS 选择器，遇到不熟悉的出版商页面就会失败。而 Playwright MCP 让 LLM 看到页面结构，自适应地点击正确的下载按钮，不受页面布局限制。由于会消耗 token（~13.7K base + 页面内容），所以仅在零成本的 Puppeteer 路径失败时才使用。

现在内置的 Puppeteer 回退已经支持 **Windows、macOS 和 Linux**，但只会探测你配置的浏览器类型（`msedge`、`chrome` 或 `firefox`）在当前系统上的常见路径；如果找不到，也可以在 `mcp-config.json` 中显式设置 `headlessBrowser.executablePath`。

**安装：**

```bash
npm install -g @playwright/mcp
```

检查更新：`npm outdated -g @playwright/mcp`——如果有新版本，重新运行 `npm install -g @playwright/mcp` 即可。

**注册到 MCP 客户端：**

```bash
# Claude Code
claude mcp add playwright -- npx @playwright/mcp --headless

# Codex
codex mcp add playwright -- npx @playwright/mcp --headless
```

也可以手动配置。Claude Code（`.claude/settings.json`）：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"]
    }
  }
}
```

`SKILL.md` 中的工作流（Step 3b）会自动引导 agent 在 `extract_paper_full_text` 失败时使用 Playwright MCP 工具。流程为：`browser_navigate` → `browser_snapshot` → `browser_click` → 下载完成 → `parse_pdf_file`。

> **注意：** Playwright MCP 完全是可选的。不安装它，GRaDOS 仍然通过内置的 waterfall（TDM → OA → Sci-Hub → Headless Puppeteer）正常工作。Playwright MCP 只是为 Puppeteer 无法处理的情况添加了一层 LLM 驱动的安全网。

### 配置示例：GRaDOS + mcp-local-rag + Playwright 🧩

如果你希望一次性接入最常见的完整研究工作流，可以把这三个 MCP 服务一起配置。下面这个例子假设配置文件在 `D:/Projects/Papers/mcp-config.json`，并且 `extract.papersDirectory` 使用默认相对路径 `./papers`，因此 `mcp-local-rag` 的 `BASE_DIR` 对应到 `D:/Projects/Papers/papers`。

Claude Code（`.claude/settings.json`）：

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "D:/Projects/Papers/mcp-config.json"]
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "D:/Projects/Papers/papers"
      }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados", "--config", "D:/Projects/Papers/mcp-config.json"]

[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]
env = { BASE_DIR = "D:/Projects/Papers/papers" }

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp", "--headless"]
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

如果第一次筛过一批论文后还需要继续获取“下一批”，请使用相同的 `query` 再次调用 `search_academic_papers`，并传入上一次 `structuredContent` 返回的 `next_continuation_token`。只要 `has_more` 仍然是 `true`，后续调用就会继续返回尚未见过的新论文。

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
- 相对路径都基于 `PROJECT_ROOT`（配置文件所在目录）解析；下面的“提示：路径解析”会给出完整规则和实例
- `mcp-local-rag` 的 `BASE_DIR` 必须和 `extract.papersDirectory` 指向同一个绝对目录

#### 提示：路径解析 💡

GRaDOS 会在两个独立作用域中解析路径：

| 作用域 | 解析基准 | 示例 |
|---|---|---|
| **包内资源** | npm 安装目录（`PACKAGE_ROOT`） | `marker-worker/` |
| **项目文件** | 配置文件所在目录（`PROJECT_ROOT`） | `downloads/`、`papers/`、`scihub-mirrors.txt` |

**配置文件发现顺序**（按优先级）：

1. 命令行参数 `--config <path>`
2. 环境变量 `GRADOS_CONFIG_PATH`
3. 默认回退到 `cwd/mcp-config.json`

最终解析出的配置文件所在目录会成为 `PROJECT_ROOT`。`mcp-config.json` 中所有相对路径（例如 `./papers`、`./downloads`）都会相对于这个目录解析，而不是相对于进程当前工作目录。

**示例：**

```bash
# 显式指定配置文件（推荐给 MCP 客户端使用）
grados --config D:/Projects/Papers/mcp-config.json

# 或通过环境变量
GRADOS_CONFIG_PATH=D:/Projects/Papers/mcp-config.json grados
```

Claude Code（`.claude/settings.json`）—— 使用 `--config`，而不是依赖 `cwd`：

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "D:/Projects/Papers/mcp-config.json"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）—— 使用环境变量：

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
env = { GRADOS_CONFIG_PATH = "D:/Projects/Papers/mcp-config.json" }
```

如果你想把数据存到别处，请在配置里使用绝对路径：

```json
{
  "extract": {
    "downloadDirectory": "E:/academic-cache/downloads",
    "papersDirectory": "E:/academic-cache/papers"
  }
}
```

## Claude Code 插件 🔌

GRaDOS 可以作为 Claude Code 插件使用，开箱即用地提供 skill、斜杠命令和 MCP 服务配置。安装方式请使用前文“安装 > 方式 A”中的那一套命令。

### 包含内容

| 组件 | 说明 |
|---|---|
| **Skill** (`/grados:grados`) | 完整的学术研究流程 — 检索、提取、综合、引用 |
| **命令** (`/grados:setup`) | 交互式配置向导，引导设置 API Key 和依赖 |
| **命令** (`/grados:status`) | 诊断检查：服务状态、API Key、存储目录 |
| **MCP 服务** | 自动配置的 `grados` 服务，通过 `npx -y grados` 启动 |

### 配置如何工作

打包进 plugin 的 `.mcp.json` 会这样连线：

- `grados` 通过 `--config ${CLAUDE_PLUGIN_DATA}/mcp-config.json` 启动
- `local-rag` 通过 `BASE_DIR=${CLAUDE_PLUGIN_DATA}/papers` 启动
- `playwright` 以 headless 模式启动

先运行 `/grados:setup` 生成 `${CLAUDE_PLUGIN_DATA}/mcp-config.json`，再在这个文件里填写你要用的 API Key，之后执行 `/reload-plugins` 让内置 MCP 服务重新加载配置。默认 plugin 流程下不需要再单独设置 shell 环境变量。

运行 `/grados:status` 可以查看最终配置状态。

## License 📄

MIT
