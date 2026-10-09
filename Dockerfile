# WARFIELD game server — runs on any container host (Koyeb, Oracle Cloud, Fly.io,
# Google Cloud Run, Hugging Face Spaces, your own PC ...).
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && test -f node_modules/express/index.js && test -f node_modules/three/build/three.module.js && npm cache clean --force
COPY client ./client
COPY server ./server
COPY shared ./shared
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
# run as the unprivileged "node" user (uid 1000)
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
