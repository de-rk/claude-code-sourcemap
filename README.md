# claude-code-sourcemap

[![linux.do](https://img.shields.io/badge/linux.do-huo0-blue?logo=linux&logoColor=white)](https://linux.do)

> [!WARNING]
> This repository is **unofficial** and is reconstructed from the public npm package and source map analysis, **for research purposes only**.
> It does **not** represent the original internal development repository structure.
>
> 本仓库为**非官方**整理版，基于公开 npm 发布包与 source map 分析还原，**仅供研究使用**。
> **不代表**官方原始内部开发仓库结构。
> 一切基于L站"飘然与我同"的情报提供

## 概述

本仓库通过 npm 发布包（`@anthropic-ai/claude-code`）内附带的 source map（`cli.js.map`）还原的 TypeScript 源码，版本为 `2.1.88`。

## 来源

- npm 包：[@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- 还原版本：`2.1.88`
- 还原文件数：**4756 个**（含 1884 个 `.ts`/`.tsx` 源文件）
- 还原方式：提取 `cli.js.map` 中的 `sourcesContent` 字段

## 目录结构

```
restored-src/src/
├── main.tsx              # CLI 入口
├── tools/                # 工具实现（Bash、FileEdit、Grep、MCP 等 30+ 个）
├── commands/             # 命令实现（commit、review、config 等 40+ 个）
├── services/             # API、MCP、分析等服务
├── utils/                # 工具函数（git、model、auth、env 等）
├── context/              # React Context
├── coordinator/          # 多 Agent 协调模式
├── assistant/            # 助手模式（KAIROS）
├── buddy/                # AI 伴侣 UI
├── remote/               # 远程会话
├── plugins/              # 插件系统
├── skills/               # 技能系统
├── voice/                # 语音交互
└── vim/                  # Vim 模式
```

## OpenAI 兼容提供商支持

本仓库额外包含一个 `openai-proxy.js`，可将 Anthropic Messages API 请求转换为 OpenAI `/chat/completions` 格式，从而让 Claude Code 使用任意 OpenAI 兼容的模型提供商。

### 配置

复制 `.env` 模板并填入你的提供商信息：

```bash
cp .env.example .env   # 如果有模板的话
# 或直接编辑 .env
```

`.env` 支持以下变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_BASE_URL` | 提供商 API 地址 | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | 提供商 API Key | — |
| `OPENAI_MODEL` | 使用的模型名称 | `gpt-4o` |
| `PROXY_PORT` | 本地代理端口 | `19999` |

常用提供商示例：

```env
# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=deepseek-chat

# Groq
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_API_KEY=gsk_your-key
OPENAI_MODEL=llama-3.3-70b-versatile

# Ollama（本地）
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5-coder:32b
```

### 启动方式

**方式一：一条命令启动（推荐）**

```bash
node --env-file=.env package/cli.js
```

Claude Code 会自动检测 `OPENAI_*` 环境变量并启动内置代理。

**方式二：手动分步启动**

```bash
# 终端 1：启动代理
node --env-file=.env openai-proxy.js

# 终端 2：启动 Claude Code，指向本地代理
ANTHROPIC_BASE_URL=http://127.0.0.1:19999 ANTHROPIC_API_KEY=dummy node package/cli.js
```

**健康检查：**

```bash
curl http://127.0.0.1:19999/health
```

### 注意事项

- `.env` 文件包含 API Key，**不要提交到 Git**（已在 `.gitignore` 中排除）
- 如需分享配置模板，使用 `.env.example` 并留空 Key 字段

## 声明

- 源码版权归 [Anthropic](https://www.anthropic.com) 所有
- 本仓库仅用于技术研究与学习，请勿用于商业用途
- 如有侵权，请联系删除
