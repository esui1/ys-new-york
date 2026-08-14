FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
# SQLite lives on the mounted volume so the edition survives redeploys
ENV DATABASE_PATH=/data/register.db PORT=8787
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
