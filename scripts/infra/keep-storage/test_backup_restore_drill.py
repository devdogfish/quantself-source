import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
import unittest
from unittest.mock import patch

from backup_guest import BackupError, GIB, PRODUCTION_APP, read_json, write_json
from backup_restore_drill import (ANALYTICS_POSTGRES, CLOUDINIT, CONTAINERS, Drill, POSTGRES,
                                  NATIVE_CONTAINERS, NATIVE_MIGRATIONS, NATIVE_OCR,
                                  NATIVE_REHEARSAL, POLICY, PRODUCTION_CONTAINERS,
                                  PRODUCTION_POSTGRES, require_memory_reserve, verify_source_hardware)


class Host:
    node = "keep"

    def __init__(self, root):
        self.root = root


class DrillTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.drill = Drill(Host(self.root))

    def test_memory_reserve_admits_reclaimable_cache_and_exact_boundary(self):
        meminfo = self.root / "meminfo"
        for available_kib in (7780 * 1024, 3 * 1024 ** 2):
            with self.subTest(available_kib=available_kib):
                meminfo.write_text(
                    f"MemFree:       1198080 kB\n"
                    f"MemAvailable:\t{available_kib} kB\n"
                    "Cached:        6863872 kB\n",
                    encoding="ascii",
                )
                require_memory_reserve(meminfo)

    def test_memory_reserve_rejects_one_kib_below_threshold(self):
        meminfo = self.root / "meminfo"
        meminfo.write_text("MemFree: 1198080 kB\nMemAvailable: 3145727 kB\nCached: 6863872 kB\n",
                           encoding="ascii")
        with self.assertRaisesRegex(BackupError, "Keep memory reserve is too low"):
            require_memory_reserve(meminfo)

    def test_memory_reserve_fails_closed_on_missing_or_invalid_available_memory(self):
        meminfo = self.root / "meminfo"
        error = "Keep MemAvailable could not be verified"
        with self.assertRaisesRegex(BackupError, error):
            require_memory_reserve(meminfo)

        for field in (b"", b"MemAvailable: unknown kB\n", b"MemAvailable: -4194304 kB\n",
                      b"MemAvailable: 4194304 MB\n", b"MemAvailable: 4194304\n",
                      b"MemAvailable 4194304 kB\n", b"MemAvailable: 4194304 kB extra\n",
                      b"MemAvailable: \xff kB\n",
                      b"MemAvailable: 4194304 kB\nMemAvailable: 4194304 kB\n"):
            with self.subTest(field=field):
                meminfo.write_bytes(b"MemFree: 4194304 kB\n" + field)
                with self.assertRaisesRegex(BackupError, error):
                    require_memory_reserve(meminfo)

    def test_uncertain_previous_restore_blocks_new_attempt(self):
        write_json(self.root / "postgres-restore-active.json", {"phase": "restore_requested"})
        with patch.object(self.drill, "admit") as admit, patch("backup_restore_drill.command") as run:
            with self.assertRaisesRegex(BackupError, "requires reconciliation"):
                self.drill.run(True)
        admit.assert_not_called()
        run.assert_not_called()

    def test_restore_submits_atomic_autostart_overrides_then_polls_exact_task(self):
        journal = self.root / "postgres-restore-active.json"
        record = {"volume": "backup-restore-254:backup/vm/2541/2026-11-14T05:12:23Z"}
        upid = "UPID:keep:ABCD:1234:FFFF:qmrestore:2544:root@pam:"

        def launch(binary, method, path, *args, timeout):
            self.assertEqual(read_json(journal)["phase"], "restore_requested")
            self.assertEqual((binary, method, path), ("pvesh", "create", "/nodes/keep/qemu"))
            self.assertIsNone(timeout)
            self.assertEqual(args, ("--archive", record["volume"], "--vmid", "2544",
                                    "--storage", "local-lvm", "--unique", "1", "--start", "0",
                                    "--onboot", "0", "--autostart", "0", "--output-format", "json"))
            return f'restore progress 100%\n"{upid}"\n'

        def observe(path):
            self.assertEqual(read_json(journal)["upid"], upid)
            self.assertEqual(path, f"/nodes/keep/tasks/{upid}/status")
            return {"status": "stopped", "exitstatus": "OK"}

        with patch("backup_restore_drill.command", side_effect=launch), \
             patch.object(self.drill, "get", side_effect=observe):
            self.assertEqual(self.drill.restore(journal, record), upid)

    def test_restore_pending_or_failed_never_boots_or_resubmits(self):
        for status, times in (({"status": "running"}, [0, 0, 2101]),
                              ({"status": "stopped", "exitstatus": "ERROR"}, [0, 0])):
            with self.subTest(status=status), patch.object(self.drill, "admit", return_value=(
                {"restore_id": "20261114T051223Z-13081903ae4c",
                 "offsite": {"quantself": {"manifest": {}}}},
                "backup-restore-254:backup/vm/2541/2026-11-14T05:12:23Z",
                32,
            )), patch("backup_restore_drill.command",
                             return_value="UPID:keep:ABCD:1234:FFFF:qmrestore:2544:root@pam:") as run, \
                 patch.object(self.drill, "get", return_value=status), \
                 patch("backup_restore_drill.time.monotonic", side_effect=times), \
                 patch("backup_restore_drill.time.sleep"):
                with self.assertRaisesRegex(BackupError, "Original restore task"):
                    self.drill.run(True)
                run.assert_called_once()
                active = self.root / "postgres-restore-active.json"
                self.assertEqual(read_json(active)["phase"], "restore_observing")
                active.unlink()

    def test_restore_rejects_ambiguous_or_wrong_vm_task_output(self):
        journal = self.root / "postgres-restore-active.json"
        record = {"volume": "backup-restore-254:backup/vm/2541/2026-11-14T05:12:23Z"}
        upid = "UPID:keep:ABCD:1234:FFFF:qmrestore:2544:root@pam:"
        wrong = upid.replace(":2544:", ":2543:")
        for output in (wrong, f'{upid}\n"{wrong}"', f'"{upid}', f'log {upid}'):
            with self.subTest(output=output), patch("backup_restore_drill.command", return_value=output), \
                 patch.object(self.drill, "get") as observe:
                with self.assertRaisesRegex(BackupError, "task identity"):
                    self.drill.restore(journal, record)
                observe.assert_not_called()
                self.assertEqual(read_json(journal)["phase"], "restore_requested")

    def test_archive_with_extra_disk_is_rejected_before_restore_allocation(self):
        config = ("boot: order=scsi0\nscsi0: local-lvm:vm-2541-disk-0,size=32G\n"
                  "ide2: local-lvm:vm-2541-cloudinit,media=cdrom\nonboot: 1\n")
        verify_source_hardware(config, 32)
        with self.assertRaisesRegex(BackupError, "unexpected hardware"):
            verify_source_hardware(config + "scsi1: local-lvm:vm-2541-disk-1,size=40G\n", 32)

    def test_no_nic_gate_rejects_unexpected_hardware_and_foreign_disk(self):
        base = {"scsi0": "local-lvm:vm-2544-disk-0,size=32G", "boot": "order=scsi0",
                "ide2": CLOUDINIT + ",media=cdrom,size=4M"}
        self.assertEqual(self.drill.disks(base, 32), {"local-lvm:vm-2544-disk-0", CLOUDINIT})
        for change in ({"net0": "virtio,bridge=vmbr0"}, {"hostpci0": "fixture"},
                       {"scsi0": "local-lvm:vm-2541-disk-0,size=32G"},
                       {"ide2": "local-lvm:vm-2541-cloudinit,media=cdrom"},
                       {"unused0": "local-lvm:vm-2544-disk-1"}):
            with self.subTest(change=change), self.assertRaises(BackupError):
                self.drill.disks({**base, **change}, 32)

    def test_admission_binds_52_gib_archive_rehearsal_and_physical_reserve(self):
        restore_id = "20261117T070753Z-44b2c260a89a"
        fingerprint = ":".join(["aa"] * 32)
        images = {service: f"{service}-image" for service in PRODUCTION_APP}
        pair = {"format": 1, "restore_id": restore_id,
                "completed_at": datetime.now(timezone.utc).isoformat(), "offsite": {}, "pbs": {}}
        for role, vmid, char in (("quantself", 2541, "a"), ("files", 2540, "b")):
            pair["pbs"][role] = {
                "volid": f"backup:backup/vm/{vmid}/2026-11-17T07:08:00Z",
                "encryption_fingerprint": fingerprint,
            }
            pair["offsite"][role] = {"snapshot": char * 64, "repository": char * 64, "manifest": {
                "format": 1, "restore_id": restore_id, "role": role, "inventory_sha256": char * 64,
            }}
        pair["offsite"]["quantself"]["manifest"].update(
            profile="production-native", images=images, schema_migrations=sorted(NATIVE_MIGRATIONS),
        )
        policy = {"format": 2, "vmid": 2544, "storage": "local-lvm", "pbs_alias": "backup-restore-254",
                  "allow_cleanup": True, "system_disk_gib": 52}
        rehearsal = {"format": 2, "system_disk_gib": 52, "profile": "production-native",
                     "postgres_image": images["postgres"], "pbs_encryption_fingerprint": fingerprint,
                     "full_restore_verified": True, "postgres_only_no_nic_verified": True,
                     "production_native_no_nic_verified": True}
        state = {self.root / "last-success.json": pair, self.root / "runs" / restore_id / "complete.json": pair,
                 POLICY: policy, NATIVE_REHEARSAL: rehearsal}
        alias = "backup-restore-254"
        volume = f"{alias}:backup/vm/2541/2026-11-17T07:08:00Z"
        storage = {"active": True, "avail": 72 * GIB}
        reads = {
            "/cluster/resources": [], "/cluster/ha/resources": [], "/nodes/keep/storage/local-lvm/content": [],
            "/storage/backup": {"server": "fixture", "datastore": "main"},
            f"/storage/{alias}": {"type": "pbs", "server": "fixture", "datastore": "main",
                                  "encryption-key": fingerprint},
            f"/nodes/keep/storage/{alias}/content": [{"volid": volume, "encrypted": fingerprint}],
            "/nodes/keep/storage/local-lvm/status": storage,
        }
        archive = ["boot: order=scsi0\nscsi0: local-lvm:vm-2541-disk-0,size=52G\n"
                   "ide2: local-lvm:vm-2541-cloudinit,media=cdrom\n"]

        def command(*args):
            if args == ("pvesm", "extractconfig", volume):
                return archive[0]
            self.assertEqual(args, ("lvs", "--reportformat", "json", "-o", "metadata_percent", "keep-vg/data"))
            return json.dumps({"report": [{"lv": [{"metadata_percent": "12"}]}]})

        with (
            patch("backup_restore_drill.state_file", side_effect=state.__getitem__),
            patch.object(self.drill, "get", side_effect=lambda path, *_: reads[path]),
            patch("backup_restore_drill.check_pbs_key") as check_key,
            patch("backup_restore_drill.require_memory_reserve"),
            patch("backup_restore_drill.command", side_effect=command),
        ):
            self.assertEqual(self.drill.admit(), (pair, volume, 52))
            check_key.assert_called_once_with(Path(f"/etc/pve/priv/storage/{alias}.enc"))
            for available in (72 * GIB - 1, 3914 * GIB // 100):
                with self.subTest(available=available), patch.dict(storage, avail=available):
                    with self.assertRaisesRegex(BackupError, "Thin-pool restore reserve"):
                        self.drill.admit()
            original = archive[0]
            for size in ("size=44G", "size=52G,size=44G"):
                with self.subTest(size=size):
                    archive[0] = original.replace("size=52G", size)
                    with self.assertRaisesRegex(BackupError, "approved disk and boot scope"):
                        self.drill.admit()
            archive[0] = original
            with patch.dict(rehearsal, system_disk_gib=44):
                with self.assertRaisesRegex(BackupError, "no-NIC PostgreSQL rehearsal"):
                    self.drill.admit()
            legacy_policy = {key: value for key, value in policy.items() if key != "system_disk_gib"}
            legacy_rehearsal = {key: value for key, value in rehearsal.items() if key != "system_disk_gib"}
            with patch.dict(state, {POLICY: {**legacy_policy, "format": 1},
                                    NATIVE_REHEARSAL: {**legacy_rehearsal, "format": 1}}):
                with self.assertRaisesRegex(BackupError, "approved disk and boot scope"):
                    self.drill.admit()

    def test_qga_accepts_empty_success_but_rejects_failed_or_invalid_output(self):
        cases = (
            ('{"exited": true, "exitcode": 0}', ""),
            ('{"exited": true, "exitcode": 0, "out-data": " result "}', "result"),
            ('{"exited": true, "exitcode": 1}', None),
            ('{"exited": true, "exitcode": 0, "out-data": null}', None),
        )
        for reply, expected in cases:
            with self.subTest(reply=reply), patch("backup_restore_drill.command", return_value=reply):
                if expected is None:
                    with self.assertRaises(BackupError):
                        self.drill.qga("/usr/bin/test", "-f", "/etc/cloud/cloud-init.disabled")
                else:
                    self.assertEqual(self.drill.qga("/usr/bin/test", "-f", "/etc/cloud/cloud-init.disabled"),
                                     expected)

    def test_unexpected_container_stops_verification_before_sql(self):
        with patch.object(self.drill, "qga", return_value=POSTGRES + "\nkeep-quantself-api-1") as qga:
            with self.assertRaisesRegex(BackupError, "Unexpected running container"):
                self.drill.postgres("image", ["expected"])
        qga.assert_called_once()

    def test_same_count_but_wrong_migration_fails(self):
        responses = [POSTGRES, "image", "", 'BEGIN\n1\n["other"]\n2\nCOMMIT']
        with patch.object(self.drill, "qga", side_effect=responses), \
             patch.object(self.drill, "verify_containers") as inspect:
            with self.assertRaisesRegex(BackupError, "schema check differs"):
                self.drill.postgres("image", ["expected"])
        inspect.assert_not_called()

    def test_stopped_application_with_always_restart_policy_fails(self):
        rows = [f"/{name} {state} {policy}" for name, (state, policy) in CONTAINERS.items()]
        altered = [row.replace("unless-stopped", "always") if "-api-1 " in row else row for row in rows]
        with patch.object(self.drill, "qga", side_effect=["\n".join(CONTAINERS), "\n".join(rows)]):
            self.drill.verify_containers()
        with patch.object(self.drill, "qga", side_effect=["\n".join(CONTAINERS), "\n".join(altered)]):
            with self.assertRaisesRegex(BackupError, "restart policy"):
                self.drill.verify_containers()

    def test_production_drill_queries_both_databases_and_verifies_exact_restart_state(self):
        running = PRODUCTION_POSTGRES + "\n" + ANALYTICS_POSTGRES
        queries = [running, "app-image", "analytics-image", "", 'BEGIN\n1\n["one"]\n2\nCOMMIT',
                   "", "BEGIN\n2\nt\nCOMMIT", running]
        images = {"postgres": "app-image", "analytics-postgres": "analytics-image"}
        with patch.object(self.drill, "qga", side_effect=queries) as qga, \
             patch.object(self.drill, "verify_containers") as inspect:
            self.drill.production_postgres(images, ["one"])
        inspect.assert_called_once_with(PRODUCTION_CONTAINERS)
        self.assertIn("READ ONLY", qga.call_args_list[6].args[-1])
        self.assertIn("quantself_analytics_reader", qga.call_args_list[6].args[-1])
        queries[6] = "BEGIN\n2\nf\nCOMMIT"
        with patch.object(self.drill, "qga", side_effect=queries), \
             patch.object(self.drill, "verify_containers") as inspect:
            with self.assertRaisesRegex(BackupError, "reader grants"):
                self.drill.production_postgres(images, ["one"])
        inspect.assert_not_called()

    def test_production_drill_rejects_running_worker_before_queries(self):
        with patch.object(self.drill, "qga", return_value=PRODUCTION_POSTGRES + "\nquantself-api") as qga:
            with self.assertRaisesRegex(BackupError, "Unexpected running container"):
                self.drill.production_postgres({}, [])
        qga.assert_called_once()

    def test_native_admission_requires_the_distinct_owner_receipt_and_schema(self):
        restore_id = "20261114T051223Z-13081903ae4c"
        images = {service: f"{service}-image" for service in PRODUCTION_APP}
        manifest = {"profile": "production-native", "images": images, "schema_migrations": sorted(NATIVE_MIGRATIONS)}
        pair = {"restore_id": restore_id, "offsite": {"quantself": {"manifest": manifest}},
                "pbs": {"quantself": {"encryption_fingerprint": "fixture-key"}}}
        receipt = {"format": 1, "profile": "production-native", "postgres_image": images["postgres"],
                   "pbs_encryption_fingerprint": "fixture-key", "full_restore_verified": True,
                   "postgres_only_no_nic_verified": True, "production_native_no_nic_verified": True}

        state = {
            self.root / "last-success.json": pair,
            self.root / "runs" / restore_id / "complete.json": pair,
            POLICY: {"format": 1, "vmid": 2544, "storage": "local-lvm",
                     "pbs_alias": "backup-restore-254", "allow_cleanup": True},
            NATIVE_REHEARSAL: receipt,
        }
        with patch("backup_restore_drill.state_file", side_effect=lambda path: state[path]), \
             patch("backup_restore_drill.validate_pair", return_value=datetime.now(timezone.utc)), \
             patch.object(self.drill, "occupied", return_value=True):
            # Reaching the VM ownership check demonstrates the native receipt passed.
            with self.assertRaisesRegex(BackupError, "2544 is occupied"):
                self.drill.admit()
            state[NATIVE_REHEARSAL] = {**receipt, "production_native_no_nic_verified": False}
            with self.assertRaisesRegex(BackupError, "no-NIC PostgreSQL rehearsal"):
                self.drill.admit()
            state[NATIVE_REHEARSAL] = receipt
            manifest["schema_migrations"] = []
            with self.assertRaisesRegex(BackupError, "Native website migration"):
                self.drill.admit()
            manifest["schema_migrations"] = sorted(NATIVE_MIGRATIONS)
            manifest["images"] = {**images, "analytics-postgres": "sidecar"}
            with self.assertRaisesRegex(BackupError, "exactly the Quantself service images"):
                self.drill.admit()

    def test_restored_slot_requires_active_services_and_only_allows_stopped_standby(self):
        with patch.object(self.drill, "qga", return_value="blue"), \
             patch.object(self.drill, "verify_containers") as verify:
            self.drill.verify_slot_containers("blue")
        expected = verify.call_args.args[0]
        self.assertEqual(expected[PRODUCTION_POSTGRES], ("running", "unless-stopped"))
        self.assertEqual(expected["quantself-blue-api-workers-1"], ("exited", "unless-stopped"))
        optional = verify.call_args.kwargs["optional"]
        self.assertEqual(optional["quantself-green-api-workers-1"], ("exited", "unless-stopped"))
        self.assertEqual(optional["quantself-api"], ("exited", "unless-stopped"))
        with patch.object(self.drill, "qga", return_value="green"), \
             self.assertRaisesRegex(BackupError, "Restored active slot differs"):
            self.drill.verify_slot_containers("blue")

    def test_native_drill_checks_tables_ledger_and_only_the_app_database(self):
        migrations = sorted(NATIVE_MIGRATIONS)
        good = f"BEGIN\n1\n{json.dumps(migrations)}\n2\nt\nCOMMIT"
        base = [PRODUCTION_POSTGRES, "app-image", ""]
        with patch.object(self.drill, "qga", side_effect=[*base, good, PRODUCTION_POSTGRES]) as qga, \
             patch.object(self.drill, "verify_containers") as inspect:
            self.drill.postgres("app-image", migrations, native=True)
        inspect.assert_called_once_with(NATIVE_CONTAINERS, allow_created=(NATIVE_OCR,))
        sql = qga.call_args_list[3].args[-1]
        for expected in ("BEGIN READ ONLY", "public.website_event", "public.website_inquiry"):
            self.assertIn(expected, sql)
        for output in (good.replace("\nt\n", "\nf\n"), good.replace(migrations[0], "other")):
            with self.subTest(output=output), patch.object(self.drill, "qga", side_effect=[*base, output]):
                with self.assertRaisesRegex(BackupError, "schema check differs"):
                    self.drill.postgres("app-image", migrations, native=True)
        with patch.object(self.drill, "qga", return_value=PRODUCTION_POSTGRES + "\n" + ANALYTICS_POSTGRES) as qga:
            with self.assertRaisesRegex(BackupError, "Unexpected running container"):
                self.drill.postgres("app-image", migrations, native=True)
        qga.assert_called_once()

    def test_native_container_set_rejects_stopped_analytics_and_checks_paused_ocr(self):
        rows = [f"/{name} {state} {policy}" for name, (state, policy) in NATIVE_CONTAINERS.items()]
        created = [row.replace("exited no", "created no") if row.startswith(f"/{NATIVE_OCR} ") else row
                   for row in rows]
        with patch.object(self.drill, "qga", side_effect=["\n".join(NATIVE_CONTAINERS), "\n".join(created)]):
            self.drill.verify_containers(NATIVE_CONTAINERS, allow_created=(NATIVE_OCR,))
        with patch.object(self.drill, "qga", return_value="\n".join([*NATIVE_CONTAINERS, ANALYTICS_POSTGRES])):
            with self.assertRaisesRegex(BackupError, "container set differs"):
                self.drill.verify_containers(NATIVE_CONTAINERS, allow_created=(NATIVE_OCR,))
        wrong_restart = [row.replace("created no", "created always") if row.startswith(f"/{NATIVE_OCR} ") else row
                         for row in created]
        with patch.object(self.drill, "qga", side_effect=["\n".join(NATIVE_CONTAINERS), "\n".join(wrong_restart)]):
            with self.assertRaisesRegex(BackupError, "restart policy"):
                self.drill.verify_containers(NATIVE_CONTAINERS, allow_created=(NATIVE_OCR,))

    def check_drill_shutdown(self, *, replaced, changed_at_cleanup=None):
        pair = {"restore_id": "20261114T051223Z-13081903ae4c", "offsite": {
            "quantself": {"manifest": {"images": {"postgres": "image"}, "schema_migrations": ["one"]}}
        }}
        volume = "backup-restore-254:backup/vm/2541/2026-11-14T05:12:23Z"
        disk = "local-lvm:vm-2544-disk-0"
        base = {"scsi0": disk + ",size=52G", "boot": "order=scsi0", "ide2": CLOUDINIT + ",media=cdrom",
                "vmgenid": "10000000-0000-0000-0000-000000000001",
                "smbios1": "uuid=10000000-0000-0000-0000-000000000002"}
        marker = "keep-postgres-restore:" + pair["restore_id"]
        final = {**base, "name": "quantself-db-restore-254", "description": marker,
                 "cores": 1, "sockets": 1, "memory": "1536"}
        during_shutdown = ({**final, "vmgenid": "10000000-0000-0000-0000-000000000003"}
                           if replaced else final)
        configs = [base, final, during_shutdown]
        if changed_at_cleanup:
            configs.append({**final, **changed_at_cleanup})
        with patch.object(self.drill, "admit", return_value=(pair, volume, 52)), \
             patch.object(self.drill, "restore", side_effect=lambda path, row: (
                 write_json(path, {**row, "phase": "restore_observing"}), "fixture-upid"
             )[1]), \
             patch.object(self.drill, "config", side_effect=configs), \
             patch.object(self.drill, "status", return_value="stopped"), \
             patch.object(self.drill, "get", return_value=[{"volid": disk}, {"volid": CLOUDINIT}]), \
             patch.object(self.drill, "require_no_ha"), \
             patch.object(self.drill, "postgres", side_effect=None if changed_at_cleanup else BackupError("fixture query failed")), \
             patch("backup_restore_drill.command") as run:
            with self.assertRaisesRegex(BackupError, "identity|geometry" if replaced or changed_at_cleanup else "query failed"):
                self.drill.run(True)
        expected = [("qm", "set"), ("qm", "start")]
        if not replaced:
            expected.append(("qm", "shutdown"))
        self.assertEqual([call.args[:2] for call in run.call_args_list], expected)
        self.assertTrue((self.root / "postgres-restore-active.json").exists())
        self.assertEqual(read_json(self.root / "postgres-restore-active.json")["system_disk_gib"], 52)
        self.assertFalse((self.root / "postgres-restore-last-success.json").exists())

    def test_failed_query_shuts_down_and_preserves_clone_without_cleanup(self):
        self.check_drill_shutdown(replaced=False)

    def test_replaced_clone_is_not_shut_down_or_destroyed(self):
        self.check_drill_shutdown(replaced=True)

    def test_cleanup_refuses_changed_clone_identity_or_nominal_geometry(self):
        for changed in (
            {"vmgenid": "10000000-0000-0000-0000-000000000003"},
            {"scsi0": "local-lvm:vm-2544-disk-0,size=44G"},
        ):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as scratch:
                with patch.object(self, "root", Path(scratch)), patch.object(self.drill, "root", Path(scratch)):
                    self.check_drill_shutdown(replaced=False, changed_at_cleanup=changed)


if __name__ == "__main__":
    unittest.main()
