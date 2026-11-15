#!/bin/sh
# Starts Seeker as PUID:PGID, 1000:1000 unless set. When the container starts as root (the default),
# it first gives Seeker's data folder to that user. That also covers rootless Docker, where users in
# the container are other users on the host. When the container starts as another user (--user, or
# user: in Compose), Seeker runs as that user and the folder is left as it is.
# With rootless Docker, PUID=1000 can give a bind-mounted /data to host uid 100999: host-side
# restoration then needs sudo. PUID=0/PGID=0 keeps it owned by the user running rootless Docker.
set -eu

if [ -n "${UMASK:-}" ]; then
  case "$UMASK" in
    [0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) umask "$UMASK" ;;
    *)
      echo "UMASK must be an octal number such as 022 or 002, not \"$UMASK\"." >&2
      exit 1
      ;;
  esac
fi

if [ "$(id -u)" = 0 ]; then
  uid="${PUID:-1000}"
  gid="${PGID:-1000}"
  case "$uid" in '' | *[!0-9]*)
    echo "PUID must be a number, such as 1000, not \"$uid\"." >&2
    exit 1
    ;;
  esac
  case "$gid" in '' | *[!0-9]*)
    echo "PGID must be a number, such as 1000, not \"$gid\"." >&2
    exit 1
    ;;
  esac
  data="${SEEKER_DATA_DIR:-/data}"
  mkdir -p "$data" 2>/dev/null || true
  # Only Seeker's own folder: the music, downloads and import folders can be large network shares,
  # and who owns them is up to you. Anything that already belongs to the user is left alone.
  if ! find "$data" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown -h "$uid:$gid" {} + 2>/dev/null; then
    echo "Couldn't give $data to user $uid and group $gid. Seeker will say what's wrong if it can't use the folder." >&2
  fi
  if [ "$uid" != 0 ]; then
    exec su-exec "$uid:$gid" "$@"
  fi
fi
exec "$@"
