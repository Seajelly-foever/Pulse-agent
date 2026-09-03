FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /data
ENV PULSE_DATABASE_PATH=/data/pulse.db
EXPOSE 8789
CMD ["node","src/server.mjs"]
