FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY index.js admin.html data.json ./
EXPOSE 3000
CMD ["node", "index.js"]
