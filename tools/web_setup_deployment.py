#!/usr/bin/env python3
"""Point this repository's browser deployment at your own Cloudflare account.

The checked-in configuration names the original public deployment: its
Workers, its allowed origins, its KV namespace, its Turnstile widget. This
script rewrites those for a deployment of your own, creates what the account
needs, generates the secrets, deploys the signaling Worker, and prints what is
left for you to do (build the game, deploy the page, start the dedicated host).

Run it once, from the repository root, logged in to Wrangler
(``npx wrangler login`` in services/signaling):

    python3 tools/web_setup_deployment.py --name halo \\
        --game-url https://halo.YOUR-SUBDOMAIN.workers.dev

``--game-url`` is the address players will visit. For a workers.dev address,
the subdomain is shown in the Cloudflare dashboard under Workers & Pages. A
custom domain works too; add it to the game Worker in the dashboard after the
first deploy.

Without ``--turnstile-sitekey`` and ``--turnstile-secret`` the deployment runs
without the human-verification widget, which is fine for a private community.
``--campaign`` keeps the R2 bucket for streamed campaign maps (see
services/web/README.md); the default is a multiplayer-only site.

``--dry-run`` rewrites the files and prints the commands without calling
Wrangler, so you can review the changes first.
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


def run(command: list[str], cwd: Path, dry_run: bool, stdin: str | None = None) -> str:
    print("$", " ".join(command), f"  (in {cwd})", flush=True)
    if dry_run:
        return ""
    completed = subprocess.run(
        command,
        cwd=cwd,
        input=stdin,
        text=True,
        capture_output=True,
        check=False,
    )
    sys.stdout.write(completed.stdout)
    sys.stderr.write(completed.stderr)
    if completed.returncode != 0:
        raise SystemExit(f"command failed ({completed.returncode}): {' '.join(command)}")
    return completed.stdout + completed.stderr


def npx(*arguments: str) -> list[str]:
    return ["npx", "--no-install", "wrangler", *arguments]


def replace_once(text: str, pattern: str, replacement: str, what: str) -> str:
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"could not find {what} to rewrite")
    return new_text


def set_var(text: str, name: str, value: str) -> str:
    return replace_once(
        text,
        rf'^(\s*"{re.escape(name)}":\s*)"[^"\n]*"',
        lambda match: f'{match.group(1)}{json.dumps(value)}',
        f"the {name} variable",
    )


def rewrite_signaling_config(
    path: Path,
    *,
    name: str,
    game_url: str,
    account_id: str | None,
    kv_id: str | None,
    turnstile_hostnames: str,
) -> None:
    origin = urlparse(game_url)
    game_origin = f"{origin.scheme}://{origin.netloc}"
    text = path.read_text(encoding="utf-8")
    text = replace_once(text, r'^(\s*"name":\s*)"[^"\n]*"', rf'\g<1>"{name}-signaling"', "the Worker name")
    text = set_var(text, "ALLOWED_ORIGINS", f"{game_origin},http://127.0.0.1:8765,http://localhost:8765")
    text = set_var(text, "PUBLIC_GAME_URL", game_url)
    text = set_var(text, "TURNSTILE_HOSTNAMES", turnstile_hostnames)
    if account_id:
        text = set_var(text, "CLOUDFLARE_ACCOUNT_ID", account_id)
    if kv_id:
        text = replace_once(
            text,
            r'("binding":\s*"HALO_ABUSE",\s*"id":\s*)"[0-9a-f]*"',
            rf'\g<1>"{kv_id}"',
            "the HALO_ABUSE KV namespace id",
        )
    path.write_text(text, encoding="utf-8")


def rewrite_web_config(path: Path, *, name: str, campaign: bool) -> None:
    text = path.read_text(encoding="utf-8")
    text = replace_once(text, r'^(\s*"name":\s*)"[^"\n]*"', rf'\g<1>"{name}"', "the Worker name")
    if not campaign:
        text = replace_once(
            text,
            r'\n\s*"r2_buckets":\s*\[[^\]]*\],',
            "",
            "the r2_buckets binding",
        )
    path.write_text(text, encoding="utf-8")


def rewrite_page(path: Path, *, signaling_url: str, turnstile_sitekey: str, build_id: str) -> None:
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        r'(<meta name="halo-signaling-url" content=")[^"]*(")',
        rf'\g<1>{signaling_url}\g<2>',
        "the signaling URL meta tag",
    )
    text = replace_once(
        text,
        r'(<meta name="halo-build-id" content=")[^"]*(")',
        rf'\g<1>{build_id}\g<2>',
        "the build id meta tag",
    )
    text = replace_once(
        text,
        r'(<meta name="halo-turnstile-sitekey" content=")[^"]*(")',
        rf'\g<1>{turnstile_sitekey}\g<2>',
        "the Turnstile site key meta tag",
    )
    path.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", default="halo", help="base name of the Workers (default: halo)")
    parser.add_argument("--game-url", required=True, help="the address players visit, e.g. https://halo.me.workers.dev")
    parser.add_argument("--signaling-url", help="the signaling Worker's URL, when it cannot be derived from --game-url")
    parser.add_argument("--account-id", help="Cloudflare account ID (shown in the dashboard sidebar)")
    parser.add_argument("--turnstile-sitekey", default="", help="Turnstile site key; omit to run without the widget")
    parser.add_argument("--turnstile-secret", default="", help="Turnstile secret key")
    parser.add_argument("--build-id", default="web-multiplayer-v1", help="build id players and hosts must share")
    parser.add_argument("--campaign", action="store_true", help="keep the R2 campaign map bucket")
    parser.add_argument("--dry-run", action="store_true", help="rewrite files and print commands only")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]), help=argparse.SUPPRESS)
    arguments = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9-]{1,40}", arguments.name):
        raise SystemExit("--name must be lowercase letters, digits and dashes")
    game = urlparse(arguments.game_url)
    if game.scheme != "https" or not game.netloc:
        raise SystemExit("--game-url must be an https:// address")
    if bool(arguments.turnstile_sitekey) != bool(arguments.turnstile_secret):
        raise SystemExit("--turnstile-sitekey and --turnstile-secret go together")

    repo = Path(arguments.repo)
    signaling = repo / "services" / "signaling"
    web = repo / "services" / "web"
    page = repo / "port" / "web" / "shell.html"
    dry_run = arguments.dry_run

    signaling_url = arguments.signaling_url
    if not signaling_url:
        match = re.fullmatch(r"([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev", game.netloc)
        if match:
            signaling_url = f"https://{arguments.name}-signaling.{match.group(2)}.workers.dev"
        elif dry_run:
            signaling_url = f"https://{arguments.name}-signaling.YOUR-SUBDOMAIN.workers.dev"

    # 1. The KV namespace the abuse controls use.
    kv_id = None
    if not dry_run:
        output = run(npx("kv", "namespace", "create", "HALO_ABUSE"), signaling, dry_run)
        found = re.search(r'"id":\s*"([0-9a-f]{32})"', output) or re.search(r'id\s*=\s*"([0-9a-f]{32})"', output)
        if not found:
            raise SystemExit("could not read the new KV namespace id from Wrangler's output")
        kv_id = found.group(1)
    else:
        print("$", " ".join(npx("kv", "namespace", "create", "HALO_ABUSE")), "  (dry run: id left as is)")

    # 2. The configuration files.
    rewrite_signaling_config(
        signaling / "wrangler.jsonc",
        name=arguments.name,
        game_url=arguments.game_url,
        account_id=arguments.account_id,
        kv_id=kv_id,
        turnstile_hostnames=game.hostname if arguments.turnstile_sitekey else "",
    )
    rewrite_web_config(web / "wrangler.jsonc", name=arguments.name, campaign=arguments.campaign)
    print(f"rewrote {signaling / 'wrangler.jsonc'} and {web / 'wrangler.jsonc'}")
    run(["npm", "run", "types"], signaling, dry_run)

    # 3. The secrets. Generated here; the two you need again are printed.
    generated = {
        "ROOM_ID_SECRET": secrets.token_hex(32),
        "ABUSE_ID_SECRET": secrets.token_hex(32),
        "ADMIN_TOKEN": secrets.token_hex(32),
        "HOST_SERVICE_TOKEN": secrets.token_hex(32),
    }
    if arguments.turnstile_secret:
        generated["TURNSTILE_SECRET"] = arguments.turnstile_secret
    for secret_name, value in generated.items():
        run(npx("secret", "put", secret_name), signaling, dry_run, stdin=value)

    # 4. Deploy the signaling Worker and learn its address.
    output = run(["npm", "run", "check"], signaling, dry_run)
    output = run(npx("deploy"), signaling, dry_run)
    if not dry_run:
        found = re.search(r"https://[a-z0-9.-]+\.workers\.dev", output)
        if found:
            signaling_url = found.group(0)
    if not signaling_url:
        raise SystemExit("pass --signaling-url: the signaling Worker's address could not be determined")

    # 5. The page: the addresses it is built with.
    rewrite_page(
        page,
        signaling_url=signaling_url,
        turnstile_sitekey=arguments.turnstile_sitekey,
        build_id=arguments.build_id,
    )
    print(f"rewrote {page}")

    saved = repo / "build" / "deployment-secrets.txt"
    if not dry_run:
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_text(
            "".join(f"{key}={value}\n" for key, value in generated.items()),
            encoding="utf-8",
        )
        saved.chmod(0o600)

    print(
        f"""
Signaling Worker: {signaling_url}
Game page:        {arguments.game_url}

Secrets are in {saved} (ignored by Git). You will need:
  HOST_SERVICE_TOKEN  for the dedicated host (Railway variable HALO_HOST_SERVICE_TOKEN)
  ADMIN_TOKEN         for tools/halo_telemetry.mjs, optional

Next, on the Mac with your Halo disc image:

  python3 tools/web_run.py --iso /path/to/Halo.iso     # builds the game once (extracts maps, compiles)
  cd services/web && npm ci && npm run deploy          # publishes the page and multiplayer maps

Then, on Railway, set HALO_GAME_URL={arguments.game_url} beside HALO_HOST_SERVICE_TOKEN.

Commit the rewritten configuration and page so later builds and deploys keep
these addresses. Optional: to let GitHub Actions deploy the signaling Worker
on every push to main, add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as
repository secrets.
"""
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
