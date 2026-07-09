# transup

Open-source AI coding agent for your terminal — built for **a polished, top-tier agent experience, whatever model you run**.

Works with OpenAI-compatible Chat Completions APIs (DeepSeek, Kimi, OpenRouter, vLLM, …), OpenAI Responses API, and the native Anthropic protocol (with prompt caching).

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

# or Responses API gateways
PROVIDER=openai-responses
OPENAI_WIRE_API=responses
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
MODEL=gpt-5.1
```

Full documentation, roadmap, and source: **https://github.com/kumaleap/transup**

MIT licensed.
