# Mandat on Hugging Face Spaces (Docker SDK), running on NVIDIA Nemotron through Nebius Token Factory.
# The Space holds only this file and its README: the code is pulled from the public GitHub repo, branch "nebius",
# so a restart of the Space ("Factory rebuild") deploys the latest commit.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user
WORKDIR /home/user/app
# Busts the build cache when the branch moves, so a rebuild always takes the latest commit.
ADD --chown=user https://api.github.com/repos/blanco1er/mandat/git/refs/heads/nebius /home/user/nebius-ref.json
RUN git clone --depth 1 --branch nebius https://github.com/blanco1er/mandat.git . && npm ci --omit=dev
# Not secret: which models and where. Keys are Space secrets (DEEPSEEK_API_KEY = the Token Factory key, PayPal, Google, R2...).
ENV PORT=7860 \
    MANDAT_DATA=/home/user/app/data \
    DEEPSEEK_BASE_URL=https://api.tokenfactory.nebius.com/v1 \
    DEEPSEEK_FAST_MODEL=nvidia/nemotron-3-super-120b-a12b \
    DEEPSEEK_SMART_MODEL=nvidia/Nemotron-3-Ultra-550b-a55b \
    DEEPSEEK_VISION_MODEL=google/gemma-3-27b-it \
    R2_PREFIX=nebius/ \
    VAPID_SUBJECT=mailto:hello@mandat.app
EXPOSE 7860
CMD ["node", "start.mjs"]
