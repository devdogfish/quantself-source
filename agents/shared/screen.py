#!/usr/bin/python3 -I
"""Run the X display, browser and Bot HQ screen relays as the Hermes user."""
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vault import fetch_keys


def quiet_run(command, **kwargs):
    return subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)


def run_screen():
    host = os.environ["API_SERVER_HOST"]
    display = os.environ["DISPLAY"]
    authority = Path(os.environ["XAUTHORITY"])
    cdp_port = os.environ["QUANTSELF_AGENT_CDP_PORT"]
    websocket_port = os.environ["QUANTSELF_AGENT_WEBSOCKIFY_PORT"]
    browser_data = Path(os.environ["HERMES_HOME"]) / "screen-chromium"
    vnc_password = fetch_keys(("VNC_PASSWORD",))["VNC_PASSWORD"]
    if len(vnc_password) != 8:
        raise ValueError("The VNC password must have exactly eight characters")

    authority.touch(mode=0o600)
    quiet_run(["xauth", "-q", "-f", str(authority)],
              input=f"add {display} . {secrets.token_hex(16)}\n", text=True, check=True)
    password_file = authority.parent / "vnc-password"
    password_file.write_text(vnc_password + "\n")

    # systemd stops the whole service cgroup if a child fails.
    display_process = subprocess.Popen(["Xvfb", display, "-screen", "0", "1440x900x24",
                                        "-nolisten", "tcp", "-auth", str(authority)])
    for _ in range(50):
        if display_process.poll() is not None:
            raise RuntimeError("Xvfb failed")
        if quiet_run(["xdpyinfo"], timeout=1).returncode == 0:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("X display did not become ready")

    commands = [
        ["openbox"],
        ["chromium", f"--user-data-dir={browser_data}", "--no-first-run",
         "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={cdp_port}", "about:blank"],
        ["x11vnc", "-display", display, "-localhost", "-rfbport", "5900",
         "-forever", "-shared", "-passwdfile", str(password_file)],
        ["websockify", f"{host}:{websocket_port}", "127.0.0.1:5900"],
        ["socat", f"TCP4-LISTEN:{cdp_port},bind={host},reuseaddr,fork", f"TCP4:127.0.0.1:{cdp_port}"],
    ]
    children = [display_process, *(subprocess.Popen(command) for command in commands)]
    while all(child.poll() is None for child in children):
        time.sleep(1)
    raise RuntimeError("A screen component exited")


if __name__ == "__main__":
    try:
        run_screen()
    except (OSError, subprocess.SubprocessError, ValueError, RuntimeError, KeyError):
        sys.exit("Agent screen unavailable")
