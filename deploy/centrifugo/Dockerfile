# Centrifugo realtime service — separate Railway service.
#
# Secrets are injected via environment variables, never baked into the
# image or committed:
#   CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY  — must equal both backends'
#                                            CENTRIFUGO_TOKEN_SECRET
#   CENTRIFUGO_HTTP_API_KEY                  — must equal both backends'
#                                            CENTRIFUGO_API_KEY
#
# Deploy: Railway → New Service → this repo, root directory
# `deploy/centrifugo`. Health check: GET /health.
FROM centrifugo/centrifugo:v6

COPY config.json /centrifugo/config.json

EXPOSE 8000

CMD ["centrifugo", "-c", "config.json"]
