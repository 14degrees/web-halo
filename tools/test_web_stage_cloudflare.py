"""A deployment is staged only with real game maps and real menu art."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import web_stage_cloudflare as stage  # noqa: E402
from web_placeholder_assets import placeholder_files, placeholder_images  # noqa: E402


def make_repository(root: Path) -> Path:
    web = root / "build" / "web"
    web.mkdir(parents=True)
    (web / "halo.html").write_text('<meta name="halo-build-id" content="dev">', encoding="utf-8")
    (web / "halo.js").write_text("// game", encoding="utf-8")
    (web / "halo.wasm").write_bytes(b"\0asm")
    page = root / "port" / "web"
    page.mkdir(parents=True)
    for name in ("coi-serviceworker.js", "servers.html", "servers_wagers.js"):
        (page / name).write_text("", encoding="utf-8")
    maps = root / "assets" / "maps"
    maps.mkdir(parents=True)
    for name in ("ui.map", *stage.MULTIPLAYER_MAPS):
        (maps / name).write_bytes(stage.MAP_SIGNATURE + b"\0" * 60)
    # stand-in real art: correctly named files that are not placeholders
    for name in placeholder_images():
        path = page / "assets" / "ui" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"real art " + name.encode())
    return root


def test_stages_real_art(tmp_path):
    repository = make_repository(tmp_path)

    assert stage.main(repository) == 0
    staged = repository / "build" / "cloudflare-web"
    assert (staged / "assets" / "ui" / "maps" / "blood-gulch.png").read_bytes() == b"real art maps/blood-gulch.png"
    assert (staged / "assets" / "maps" / "bloodgulch.map").is_file()


@pytest.mark.parametrize("marked", [True, False], ids=["marked", "older-unmarked"])
def test_refuses_placeholder_art(tmp_path, marked):
    repository = make_repository(tmp_path)
    staged = repository / "build" / "cloudflare-web"
    staged.mkdir()
    (staged / "previous").write_text("kept", encoding="utf-8")
    ui = repository / "port" / "web" / "assets" / "ui"
    (ui / "modes" / "slayer.png").write_bytes(placeholder_images(marked)["modes/slayer.png"])

    with pytest.raises(ValueError, match="placeholder images .*modes/slayer.png"):
        stage.main(repository)
    assert (staged / "previous").is_file()


def test_refuses_missing_menu_art(tmp_path):
    repository = make_repository(tmp_path)
    (repository / "port" / "web" / "assets" / "ui" / "spartan" / "sage.png").unlink()

    with pytest.raises(FileNotFoundError, match="spartan/sage.png"):
        stage.main(repository)


def test_refuses_a_map_without_the_cache_file_header(tmp_path):
    repository = make_repository(tmp_path)
    (repository / "assets" / "maps" / "wizard.map").write_bytes(b"not a map")

    with pytest.raises(ValueError, match="wizard.map is not a Halo map"):
        stage.main(repository)


def test_every_generated_placeholder_is_detected(tmp_path):
    for name, data in placeholder_images().items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (tmp_path / "shell" / "lobby-backdrop.png").write_bytes(b"real art")

    found = {path.relative_to(tmp_path).as_posix() for path in placeholder_files(tmp_path)}
    assert found == set(placeholder_images())


def test_marked_placeholders_still_decode():
    images = placeholder_images()
    assert images["shell/halo-ce-ring-menu.jpg"].startswith(b"\xff\xd8\xff\xfe")
    assert images["shell/halo-ce-ring-menu.jpg"].endswith(b"\xff\xd9")
    assert images["modes/slayer.png"].startswith(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
    assert images["shell/mitchell-jester-card.svg"].endswith(b"</svg>")
