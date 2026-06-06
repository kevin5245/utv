`docker run -d \
  --name moontv \
  -p 3000:3000 \
  -v $(pwd)/data.json:/app/data.json \
  -e WEB_LIVE_API_TOKEN="YOUR_SECRET_TOKEN" \
  -e DOUYIN_COOKIE="YOUR_COOKIE" \
  ghcr.io/你的用户名/moontvplus-live-manager:latest`
