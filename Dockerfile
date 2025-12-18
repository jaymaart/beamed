FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV PORT=8204
EXPOSE 8204
CMD ["node", "server.js"]

