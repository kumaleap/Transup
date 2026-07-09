# transup

Open-source AI coding agent for your terminal — **any model is a first-class citizen**.

Works with any OpenAI-compatible API (DeepSeek, Kimi, OpenRouter, vLLM, …) and the native Anthropic protocol (with prompt caching).

```bash
npx transup                # interactive TUI
npx transup -p "task"      # headless: pipe-friendly, CI-friendly
```

Configure via `.env` in your project root:

```bash
PROVIDER=openai
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-...
MODEL=deepseek-chat
```

Full documentation, roadmap, and source: **https://github.com/kumaleap/transup**

MIT licensed.
