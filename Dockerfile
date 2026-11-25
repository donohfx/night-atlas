FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
USER node
ENV PORT=8080
CMD ["node", "server/server.mjs"]
