#!/bin/sh
# No set-id file anywhere, as in every Thermite image: no process in the container can gain
# privileges through a setuid or setgid program. Each image's last step runs it, after every
# package (containers/Containerfile, containers/rig/Containerfile), with this folder mounted for
# that step only; the build fails if a set-id file is left.
set -eu
find / -xdev -type f -perm /6000 -exec chmod ug-s {} +
test -z "$(find / -xdev -type f -perm /6000 -print -quit)"
