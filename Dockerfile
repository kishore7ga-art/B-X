# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
# `npm ci`, not `npm install`: ci installs exactly what package-lock.json
# pins and fails if the two disagree, which is the difference between a
# reproducible image and one that silently picks up a new transitive version
# at build time. --ignore-scripts stays: no dependency needs a postinstall
# here, and a postinstall is where a compromised package runs.
RUN npm ci --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Not `|| true`. A build that fails should fail the image rather than ship
# whatever `dist/` happened to be in the build context — which, with the
# `COPY . .` above, is a developer machine's stale output or nothing at all.
RUN npm run build

RUN addgroup -g 1001 -S nodejs && adduser -S api -u 1001 \
 && mkdir -p public/uploads && chown -R api:nodejs public/uploads
USER api

EXPOSE 4000
CMD ["npm", "start"]
