"""Explicit maintenance of the site's minimal, fixed-level stat projection.

Read the supplied local master directory without accounts, network access, or
private-module imports. Export only the selected roster's fixed-level attributes,
supported gear templates, normalized effects, and the selected player-rank bonus.
Full master records and skill implementations never enter the public output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import msgpack

ROOT = Path(__file__).resolve().parents[1]
BASE = {1: "Muscle", 2: "Energy", 3: "Intelligence", 4: "Health"}
BATTLE = {
    1: "Hp", 2: "AttackPower", 3: "PhysicalDamageRelax", 4: "MagicDamageRelax",
    5: "Hit", 6: "Avoidance", 7: "Critical", 8: "CriticalResist",
    9: "CriticalDamageEnhance", 10: "PhysicalCriticalDamageRelax",
    11: "MagicCriticalDamageRelax", 12: "DefensePenetration", 13: "Defense",
    14: "DamageEnhance", 15: "DebuffHit", 16: "DebuffResist",
    17: "DamageReflect", 18: "HpDrain", 19: "Speed",
}
CHARACTER_RARITIES = {"SR": 8, "LR": 512, "LR5": 16384}
EQUIPMENT_RARITIES = {128: "SSR", 256: "UR", 512: "LR"}
RANK_FIELDS = (
    "AttackPowerBonus", "AttackPowerPercentBonus", "HpBonus", "HpPercentBonus",
    "DefensePenetrationBonus", "DamageEnhanceBonus", "CriticalBonus", "HitBonus",
    "AvoidanceBonus", "DebuffHitBonus", "SpeedBonus", "CriticalDamageEnhanceBonus",
    "DamageReflectBonus", "HpDrainBonus", "HitDirectPercentBonus",
)
TABLES = (
    "CharacterMB", "CharacterPotentialMB", "CharacterPotentialCoefficientMB",
    "EquipmentMB", "EquipmentReinforcementParameterMB", "EquipmentExclusiveEffectMB",
    "EquipmentSetMB", "SphereMB", "PlayerRankMB",
)


def number(value: object) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Invalid numeric projection value")
    return int(value) if value == int(value) else value


def effect(info: dict | None, group: str) -> dict | None:
    if not info:
        return None
    parameter = info["BaseParameterType" if group == "base" else "BattleParameterType"]
    mode = info["ChangeParameterType"]
    if parameter not in (BASE if group == "base" else BATTLE) or mode not in (1, 2, 3):
        raise ValueError("Unsupported parameter identity or operation")
    return {"group": group, "type": parameter, "changeType": mode, "value": number(info["Value"])}


def effects(row: dict, list_fields: bool = False) -> list[dict]:
    result = []
    for group, stem in (("base", "BaseParameterChangeInfo"), ("battle", "BattleParameterChangeInfo")):
        values = (row.get(stem + "List") or []) if list_fields else [row.get(stem)]
        for info in values:
            projected = effect(info, group)
            if projected is not None:
                result.append(projected)
    return result


def one(rows: list[dict], description: str, predicate) -> dict:
    matching = [row for row in rows if predicate(row)]
    if len(matching) != 1:
        raise ValueError(f"Expected one {description}; found {len(matching)}")
    return matching[0]


def project(master_root: Path) -> dict:
    catalog_path = ROOT / "public/data/catalog.json"
    catalog_raw = catalog_path.read_bytes()
    catalog = json.loads(catalog_raw)
    selected = {row["id"]: row for row in catalog["characters"]}
    if len(selected) != len(catalog["characters"]):
        raise ValueError("Duplicate selected character")
    tables = {}
    sources = []
    for name in TABLES:
        raw = (master_root / name).read_bytes()
        rows = msgpack.unpackb(raw, raw=False, strict_map_key=False)
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise ValueError(f"Invalid master table shape: {name}")
        tables[name] = rows
        sources.append({"table": name, "sha256": hashlib.sha256(raw).hexdigest()})

    potential = one(tables["CharacterPotentialMB"], "level 450/sublevel 0 potential",
                    lambda row: row["CharacterLevel"] == 450 and row["CharacterSubLevel"] == 0)["TotalBaseParameter"]
    characters_by_id = {row["Id"]: row for row in tables["CharacterMB"]}
    characters = {}
    for character_id in sorted(selected):
        source = characters_by_id[character_id]
        if source["RarityFlags"] != 8 or source["JobFlags"] != selected[character_id]["job"]:
            raise ValueError(f"Unexpected roster identity: {character_id}")
        coefficient = source["BaseParameterCoefficient"]
        gross = source["BaseParameterGrossCoefficient"] or sum(coefficient.values())
        if gross <= 0:
            raise ValueError(f"Invalid character coefficient: {character_id}")
        base_by_rarity = {}
        for label, rarity in CHARACTER_RARITIES.items():
            rarity_info = one(tables["CharacterPotentialCoefficientMB"], f"SR-origin {label} coefficient",
                              lambda row: row["InitialRarityFlags"] == 8 and row["RarityFlags"] == rarity)["RarityCoefficientInfo"]
            total = potential * rarity_info["m"] + rarity_info["b"]
            base_by_rarity[label] = {key: int(total * coefficient[key] / gross) for key in BASE.values()}
        initial = source["InitialBattleParameter"]
        characters[str(character_id)] = {
            "job": source["JobFlags"],
            "baseByRarity": base_by_rarity,
            "initialBattle": {key: number(initial["HP" if key == "Hp" else key]) for key in BATTLE.values()},
        }

    allowed_levels = catalog["equipmentCosts"]["allowedLevels"]
    exclusive_by_id = {row["Id"]: row for row in tables["EquipmentExclusiveEffectMB"]}
    equipment = {}
    exclusive_effects = {}
    owner_coverage = {}
    for row in tables["EquipmentMB"]:
        rarity = EQUIPMENT_RARITIES.get(row["RarityFlags"])
        if rarity is None:
            continue
        slot, level = row["SlotType"], row["EquipmentLv"]
        if slot not in range(1, 7):
            continue
        exclusive_id = row["ExclusiveEffectId"]
        kind = "exclusive" if exclusive_id else "normal"
        legal_levels = [180, 200, 220, 240] if kind == "exclusive" and rarity == "SSR" else allowed_levels[rarity]
        if level not in legal_levels or (kind == "normal" and slot == 1 and rarity != "SSR"):
            continue
        if kind == "exclusive":
            exclusive = exclusive_by_id[exclusive_id]
            owner = exclusive["CharacterId"]
            if owner not in selected:
                continue
            if slot != 1 or row["EquippedJobFlags"] != selected[owner]["job"]:
                raise ValueError(f"Unexpected exclusive weapon identity: {owner}")
            changes = effects(exclusive, list_fields=True)
            value = {"baseChanges": [item for item in changes if item["group"] == "base"],
                     "battleChanges": [item for item in changes if item["group"] == "battle"]}
            exclusive_key = f"{owner}:{rarity}:{level}" if rarity == "SSR" else f"{owner}:{rarity}"
            if exclusive_key in exclusive_effects and exclusive_effects[exclusive_key] != value:
                raise ValueError(f"Owner effect varies within its projected grade: {exclusive_key}")
            exclusive_effects[exclusive_key] = value
            owner_coverage.setdefault((rarity, level), set()).add(owner)
        key = f"{kind}:{slot}:{rarity}:{level}"
        value = {"battleChange": effect(row["BattleParameterChangeInfo"], "battle"),
                 "setId": row["EquipmentSetId"], "polishTotal": int(number(row["AdditionalParameterTotal"]))}
        if key in equipment and equipment[key] != value:
            raise ValueError(f"Gear template varies with job or owner: {key}")
        equipment[key] = value
    for rarity in EQUIPMENT_RARITIES.values():
        for kind in ("normal", "exclusive"):
            levels = [180, 200, 220, 240] if kind == "exclusive" and rarity == "SSR" else allowed_levels[rarity]
            slots = [1] if kind == "exclusive" else range(1 if rarity == "SSR" else 2, 7)
            for level in levels:
                for slot in slots:
                    if f"{kind}:{slot}:{rarity}:{level}" not in equipment:
                        raise ValueError(f"Missing supported gear template: {kind}/{slot}/{rarity}/{level}")
                if kind == "exclusive" and owner_coverage.get((rarity, level)) != set(selected):
                    raise ValueError(f"Incomplete exclusive ownership coverage: {rarity}/{level}")

    set_ids = {row["setId"] for row in equipment.values()} - {0}
    sets = {}
    for row in tables["EquipmentSetMB"]:
        if row["Id"] in set_ids:
            sets[str(row["Id"])] = [{"requiredCount": item["RequiredEquipmentCount"], "effects": effects(item)}
                                    for item in row["EffectList"]]
    if set(sets) != {str(value) for value in set_ids}:
        raise ValueError("Incomplete selected gear set effects")

    rune_categories = {row["id"] for row in catalog["runeCategories"]}
    runes = {}
    for row in tables["SphereMB"]:
        if row["CategoryId"] in rune_categories and 1 <= row["Lv"] <= 15:
            key = f"{row['CategoryId']}:{row['Lv']}"
            if key in runes:
                raise ValueError(f"Duplicate rune identity: {key}")
            runes[key] = effects(row)
    if len(runes) != len(rune_categories) * 15:
        raise ValueError("Incomplete supported rune effects")

    coefficient_rows = {row["Id"]: row for row in tables["EquipmentReinforcementParameterMB"]}
    reinforcement = [1] + [number(coefficient_rows[level]["ReinforcementCoefficient"]) for level in range(1, 451)]
    rank = one(tables["PlayerRankMB"], "player rank 560", lambda row: row["Rank"] == 560)
    return {
        "schemaVersion": 1,
        "version": "character-stats-v1",
        "scope": "selectedRosterStaticStats",
        "characterLevel": 450,
        "characterSubLevel": 0,
        "characters": characters,
        "equipment": dict(sorted(equipment.items())),
        "exclusiveEffects": dict(sorted(exclusive_effects.items())),
        "runes": dict(sorted(runes.items(), key=lambda item: tuple(map(int, item[0].split(":"))))),
        "sets": dict(sorted(sets.items(), key=lambda item: int(item[0]))),
        "reinforcementCoefficients": reinforcement,
        "rank560": {"rank": 560, "bonuses": {key: number(rank[key]) for key in RANK_FIELDS}},
        "polish": {"selectedPercent": 60, "remainingDistribution": "equal", "noneDistribution": "equal", "order": list(BASE)},
        "dependencies": {
            "gearTemplateJobIndependent": True,
            "gearTemplateOwnerIndependent": True,
            "exclusiveEffectsRequireMatchingOwner": True,
            "includesBattleSkillEffects": False,
            "includesTemporaryBattleEffects": False,
            "includesAccountPotentialExtras": False,
            "percentEffectUnit": "basisPoints",
        },
        "sources": sources,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-root", type=Path, required=True, help="Read-only local master directory")
    args = parser.parse_args()
    projection = project(args.master_root.resolve())
    output = ROOT / "public/data/character-stats.json"
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(projection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(output)
    print(f"Projected {len(projection['characters'])} selected characters, {len(projection['equipment'])} shared gear templates and {len(projection['runes'])} rune effects; no full master records exported.")


if __name__ == "__main__":
    main()
