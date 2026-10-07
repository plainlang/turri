#!/bin/sh
# Starts turri as the user who owns the project folder mounted at /work, so what it writes there is that user's -
# whatever their uid on a Linux host; Docker Desktop's mounts (macOS, Windows) show as root or as the user already.
# Not root: bubblewrap, the OS sandbox, starts only for an unprivileged user in a container.
set -e

if [ "$(id -u)" != 0 ]; then
  exec turri "$@"   # started with --user: run as that user
fi

uid=$(stat -c %u /work)
gid=$(stat -c %g /work)
if [ "$uid" != 0 ] && [ "$uid" != "$(id -u node)" ]; then
  groupmod -o -g "$gid" node
  usermod -o -u "$uid" -g "$gid" node
fi

export HOME=/home/node USER=node
exec setpriv --reuid=node --regid=node --init-groups turri "$@"
