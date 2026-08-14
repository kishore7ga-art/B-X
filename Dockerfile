# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN addgroup -g 1001 -S nodejs && adduser -S api -u 1001 \
 && mkdir -p public/uploads && chown -R api:nodejs public/uploads
USER api

EXPOSE 4000
CMD ["npm", "start"]
