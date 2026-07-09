# Contributing to Transup

Thanks for your interest! This project is young and moving fast — small, focused PRs are the easiest to review and land.

## Ground rules

Every change must pass the full gate before it is considered done:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, including the resilience regression suite
npm run build       # tsup bundle must still build
```

CI runs exactly these steps on every push and PR.

## Design principles

- **`@transup/core` stays UI-free.** The engine yields events from an `AsyncGenerator`; anything that prints, renders, or prompts belongs in a host (`packages/cli` today). If your core change needs `console.log`, it probably wants a new event type instead.
- **Any model is a first-class citizen.** Features must work through the neutral `Provider` interface. Protocol-specific tricks (like Anthropic prompt caching) live inside that provider's translation layer, never in the engine.
- **Fail closed.** Unknown tools, malformed arguments, and unconfirmed writes are rejected, and the rejection is fed back to the model as a tool result so it can adapt.
- **Regression-first for reliability bugs.** If you fix an agent-loop stall or a protocol edge case, add a case to `packages/core/test/resilience.test.ts` (or the relevant suite) that fails without your fix.
- **Keep files small.** Capabilities go in focused modules (see `core/src/agent/`); the engine file stays orchestration-only.

## Workflow

1. Fork and create a feature branch from `main`.
2. Make your change; add or update tests alongside it.
3. Update `ROADMAP.md` if you complete a roadmap item, and note breaking architectural changes there with your reasoning.
4. Open a PR describing **what** changed and **why** — link an issue if one exists.

## Project layout

```
packages/core/   engine, providers, tools, sessions (zero UI deps)
packages/cli/    Ink TUI + headless host
```

`ROADMAP.md` is the single source of truth for progress and planned work.
