# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
# Prisma's query engine needs OpenSSL; libc6-compat covers glibc-linked binaries.
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
# Dev dependencies are kept: the Prisma CLI runs at container start, and the
# server itself runs through tsx.
RUN npm install --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# generate never connects, so a placeholder satisfies the config loader; the
# real DATABASE_URL is injected at runtime.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npx prisma generate

RUN addgroup -g 1001 -S nodejs && adduser -S api -u 1001 \
 && mkdir -p public/uploads && chown -R api:nodejs public/uploads
USER api

EXPOSE 4000
CMD ["npm", "start"]
