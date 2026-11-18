"""Read-only checks for Keep's managed rollback slots.

Callers hold the existing deploy lock and supply an inspect-only adapter for
the trusted Docker daemon. This module has no CLI or deploy entry point.
"""

from contextlib import contextmanager
from dataclasses import dataclass
import os
import re
import stat


# Managed names and start order from scripts/promote-home.sh.
START_SERVICES = ("api", "app", "gateway", "api-workers", "inventory-codex-enrichment-worker")
MANAGED_SLOTS = ("blue", "green")
SHA = re.compile(r"[0-9a-f]{40}")
CONTAINER_ID = re.compile(r"[0-9a-f]{64}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


@dataclass(frozen=True)
class ApprovedRollback:
    canonical_sha: str
    target_sha: str
    image_id: str
    prior_slot: str

    def __post_init__(self):
        if self.prior_slot not in MANAGED_SLOTS:
            raise ValueError("Expected a managed rollback slot")
        if not (
            SHA.fullmatch(self.canonical_sha) and SHA.fullmatch(self.target_sha) and IMAGE_ID.fullmatch(self.image_id)
        ):
            raise ValueError("Invalid rollback release identity")


@dataclass(frozen=True)
class Container:
    service: str
    container_id: str
    image_id: str


@dataclass(frozen=True)
class RollbackPlan:
    approval: ApprovedRollback
    active_slot: str
    containers: tuple[Container, ...]

    @property
    def start_ids(self):
        return tuple(container.container_id for container in self.containers)


def require_metadata(info, owner_uid, kind, mode):
    if not (kind(info.st_mode) and stat.S_IMODE(info.st_mode) == mode and info.st_uid == owner_uid):
        raise ValueError("Untrusted retained slot metadata")


@contextmanager
def open_directory(path, owner_uid, *, parent=None):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        require_metadata(os.fstat(fd), owner_uid, stat.S_ISDIR, 0o700)
        yield fd
    finally:
        os.close(fd)


def read_record(directory, name, owner_uid):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(name, flags, dir_fd=directory), "rb") as file:
        require_metadata(os.fstat(file.fileno()), owner_uid, stat.S_ISREG, 0o600)
        return file.read(256)


def read_slots(state, approval, owner_uid):
    # The caller supplies the trusted base path. Anchor child reads to opened
    # directories and reject symlinks in the managed state itself.
    with open_directory(state, owner_uid) as directory:
        try:
            os.stat("pending", dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError("Rollback is blocked by pending recovery")
        active, _, prior = read_record(directory, "active", owner_uid).partition(b"\n")
        if active == b"legacy" or prior == b"legacy\n":
            raise ValueError("Legacy rollback identity is unsupported")
        if active not in (b"blue", b"green") or active == approval.prior_slot.encode("ascii"):
            raise ValueError("Previous slot changed or active record is malformed")
        if prior != f"{approval.prior_slot}\n".encode("ascii"):
            raise ValueError("Previous slot changed or active record is malformed")
        with open_directory(approval.prior_slot, owner_uid, parent=directory) as retained:
            expected = f"{approval.target_sha}\n{approval.image_id}\n".encode("ascii")
            if read_record(retained, "release", owner_uid) != expected:
                raise ValueError("Retained release record differs from approval")
        return active.decode("ascii")


def inspect_containers(approval, inspect, references=None):
    names = {f"/quantself-{approval.prior_slot}-{service}-1": service for service in START_SERVICES}
    if references is None:
        references = [name.removeprefix("/") for name in names]
    by_service = {}
    args = ["container", "inspect", "--format", "{{.Name}} {{.Id}} {{.Image}}", *references]
    for line in inspect(args).splitlines():
        fields = line.split()
        if len(fields) != 3:
            raise ValueError("Invalid retained container identity")
        name, container_id, image = fields
        service = names.get(name)
        # The gateway runs Caddy and has its own image. The plan pins its
        # observed digest and ID across both reads.
        if not (
            service and service not in by_service and CONTAINER_ID.fullmatch(container_id)
            and IMAGE_ID.fullmatch(image) and (service == "gateway" or image == approval.image_id)
        ):
            raise ValueError("Retained runtime images or container identities differ from approval")
        by_service[service] = Container(service, container_id, image)
    ids = {container.container_id for container in by_service.values()}
    if len(by_service) != len(names) or len(ids) != len(names):
        raise ValueError("Retained runtime images or container identities differ from approval")
    return tuple(by_service[service] for service in START_SERVICES)


def prepare_rollback(state, approval, *, inspect, owner_uid=0):
    """Build a plan from the trusted slot record and the exact containers."""
    active = read_slots(state, approval, owner_uid)
    return RollbackPlan(approval, active, inspect_containers(approval, inspect))


def confirm_rollback(state, approval, plan, *, inspect, owner_uid=0):
    """Recheck the plan under the lock and return immutable IDs for a caller."""
    if plan.approval != approval:
        raise ValueError("Rollback plan differs from approval")
    if tuple(container.service for container in plan.containers) != START_SERVICES or any(
        not CONTAINER_ID.fullmatch(container_id) for container_id in plan.start_ids
    ):
        raise ValueError("Invalid rollback plan container IDs")
    active = read_slots(state, approval, owner_uid)
    # Check the same captured IDs and confirm they still have the expected
    # names and images. A switch adapter must then start by ID.
    containers = inspect_containers(approval, inspect, plan.start_ids)
    if active != plan.active_slot or containers != plan.containers:
        raise ValueError("Retained containers or slot changed before switch")
    return plan.start_ids
