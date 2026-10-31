#!/bin/sh
# The supervisor's user and the advisors' users, in the supervisor image and in the one-container
# rig image (containers/Containerfile, containers/rig/Containerfile), each run with this folder
# mounted for that step only, from the build-scripts stage. The supervisor's user needs a passwd entry: ssh (git over SSH)
# refuses a uid without one, and finds ~/.ssh from the entry's home, not from $HOME. Each
# advisor's program runs as one of the advisor users, advisor-1..advisor-8 (uid and gid
# 10081..10088, src/core/advisor-runs.ts), one for each call while it runs, in none of the
# supervisor's groups. The broker's table has the supervisor's ids (src/harness/broker/runner.ts).
set -eu
groupadd -g 10001 supervisor
useradd -u 10001 -g 10001 -M -d /var/lib/thermite-supervisor/home -s /usr/sbin/nologin supervisor
for n in $(seq 1 8); do
  groupadd -g $((10080 + n)) advisor-$n
  useradd -u $((10080 + n)) -g advisor-$n -M -d /nonexistent -s /usr/sbin/nologin advisor-$n
done
