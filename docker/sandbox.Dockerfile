# Chromium-only headless image: no Firefox/WebKit/full GUI browser layers on the Pi.
# Node and Playwright's Linux Chromium headless shell support amd64 + arm64.
FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /opt/runtime
RUN npm install --omit=dev --ignore-scripts playwright@1.63.0 \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm \
 && chmod -R a+rX /opt/browsers \
 && ln -s /opt/runtime/node_modules /node_modules
COPY docker/sandbox/ /opt/runtime/
ENV HOME=/tmp HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 NO_PROXY=127.0.0.1,localhost NODE_USE_ENV_PROXY=1
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runtime/main.mjs"]
