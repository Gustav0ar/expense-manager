#!/usr/bin/env bash
# Prepares the deploy key and a fingerprint-pinned known_hosts file for the
# production deploy and rollback workflows. All required values are supplied by
# the GitHub Actions environment; do not log their contents.

set -euo pipefail

for name in VPS_HOST VPS_USERNAME VPS_PORT VPS_SSH_KEY VPS_SSH_HOST_FINGERPRINT SSH_KEY_FILE KNOWN_HOSTS_FILE; do
	if [ -z "${!name:-}" ]; then
		echo "::error::${name} is not set in the production environment."
		exit 1
	fi
done

install -m 700 -d "$(dirname "${SSH_KEY_FILE}")" "${HOME}/.ssh"
printf '%s\n' "${VPS_SSH_KEY}" | sed 's/\r$//' > "${SSH_KEY_FILE}"
chmod 600 "${SSH_KEY_FILE}"

if ! ssh-keygen -y -f "${SSH_KEY_FILE}" >/dev/null 2>&1; then
	echo "::error::VPS_SSH_KEY is not a parseable private SSH key."
	exit 1
fi

key_fingerprint="$(ssh-keygen -lf "${SSH_KEY_FILE}" | awk '{print $2}')"
echo "SSH key fingerprint: ${key_fingerprint}"

scan_file="$(mktemp)"
candidate_file="$(mktemp)"
trap 'rm -f "${scan_file}" "${candidate_file}"' EXIT

ssh-keyscan -T 15 -p "${VPS_PORT}" "${VPS_HOST}" > "${scan_file}" 2>/dev/null
: > "${KNOWN_HOSTS_FILE}"
while IFS= read -r host_key; do
	printf '%s\n' "${host_key}" > "${candidate_file}"
	candidate_fingerprint="$(ssh-keygen -lf "${candidate_file}" -E sha256 | awk '{print $2}')"
	if [ "${candidate_fingerprint}" = "${VPS_SSH_HOST_FINGERPRINT}" ]; then
		printf '%s\n' "${host_key}" >> "${KNOWN_HOSTS_FILE}"
	fi
done < "${scan_file}"

if [ ! -s "${KNOWN_HOSTS_FILE}" ]; then
	echo "::error::No scanned VPS host key matched VPS_SSH_HOST_FINGERPRINT."
	exit 1
fi
chmod 600 "${KNOWN_HOSTS_FILE}"

# Match appleboy/ssh-action's Go SSH client so both steps pin the same key.
ssh -i "${SSH_KEY_FILE}" \
	-o BatchMode=yes \
	-o IdentitiesOnly=yes \
	-o HostKeyAlgorithms=ecdsa-sha2-nistp256 \
	-o StrictHostKeyChecking=yes \
	-o UserKnownHostsFile="${KNOWN_HOSTS_FILE}" \
	-o ConnectTimeout=15 \
	-p "${VPS_PORT}" \
	"${VPS_USERNAME}@${VPS_HOST}" \
	true
