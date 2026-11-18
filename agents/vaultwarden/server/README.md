# Vaultwarden server on Keep

[#376](https://github.com/devdogfish/quantself/issues/376) uses the dedicated
Debian 13 guest `2549` on Keep. The approved allocation is one vCPU, 1 GiB RAM,
and an 8 GiB disk on Keep's encrypted storage. Follow
[#217](https://github.com/devdogfish/quantself/issues/217) and obtain the Owner's
named yes for each machine or Tailscale change.

1. Apply and verify Keep's `vmbr2549` outbound NAT and firewall. The bridge
   uses the approved gateway IPv4 address. Attach only VM 2549 at the approved
   guest IPv4 address. Both use a `/30` prefix. Stage
   [cloud-init.yaml](cloud-init.yaml) as a Keep snippet. Boot with the QEMU guest
   agent enabled. Confirm cloud-init completion, the guest firewall and
   installation of Docker Compose through the guest agent.
2. Install Tailscale and enroll with `tag:vaultwarden` after the Owner approves
   the policy. Merge the approved deployment-specific Vaultwarden policy fragment
   into the live policy after reviewing existing rules for broader matches.
   Run the policy tests before saving. The fragment grants the two approved
   Owner devices and `tag:agent` TCP 443.
   Keep route acceptance, Tailscale SSH and Funnel disabled. Test that an
   unrelated peer cannot reach the vault and the guest cannot initiate
   a connection to another tailnet node.
3. Install [compose.yaml](compose.yaml) in the guest. Set `VAULTWARDEN_ORIGIN`
   to the actual private HTTPS origin and run `docker compose up -d`. Verify
   `http://127.0.0.1:18080/alive` in the guest. Publish TCP 443 on the tailnet
   using Tailscale Serve to that loopback listener. Check TLS, the approved
   peer paths, and failed access over the LAN.
4. Complete the [backup and restore checks](backup.md) before the Owner enters
   live credentials. Retain the encrypted PBS and B2 restore receipts.
5. The Owner sets up the Owner account, organization and Agent invitations
   through the approved private credential handoff. Keep public signup
   disabled and verify sharing and revocation with fake credentials.

## Keep bridge

With VM 2549 stopped and the named approval for Keep networking, stage the
approved private `keep.interfaces` and `keep.nft` together outside the checkout.
Set `VAULTWARDEN_KEEP_NETWORK_DIR` to that directory's absolute path. Run from
the server manifest directory on Keep:

```sh
(
  set -eu
  : "${VAULTWARDEN_KEEP_NETWORK_DIR:?Set the approved private network directory}"
  case "$VAULTWARDEN_KEEP_NETWORK_DIR" in
    /*) ;;
    *) printf '%s\n' 'The private network directory must be an absolute path.' >&2; exit 1 ;;
  esac
  private_interfaces="$VAULTWARDEN_KEEP_NETWORK_DIR/keep.interfaces"
  private_firewall="$VAULTWARDEN_KEEP_NETWORK_DIR/keep.nft"
  test -f "$private_interfaces" && test -r "$private_interfaces" &&
    test -f "$private_firewall" && test -r "$private_firewall" || {
      printf '%s\n' 'Both approved private network files are required.' >&2
      exit 1
    }
  sudo install -d -m 0700 /etc/vaultwarden-2549
  sudo install -m 0600 "$private_firewall" /etc/vaultwarden-2549/keep.nft
  sudo install -m 0600 refresh-home-wan.py /etc/vaultwarden-2549/
  sudo /usr/bin/python3 -I /etc/vaultwarden-2549/refresh-home-wan.py --seed
  sudo nft --check --file /etc/vaultwarden-2549/keep.nft
  sudo ifup --syntax-check -i "$private_interfaces" vmbr2549
  sudo install -m 0644 "$private_interfaces" /etc/network/interfaces.d/vaultwarden-2549
  sudo ifup vmbr2549
  sudo install -m 0644 vaultwarden-2549-wan.service vaultwarden-2549-wan.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now vaultwarden-2549-wan.timer
)
```

Verify the bridge address, the `vaultwarden_2549` nftables table, and the timer.
Check that VM 2549 remains stopped and detached. A failure before boot leaves
the VM disconnected. For approved rollback, disable the timer, take down only
`vmbr2549`, move its interface file out of `interfaces.d`, and remove only
the `inet vaultwarden_2549` table.

## VM 2549 first boot

Use the [infrastructure session workflow](../../../docs/agents/infrastructure-sessions.md#execute-and-resume)
and keep the operation journal with the private #376 evidence. Before making
changes, record the approval, Keep node, VMID, original disk volume, snippet
SHA-256, intended NIC and boot settings, and the start time for the phase.

With the named approval to attach and boot VM 2549, confirm the VM is stopped,
has no NIC or cloud-init disk, and still has its original 8 GiB disk. Confirm
`vmbr2549` is up with no attached ports and its firewall is loaded. From the
server manifest directory on Keep, set the three variables below from the
approved private NIC settings. Supply both IPv4 addresses without the prefix.

```sh
: "${VAULTWARDEN_GUEST_MAC:?Set the approved guest MAC}"
: "${VAULTWARDEN_GUEST_IPV4:?Set the approved guest IPv4 address}"
: "${VAULTWARDEN_GATEWAY_IPV4:?Set the approved gateway IPv4 address}"
sudo test ! -e /var/lib/vz/snippets/vaultwarden-2549-user.yaml
sudo install -m 0644 cloud-init.yaml /var/lib/vz/snippets/vaultwarden-2549-user.yaml
sudo qm set 2549 --net0 "virtio=$VAULTWARDEN_GUEST_MAC,bridge=vmbr2549" \
  --ipconfig0 "ip=$VAULTWARDEN_GUEST_IPV4/30,gw=$VAULTWARDEN_GATEWAY_IPV4" \
  --nameserver '1.1.1.1 9.9.9.9' --ide2 local-lvm:cloudinit \
  --cicustom user=local:snippets/vaultwarden-2549-user.yaml \
  --agent enabled=1 --onboot 0
sudo qm config 2549
sudo qm cloudinit dump 2549 network
```

Record the verified configuration and boot intent before issuing
`sudo qm start 2549`. Record the Proxmox `qmstart` UPID as soon as it is
available. If the command returns without a UPID or the connection drops,
match Keep's task history by VMID, task type and dispatch time, and check
`qm status 2549` and the current VM configuration. If snippet staging or
VM configuration was interrupted, compare the existing snippet checksum
and VM configuration with the journal before resuming. Leave ambiguous
tasks or conflicting configuration for reconciliation before any retry.

After the original start task succeeds, wait for `qm guest cmd 2549 ping`,
then inspect `cloud-init status`
through QEMU guest exec. Verify Debian 13, Docker Compose, the guest firewall
unit, masked SSH, the static IPv4 address and the default route. Check HTTPS
egress to the Debian mirror, then check that connections to Keep's LAN
management address and the LAN gateway time out. Confirm the matching drops
in Keep's firewall counters. Record the UPID, exit status, guest checks,
and any failed attempts before continuing
to the separately approved Tailscale phase.
