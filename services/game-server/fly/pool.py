#!/usr/bin/env python3
"""Deploys the game server pool on Fly.io: machines pool-0 .. pool-N.

    python3 services/game-server/fly/pool.py registry.fly.io/<app>:<tag>

Each machine runs SERVERS_PER_MACHINE game servers on UDP ports of its own
(40100 + 10 * index + n): Fly sends a shared address's UDP to whichever
machine has that port, so a player always reaches the machine of their
server. pool-0 stays running; the others are left stopped, and the
matchmaker's autoscaler (services/signaling/src/matchmaker.ts) starts and
stops them as players come and go.

The service credential is an app secret (fly secrets set
HALO_HOST_SERVICE_TOKEN=...), which Fly gives every machine.
"""

import json
import subprocess
import sys
import tempfile

APP = "halo-game-lilchocobo"
REGION = "lax"
MACHINES = 3
SERVERS_PER_MACHINE = 3
PUBLIC_IP = "37.16.2.146"
GUEST = {"cpu_kind": "shared", "cpus": 2, "memory_mb": 1024}
ENV = {
    "HALO_SIGNALING_URL": "https://halo-signaling.lilchocobo2.workers.dev",
    "HALO_GAME_ORIGIN": "https://halo.lilchocobo2.workers.dev",
    "HALO_MODE": "pool",
    "HALO_MATCH_COUNTDOWN_SECONDS": "5",
    "HALO_LOBBY_POSTGAME_SECONDS": "8",
    "HALO_RESTART_FOR_WAITING": "false",
    # Fly answers UDP only from this address, on the same port outside and in
    "HALO_WEBRTC_UDP_HOST": "fly-global-services",
    "HALO_PUBLIC_IP": PUBLIC_IP,
    "HALO_SERVERS": str(SERVERS_PER_MACHINE),
}


def fly(*arguments: str, capture: bool = False) -> str:
    result = subprocess.run(["fly", *arguments, "-a", APP], check=True, text=True,
                            capture_output=capture)
    return result.stdout if capture else ""


def machine_config(image: str, index: int) -> dict:
    base = 40100 + 10 * index
    ports = range(base, base + SERVERS_PER_MACHINE)
    return {
        "image": image,
        "guest": GUEST,
        "env": {**ENV, "HALO_WEBRTC_UDP_PORT": str(base)},
        "services": [
            {"protocol": "udp", "internal_port": port, "ports": [{"port": port}]} for port in ports
        ],
        "restart": {"policy": "always"},
        "metadata": {"pool": "game-servers"},
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    image = sys.argv[1]
    existing = {machine["name"]: machine for machine in json.loads(fly("machine", "list", "--json", capture=True))}
    for index in range(MACHINES):
        name = f"pool-{index}"
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(machine_config(image, index), handle)
            path = handle.name
        machine = existing.get(name)
        if machine:
            print(f"updating {name} ({machine['id']})", flush=True)
            # a stopped machine stays stopped: the autoscaler starts it
            skip = ["--skip-start"] if machine.get("state") == "stopped" else []
            fly("machine", "update", machine["id"], "--machine-config", path, "--yes", *skip)
            machine_id = machine["id"]
        else:
            print(f"creating {name}", flush=True)
            fly("machine", "run", image, "--name", name, "--region", REGION, "--machine-config", path)
            created = {m["name"]: m for m in json.loads(fly("machine", "list", "--json", capture=True))}
            machine_id = created[name]["id"]
        if index > 0:
            print(f"stopping {name}: the autoscaler starts it when it is needed", flush=True)
            subprocess.run(["fly", "machine", "stop", machine_id, "-a", APP], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
