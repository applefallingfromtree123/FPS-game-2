#!/usr/bin/env bash
# One-shot setup for an Oracle Cloud "Always Free" VM (Ubuntu 22.04/24.04, ARM or x86).
# Usage on the VM:  curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/<branch>/deploy/oracle-setup.sh | bash -s -- https://github.com/<you>/<repo>.git <branch>
set -euo pipefail
REPO="${1:?git repository URL required}"
BRANCH="${2:-main}"
PORT=80

sudo apt-get update -y
sudo apt-get install -y docker.io git
sudo systemctl enable --now docker

# Oracle's Ubuntu images block inbound ports with iptables by default
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport ${PORT} -j ACCEPT || true
sudo netfilter-persistent save 2>/dev/null || true

rm -rf ~/warfield
git clone --depth 1 -b "$BRANCH" "$REPO" ~/warfield
cd ~/warfield
sudo docker build -t warfield .
sudo docker rm -f warfield 2>/dev/null || true
sudo docker run -d --name warfield --restart unless-stopped -p ${PORT}:8000 warfield

echo "WARFIELD is running: http://$(curl -s ifconfig.me)/"
echo "Remember to also open TCP port ${PORT} in the VCN Security List (Oracle console)."
