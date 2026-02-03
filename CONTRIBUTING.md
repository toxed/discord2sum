# Contributing

Thanks for helping improve **discord2sum**.

## Development setup

```bash
npm install
cp .env.example .env
# fill env
npm start
```

## Guidelines

- Do not commit secrets (`.env`, tokens, chat IDs).
- Keep changes small and focused.
- Include a short explanation in the PR description.

## Code style

This repo currently uses plain JS (Node ESM). Keep imports explicit and avoid adding heavy dependencies unless necessary.
