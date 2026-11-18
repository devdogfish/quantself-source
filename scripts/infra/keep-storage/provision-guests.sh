#!/usr/bin/env bash
# Run as root on Keep only after named #217 approval. Never deletes/replaces VMs.
set -euo pipefail
[[ $(hostname -s) == keep && $EUID -eq 0 ]] || { echo 'Run as root on Keep'; exit 1; }
[[ ${KEEP_254_APPROVED:-} == 'files-and-quantself' ]] || { echo 'Named Owner approval required'; exit 1; }
guest_dns=${KEEP_GUEST_DNS_IPV4:-}
if [[ ! $guest_dns =~ ^(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])(\.(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$ ]]; then
  echo 'Required guest resolver missing or invalid (1)' >&2
  exit 1
fi
files_mac=${KEEP_FILES_MAC:-}
quantself_mac=${KEEP_QUANTSELF_MAC:-}
mac_pattern='^[0-9a-fA-F][02468aAcCeE](:[0-9a-fA-F]{2}){5}$'
if [[ ! $files_mac =~ $mac_pattern || ! $quantself_mac =~ $mac_pattern ||
      ! $files_mac =~ [1-9a-fA-F] || ! $quantself_mac =~ [1-9a-fA-F] ]]; then
  echo 'Required guest MACs missing or invalid (1)' >&2
  exit 1
fi
files_mac=$(printf '%s' "$files_mac" | LC_ALL=C tr 'A-F' 'a-f')
quantself_mac=$(printf '%s' "$quantself_mac" | LC_ALL=C tr 'A-F' 'a-f')
if [[ $files_mac == "$quantself_mac" ]]; then
  echo 'Required guest MACs must be distinct (1)' >&2
  exit 1
fi
image=/var/lib/vz/template/keep-storage-254/debian-13-genericcloud-amd64.qcow2
seed=/var/lib/vz/snippets/keep-storage-254-user.yaml
[[ -f $image && -f $seed && -c /dev/kvm ]]
grep -q "^hostname: __VM_HOSTNAME__$" "$seed" || { echo "Render the current cloud-init template with the Owner public key first"; exit 1; }
# Both IDs must be unused; an interrupted run needs inspection, never blind replay.
for id in 2540 2541; do
  [[ ! -e /etc/pve/qemu-server/$id.conf && ! -e /etc/pve/lxc/$id.conf ]] || { echo "VM ID $id already exists; inspect before continuing"; exit 1; }
done
for spec in "2540 files 2048 40 $files_mac 10" "2541 quantself 4096 32 $quantself_mac 20"; do
  read -r id name memory disk mac order <<< "$spec"
  [[ $name == files || $name == quantself ]]
  sed "s/__VM_HOSTNAME__/$name/g" "$seed" > "/var/lib/vz/snippets/keep-storage-254-$name.yaml"
  chmod 600 "/var/lib/vz/snippets/keep-storage-254-$name.yaml"
  qm create "$id" --name "$name" --memory "$memory" --balloon 0 --cores 2 --cpu host \
    --ostype l26 --scsihw virtio-scsi-single --agent enabled=1 --onboot 1 \
    --startup "order=$order,up=30" --serial0 socket --vga serial0 \
    --net0 "virtio=$mac,bridge=vmbr0" --ipconfig0 ip=dhcp --nameserver "$guest_dns" --searchdomain home \
    --cicustom "user=local:snippets/keep-storage-254-$name.yaml"
  qm importdisk "$id" "$image" local-lvm
  qm set "$id" --scsi0 "local-lvm:vm-$id-disk-0,discard=on,ssd=1,iothread=1" \
    --ide2 local-lvm:cloudinit --boot order=scsi0
  qm disk resize "$id" scsi0 "${disk}G"
  qm start "$id"
done
qm list
