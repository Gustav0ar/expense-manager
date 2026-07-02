#!/usr/bin/env bash
# Set up a dedicated deploy user for the GitHub Actions deploy workflow.
#
# Run this as root on the VPS.
#
# Usage:
#   sudo ./setup-vps-deploy-user.sh
#   sudo ./setup-vps-deploy-user.sh /custom/path expense-manager-deploy

set -euo pipefail

DEPLOY_PATH="${1:-/opt/expense-manager}"
DEPLOY_USER="${2:-expense-manager-deploy}"

case "${DEPLOY_PATH}" in
	/mnt/* | /opt/* | /var/*) ;;
	*)
		echo "DEPLOY_PATH must be under /mnt/, /opt/, or /var/: ${DEPLOY_PATH}" >&2
		exit 1
		;;
esac

echo ">> Setting up deploy user '${DEPLOY_USER}' for path '${DEPLOY_PATH}'"

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
	useradd \
		--system \
		--shell /bin/bash \
		--home-dir "/var/lib/${DEPLOY_USER}" \
		--comment "Expense Manager deploy user" \
		"${DEPLOY_USER}"
	echo "   created user ${DEPLOY_USER}"
else
	usermod \
		--home "/var/lib/${DEPLOY_USER}" \
		--shell /bin/bash \
		"${DEPLOY_USER}"
	echo "   user ${DEPLOY_USER} already exists; ensured home and shell"
fi

mkdir -p "/var/lib/${DEPLOY_USER}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "/var/lib/${DEPLOY_USER}"
chmod 750 "/var/lib/${DEPLOY_USER}"

mkdir -p "${DEPLOY_PATH}/scripts" "${DEPLOY_PATH}/docker/postgres"
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_PATH}"
chmod 750 "${DEPLOY_PATH}" "${DEPLOY_PATH}/scripts" "${DEPLOY_PATH}/docker" "${DEPLOY_PATH}/docker/postgres"

install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
	"/var/lib/${DEPLOY_USER}/.ssh"

if [ ! -f "/var/lib/${DEPLOY_USER}/.ssh/id_ed25519" ]; then
	sudo -u "${DEPLOY_USER}" ssh-keygen \
		-t ed25519 \
		-N "" \
		-C "${DEPLOY_USER}@$(hostname)" \
		-f "/var/lib/${DEPLOY_USER}/.ssh/id_ed25519"
	echo "   generated SSH keypair"
else
	echo "   SSH keypair already exists; skipping"
fi

AUTHORIZED_KEYS="/var/lib/${DEPLOY_USER}/.ssh/authorized_keys"
touch "${AUTHORIZED_KEYS}"
chmod 600 "${AUTHORIZED_KEYS}"

PUBKEY="$(cat "/var/lib/${DEPLOY_USER}/.ssh/id_ed25519.pub")"
PUBKEY_BODY="$(printf '%s' "${PUBKEY}" | awk '{print $2}')"
TMP_AUTHORIZED_KEYS="$(mktemp)"
grep -vF "${PUBKEY_BODY}" "${AUTHORIZED_KEYS}" > "${TMP_AUTHORIZED_KEYS}" || true
cat "${TMP_AUTHORIZED_KEYS}" > "${AUTHORIZED_KEYS}"
rm -f "${TMP_AUTHORIZED_KEYS}"
printf '%s\n' "${PUBKEY}" >> "${AUTHORIZED_KEYS}"
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "/var/lib/${DEPLOY_USER}/.ssh"
chmod 700 "/var/lib/${DEPLOY_USER}/.ssh"
chmod 600 "${AUTHORIZED_KEYS}"
echo "   installed public key in authorized_keys"

if ! getent group docker >/dev/null; then
	groupadd docker
fi
usermod -aG docker "${DEPLOY_USER}"
echo "   added ${DEPLOY_USER} to the docker group"

install -d -m 0700 /root/.ssh-key-handoff
cp "/var/lib/${DEPLOY_USER}/.ssh/id_ed25519" "/root/.ssh-key-handoff/${DEPLOY_USER}.key"
chmod 600 "/root/.ssh-key-handoff/${DEPLOY_USER}.key"
chown root:root "/root/.ssh-key-handoff/${DEPLOY_USER}.key"

cat <<EOF

================================================================================
  Setup complete
================================================================================

  Deploy user : ${DEPLOY_USER}
  Deploy path : ${DEPLOY_PATH}
  SSH key     : /root/.ssh-key-handoff/${DEPLOY_USER}.key

Next steps:

  1. Copy the private key into the GitHub production environment secret:

       cat /root/.ssh-key-handoff/${DEPLOY_USER}.key

     Secret names:
       VPS_HOST
       VPS_USERNAME=${DEPLOY_USER}
       VPS_PORT=22
       VPS_SSH_KEY=<private key contents>

  2. Create the Traefik network if it does not exist:

       docker network create web 2>/dev/null || true

  3. Create ${DEPLOY_PATH}/.env with production values from DEPLOY.md.

  4. Set the production environment variable:

       DEPLOY_PATH=${DEPLOY_PATH}

================================================================================
EOF
