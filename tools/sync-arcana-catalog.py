"""Export the minimal public arcana display catalog from a supplied game master snapshot.

Only names, character membership and selected LR/LR5 display bonuses are
written. This maintenance task does not copy master books or account information.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import msgpack

ROOT = Path(__file__).resolve().parents[1]
BASE_NAMES = {1: "力量", 2: "战技", 3: "魔力", 4: "耐力"}
BATTLE_NAMES = {1: "生命", 2: "攻击力", 3: "物理防御", 4: "魔法防御", 5: "命中", 6: "闪避", 7: "暴击", 8: "暴击抗性", 9: "暴击伤害提升", 10: "物理暴击伤害减免", 11: "魔法暴击伤害减免", 12: "防御穿透", 13: "防御力", 14: "物魔防御穿透", 15: "弱化效果命中", 16: "弱化效果抗性", 17: "反弹", 18: "吸血", 19: "速度"}
PERCENT_BATTLE_TYPES = {9, 10, 11, 14, 17, 18}
ELEMENTS = {1: "blue", 2: "red", 3: "green", 4: "yellow", 5: "light", 6: "dark"}


def read_table(directory, name, hashes):
    contents = (directory / name).read_bytes()
    hashes[name] = hashlib.sha256(contents).hexdigest()
    rows = msgpack.unpackb(contents, raw=False, strict_map_key=False)
    if not isinstance(rows, list):
        raise ValueError(f"Invalid master table: {name}")
    return rows


def selected_bonuses(row):
    result = []
    for kind, field, type_field, names in [("base", "BaseParameterChangeInfos", "BaseParameterType", BASE_NAMES), ("battle", "BattleParameterChangeInfos", "BattleParameterType", BATTLE_NAMES)]:
        for change in row.get(field) or []:
            parameter_type = change[type_field]
            change_type = change["ChangeParameterType"]
            value = change["Value"]
            if parameter_type not in names or change_type not in (1, 2, 3) or not math.isfinite(value) or value < 0:
                raise ValueError("Unsupported public arcana bonus.")
            value = int(value) if float(value).is_integer() else value
            unit = "perLevel" if change_type == 3 else "percent" if change_type == 2 or (kind == "battle" and parameter_type in PERCENT_BATTLE_TYPES) else "flat"
            display = f"+{value:g} × 角色等级" if unit == "perLevel" else f"+{value / 100:g}%" if unit == "percent" else f"+{value:,}"
            result.append({"kind": kind, "type": parameter_type, "name": names[parameter_type], "changeType": change_type, "value": value, "unit": unit, "displayValue": display, "scope": "allCharacters"})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("master_directory", type=Path)
    parser.add_argument("--snapshot-date", required=True)
    args = parser.parse_args()
    hashes = {}
    collections = read_table(args.master_directory, "CharacterCollectionMB", hashes)
    levels = read_table(args.master_directory, "CharacterCollectionLevelMB", hashes)
    characters = {row["Id"]: row for row in read_table(args.master_directory, "CharacterMB", hashes)}
    texts = {row["StringKey"]: row["Text"] for row in read_table(args.master_directory, "TextResourceZhCnMB", hashes)}
    catalog = json.loads((ROOT / "public/data/catalog.json").read_text(encoding="utf-8"))
    free_library = json.loads((ROOT / "public/data/free-library.json").read_text(encoding="utf-8"))
    roster_ids = {row["id"] for row in catalog["characters"]}
    permanent_ids = {row["characterId"] for row in free_library["characters"] if row["reason"].startswith("常驻") and row["rarity"] in ("LR", "LR5")}
    groups = []
    support_ids = set()
    for group in sorted(collections, key=lambda row: row["Id"]):
        if group.get("IsIgnore"):
            continue
        group_levels = [row for row in levels if row["CollectionId"] == group["Id"] and not row.get("IsIgnore")]
        lr = [row for row in group_levels if row["CharacterRarityFlags"] == 512]
        if len(lr) != 1:
            raise ValueError("Each displayed arcana must have exactly one LR tier.")
        lr5 = [row for row in group_levels if row["CharacterRarityFlags"] == 16384]
        if len(lr5) > 1:
            raise ValueError("Duplicate LR5 arcana tier.")
        name = texts.get(group["NameKey"])
        if not name:
            raise ValueError("Missing Chinese arcana name.")
        member_ids = list(group["RequiredCharacterIds"])
        if len(set(member_ids)) != len(member_ids):
            raise ValueError("Duplicate arcana member.")
        for character_id in member_ids:
            if character_id == 0:
                continue
            if character_id not in roster_ids:
                character = characters.get(character_id)
                if not character or character["RarityFlags"] != 2:
                    raise ValueError("Arcana contains an unsupported playable character.")
                support_ids.add(character_id)
        groups.append({"id": group["Id"], "name": name, "characterIds": member_ids, "published": 0 not in member_ids, "lrBonuses": selected_bonuses(lr[0]), "lr5Bonuses": selected_bonuses(lr5[0]) if lr5 else None, "lr5RarityBonus": lr5[0]["CharacterRarityBonus"] if lr5 else 0, "unavailableReason": "该秘仪尚未开放" if 0 in member_ids else ""})
    support = []
    for character_id in sorted(support_ids):
        character = characters[character_id]
        name = texts.get(character["NameKey"])
        if not name:
            raise ValueError("Missing Chinese support-character name.")
        support.append({"id": character_id, "name": name, "element": ELEMENTS[character["ElementType"]], "job": character["JobFlags"], "baseRarity": 2, "freeRarity": "LR", "portrait": f"./assets/arcana-characters/{character_id}.png"})
    result = {"format": "mementomori-lr-arcana-catalog", "schemaVersion": 1, "version": 1, "snapshotDate": args.snapshot_date, "source": {"kind": "gameMasterSnapshot", "sha256": hashes}, "purchaseRarity": "LR", "permanentCharacterIds": sorted(permanent_ids | support_ids), "supportCharacters": support, "groups": groups}
    (ROOT / "public/data/arcana-catalog.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(groups)} minimal arcana groups, {len(support)} free LR support characters; full master books were not copied.")


if __name__ == "__main__":
    main()
