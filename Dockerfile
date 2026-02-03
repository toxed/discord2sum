# Minimal runtime image for discord2sum.
# Note: STT (whisper.cpp / faster-whisper) must be available/configured.

FROM node:20-bookworm-slim

WORKDIR /app

# Avoid running as root
RUN useradd -m -u 10001 appuser

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY prompts ./prompts
COPY .env.example ./
COPY README.md LICENSE PRIVACY.md SECURITY.md CONTRIBUTING.md ./

USER appuser

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
