# Map tiles are generated from the checked-in web/ data, in a throwaway stage.
FROM node:24-alpine AS tiles
RUN apk add --no-cache imagemagick imagemagick-jpeg imagemagick-webp
WORKDIR /app
COPY tools/build-tiles.mjs tools/build-gazetteer.mjs tools/gazetteer.json.gz tools/write-pmtiles.mjs tools/paint-river-water.mjs tools/river-water.json.gz ./tools/
COPY web ./web
RUN node tools/build-tiles.mjs

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
RUN node server/precompress.mjs
COPY --from=tiles /app/web/tiles ./web/tiles
USER node
ENV PORT=8080
CMD ["node", "server/server.mjs"]
