"""Run the disposable rollback workflow step against a local Git repository."""

import json
import os
from pathlib import Path
import subprocess


FIXTURE = Path(__file__).with_name("fixtures") / "rollback-keep.yml"
WORKFLOW_PATH = ".github/workflows/rollback-keep.yml"


class RollbackWorkflowFixture:
    def __init__(self, root):
        self.repository = root / "control-repo"
        self.repository.mkdir()
        path = self.repository / WORKFLOW_PATH
        path.parent.mkdir(parents=True)
        path.write_bytes(FIXTURE.read_bytes())
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("add", "--", WORKFLOW_PATH)
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "Pin rollback rehearsal workflow")
        self.control_sha = self.git("rev-parse", "HEAD").decode().strip()
        self.workflow = json.loads(subprocess.check_output([
            "bun", "-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(Bun.argv.at(-1)).text())))",
            str(path),
        ]))

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", self.repository, *args],
            env={"PATH": os.environ["PATH"], "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"},
        )

    def read_workflow(self, commit, path):
        return self.git("cat-file", "blob", f"{commit}:{path}")

    def dispatch(self, policy, request, **overrides):
        step = self.workflow["jobs"]["relay"]["steps"][0]["run"]
        env = {
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REF_PROTECTED": "true",
            "EVENT_FORK": "false",
            "GITHUB_REPOSITORY": policy.repository,
            "GITHUB_REPOSITORY_ID": str(policy.repository_id),
            "GITHUB_ACTOR_ID": str(policy.owner_id),
            "GITHUB_ACTOR": "fixture-owner",
            "GITHUB_TRIGGERING_ACTOR": "fixture-owner",
            "GITHUB_WORKFLOW_REF": f"{policy.repository}/{policy.workflow_path}@refs/heads/main",
            "GITHUB_WORKFLOW_SHA": policy.control_sha,
            "GITHUB_SHA": policy.control_sha,
            "GITHUB_RUN_ID": request.run_id,
            "GITHUB_RUN_ATTEMPT": request.attempt,
            "CONTROL_REPOSITORY": policy.repository,
            "CONTROL_REPOSITORY_ID": str(policy.repository_id),
            "CONTROL_OWNER_ID": str(policy.owner_id),
            "CONTROL_SHA": policy.control_sha,
            "CANONICAL_SHA": request.canonical_sha,
            "TARGET_SHA": request.target_sha,
            "IMAGE_ID": request.image_id,
            "PRIOR_SLOT": request.prior_slot,
        }
        return subprocess.run(
            ["/bin/bash", "-c", step], env=env | overrides, text=True, capture_output=True, check=False,
        )
