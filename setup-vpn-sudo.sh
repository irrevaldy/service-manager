#!/bin/bash
set -e
RULE='sociolla ALL=(ALL) NOPASSWD: /opt/homebrew/sbin/openvpn, /usr/local/sbin/openvpn'
echo "$RULE" > /etc/sudoers.d/ssm-openvpn
chmod 440 /etc/sudoers.d/ssm-openvpn
visudo -c -f /etc/sudoers.d/ssm-openvpn && echo "sudoers OK" || echo "FAILED"
