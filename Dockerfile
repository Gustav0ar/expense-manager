FROM node:26-alpine AS deps
WORKDIR /app
RUN npm install -g corepack && corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS migrator
WORKDIR /app
COPY . .
CMD ["pnpm", "db:migrate"]

FROM postgres:18-alpine AS backup
RUN apk add --no-cache ca-certificates restic tzdata
COPY scripts/backup.sh /usr/local/bin/backup.sh
RUN chmod 755 /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]

FROM node:26-alpine AS build
WORKDIR /app
RUN npm install -g corepack && corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN ORIGIN=http://localhost:3000 \
	BETTER_AUTH_SECRET=build-time-placeholder-build-time-placeholder \
	DATABASE_URL=postgres://postgres:postgres@localhost:5432/app \
	pnpm build
RUN pnpm prune --prod --ignore-scripts

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/uploads && chown -R app:app /app/uploads
COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules

USER app
EXPOSE 3000
CMD ["node", "build"]
