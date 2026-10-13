# turri in a container - docker/README.md has the build and the run, from the root of the clone.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash bubblewrap ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# turri runs the code it regenerates - the testing scripts, the apps it releases - in this container, so install here the
# toolchains your projects use, for example:
# RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv openjdk-17-jdk golang \
#  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/turri
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm link

RUN mkdir /work && chown node:node /work
COPY docker/entrypoint.sh /usr/local/bin/turri-entrypoint
WORKDIR /work
# Starts as root only to take the uid of the folder mounted at /work, then runs turri as that user.
ENTRYPOINT ["turri-entrypoint"]
