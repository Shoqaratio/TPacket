"""Read the orthogonal Tiled map once for both browser art and server collision."""
import json
from pathlib import Path


def properties(item: dict) -> dict:
    return {p["name"]: p["value"] for p in item.get("properties", [])}


def load_map() -> dict:
    source = Path(__file__).with_name("campus_assets") / "campus.tmj"
    tiled = json.loads(source.read_text(encoding="utf-8"))
    layers = {layer["name"]: layer for layer in tiled["layers"]}
    atlas = tiled["tilesets"][0]
    codes = {atlas["firstgid"] + tile["id"]: properties(tile)["code"] for tile in atlas["tiles"]}
    width, height = tiled["width"], tiled["height"]
    tw, th = tiled["tilewidth"], tiled["tileheight"]
    tiles = layers["Grille"]["data"]
    if not isinstance(tiles, list) or len(tiles) != width * height:
        raise ValueError("The campus requires a fixed Tiled map with an uncompressed tile layer")
    cells = [codes.get(tile, "#") for tile in tiles]

    rooms = []
    for item in layers["Salles"]["objects"]:
        data = properties(item)
        rooms.append(dict(id=data["room_id"], name=item["name"], topic=data["topic"],
                          x=int(item["x"] // tw), y=int(item["y"] // th),
                          w=int(item["width"] // tw), h=int(item["height"] // th),
                          door=[data["door_x"], data["door_y"]], station=[data["station_x"], data["station_y"]]))
    guides = []
    for item in layers["Guides"]["objects"]:
        data = properties(item)
        guides.append(dict(room=data["room_id"], name=item["name"], role=data["role"], hints=data["hints"].splitlines(),
                           x=int(item["x"] // tw), y=int(item["y"] // th)))
    spawn = layers["Apparition"]["objects"][0]
    return {
        "grid": ["".join(cells[y * width:(y + 1) * width]) for y in range(height)],
        "spawn": (int(spawn["x"] // tw), int(spawn["y"] // th)),
        "rooms": rooms,
        "guides": guides,
    }


MAP = load_map()
SPAWN = MAP["spawn"]
WIDTH, HEIGHT = len(MAP["grid"][0]), len(MAP["grid"])
ROOM_IDS = {room["id"] for room in MAP["rooms"]}


def room_at(x: int, y: int) -> str | None:
    return next((r["id"] for r in MAP["rooms"] if r["x"] <= x < r["x"] + r["w"] and r["y"] <= y < r["y"] + r["h"]), None)


def walkable(x: int, y: int, staff: bool, closed=()) -> bool:
    if not (0 <= x < WIDTH and 0 <= y < HEIGHT) or MAP["grid"][y][x] not in ".:+":
        return False
    return staff or room_at(x, y) not in (*closed, "staff")
