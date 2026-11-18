"""Seed the early CLI profile settings and keep MCP discovery in Managed Scope."""

from pathlib import Path
import sys


def main():
    source = Path(sys.argv[1])
    profile = Path(sys.argv[2])
    sys.path.insert(0, str(source))
    import hermes_bootstrap  # noqa: F401
    from utils import _roundtrip_dump, _roundtrip_load, fast_safe_load

    bootstrap = fast_safe_load(sys.stdin.read())
    yaml, config = _roundtrip_load(profile)
    config["secrets"] = bootstrap["secrets"]
    memory = config.get("memory")
    if not isinstance(memory, dict):
        memory = config["memory"] = {}
    memory["provider"] = bootstrap["memory"]["provider"]
    if "plugins" in bootstrap:
        plugins = config.get("plugins")
        if not isinstance(plugins, dict):
            plugins = config["plugins"] = {}
        plugins["enabled"] = bootstrap["plugins"]["enabled"]
    config.pop("mcp_servers", None)
    _roundtrip_dump(profile, yaml, config)


if __name__ == "__main__":
    main()
