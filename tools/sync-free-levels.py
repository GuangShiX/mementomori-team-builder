"""Maintain minimal free-builder levels and gear display/cost projections.

Reads a caller-supplied local master snapshot. Public output contains only level
curves, selected-roster four-dimensional weights and already-supported gear
attributes/cumulative fragment and medicine amounts. No full master records,
private implementation, account data, or local paths enter the output.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import msgpack

ROOT = Path(__file__).resolve().parents[1]
BASE_KEYS = ("Muscle", "Energy", "Intelligence", "Health")
COST_TABLES = ("EquipmentEvolutionMB", "EquipmentCompositeMB", "EquipmentReinforcementMaterialMB")
RANK_FIELDS = (
    "AttackPowerBonus", "AttackPowerPercentBonus", "HpBonus", "HpPercentBonus",
    "DefensePenetrationBonus", "DamageEnhanceBonus", "CriticalBonus", "HitBonus",
    "AvoidanceBonus", "DebuffHitBonus", "SpeedBonus", "CriticalDamageEnhanceBonus",
    "DamageReflectBonus", "HpDrainBonus", "HitDirectPercentBonus",
)
RARITIES = {"N": 1, "SR": 8, "LR": 512, "LR5": 16384}
GEAR_RARITIES = {128: "SSR", 256: "UR", 512: "LR"}


def load_snapshot(master_root: Path):
    original = json.loads((ROOT / "public/data/character-stats.json").read_text(encoding="utf-8"))
    tables, sources = {}, []
    for reference in original["sources"]:
        raw = (master_root / reference["table"]).read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        if sha != reference["sha256"]:
            raise ValueError(f"Snapshot differs from current display projection: {reference['table']}")
        tables[reference["table"]] = msgpack.unpackb(raw, raw=False, strict_map_key=False)
        sources.append({"table": reference["table"], "sha256": sha})
    for name in COST_TABLES:
        raw = (master_root / name).read_bytes()
        tables[name] = msgpack.unpackb(raw, raw=False, strict_map_key=False)
        sources.append({"table": name, "sha256": hashlib.sha256(raw).hexdigest()})
    return tables, sources, original


def contiguous(rows, field):
    mapped = {row[field]: row for row in rows}
    if len(mapped) != len(rows) or sorted(mapped) != list(range(1, max(mapped) + 1)):
        raise ValueError(f"Non-contiguous or duplicate supported range: {field}")
    return mapped


def project_levels(tables, sources, catalog, original):
    potential = contiguous([row for row in tables["CharacterPotentialMB"] if row["CharacterSubLevel"] == 0], "CharacterLevel")
    ranks = contiguous(tables["PlayerRankMB"], "Rank")
    characters = {row["Id"]: row for row in tables["CharacterMB"]}
    coefficients = {(row["InitialRarityFlags"], row["RarityFlags"]): row["RarityCoefficientInfo"] for row in tables["CharacterPotentialCoefficientMB"]}
    weights, rarity_coefficients = {}, {}
    for character in catalog["characters"]:
        source = characters[character["id"]]
        origin = source["RarityFlags"]
        if origin not in (1, 2, 8) or origin != character.get("baseRarity", 8) or source["JobFlags"] != character["job"]:
            raise ValueError("Selected roster identity mismatch")
        values = [source["BaseParameterCoefficient"][key] for key in BASE_KEYS]
        total = source["BaseParameterGrossCoefficient"] or sum(values)
        if total <= 0 or any(value < 0 for value in values):
            raise ValueError("Invalid selected character weights")
        weights[str(character["id"])] = {"originRarity": origin, "weights": values, "weightTotal": total}
        supported = ("N", "LR", "LR5") if origin == 1 else ("SR", "LR", "LR5")
        projected = rarity_coefficients.setdefault(str(origin), {})
        for rarity in supported:
            coefficient = coefficients[(origin, RARITIES[rarity])]
            projected[rarity] = {"m": coefficient["m"], "b": coefficient["b"]}
            natural_total = potential[450]["TotalBaseParameter"] * coefficient["m"] + coefficient["b"]
            natural = {key: int(natural_total * value / total) for key, value in zip(BASE_KEYS, values)}
            if natural != original["characters"][str(character["id"])]["baseByRarity"][rarity]:
                raise ValueError("Variable-level origin disagrees with existing 450 display projection")
    return {
        "schemaVersion": 1, "version": "free-levels-v1", "scope": "selectedRosterVariableLevels",
        "limits": {"characterLevel": {"min": 1, "max": max(potential)}, "playerLevel": {"min": 1, "max": max(ranks)}},
        "characterSubLevel": 0, "baseAttributeOrder": list(BASE_KEYS),
        "characterLevelPotential": [None] + [potential[level]["TotalBaseParameter"] for level in range(1, max(potential) + 1)],
        "characters": weights, "rarityCoefficients": rarity_coefficients,
        "playerRankFields": list(RANK_FIELDS),
        "playerRankBonuses": [None] + [[ranks[rank][key] for key in RANK_FIELDS] for rank in range(1, max(ranks) + 1)],
        "dependencies": {"includesLevelUpResourceCosts": False, "includesBattleSkillEffects": False, "includesTemporaryBattleEffects": False},
        "sources": sources[:len(original["sources"])],
    }


def project_equipment(tables, sources, catalog, original):
    spec = importlib.util.spec_from_file_location("static_display_projection", ROOT / "tools/sync-character-stats.py")
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    owners = {row["id"] for row in catalog["characters"] if row.get("hasExclusiveWeapon", True)}
    owner_jobs = {row["id"]: row["job"] for row in catalog["characters"]}
    exclusive = {row["Id"]: row for row in tables["EquipmentExclusiveEffectMB"]}
    evolution = {row["Id"]: row for row in tables["EquipmentEvolutionMB"]}
    composite = {row["Id"]: row for row in tables["EquipmentCompositeMB"]}
    equipment, fragments, allowed, owner_coverage = {}, {}, {}, {}
    equipment_by_id = {row["Id"]: row for row in tables["EquipmentMB"]}
    for row in tables["EquipmentMB"]:
        rarity = GEAR_RARITIES.get(row["RarityFlags"])
        slot, level = row["SlotType"], row["EquipmentLv"]
        if not rarity or slot not in range(1, 7):
            continue
        kind = "exclusive" if row["ExclusiveEffectId"] else "normal"
        if kind == "normal" and slot == 1 and rarity != "SSR":
            continue
        if kind == "exclusive":
            owner = exclusive[row["ExclusiveEffectId"]]["CharacterId"]
            if owner not in owners:
                continue
            if slot != 1 or row["EquippedJobFlags"] != owner_jobs[owner]:
                raise ValueError("Exclusive ownership mismatch")
            if rarity == "SSR" and level not in (180, 200, 220, 240):
                continue
            owner_coverage.setdefault((rarity, level), set()).add(owner)
        key = f"{kind}:{slot}:{rarity}:{level}"
        template = {"battleChange": helpers.effect(row["BattleParameterChangeInfo"], "battle"), "setId": row["EquipmentSetId"], "polishTotal": int(row["AdditionalParameterTotal"])}
        if key in equipment and equipment[key] != template:
            raise ValueError(f"Shared equipment template differs by owner/job: {key}")
        equipment[key] = template
        cost_key = rarity if kind == "normal" else f"exclusive{rarity}"
        recipe = composite[row["CompositeId"]]
        cumulative = recipe["RequiredFragmentCount"]
        minimum = equipment_by_id[recipe["EquipmentId"]]["EquipmentLv"]
        increments = [step for step in evolution[row["EquipmentEvolutionId"]]["EquipmentEvolutionInfoList"]
                      if step["RarityFlags"] == 0 and minimum <= step["BeforeEquipmentLv"] < step["AfterEquipmentLv"] <= level]
        current = minimum
        for step in sorted(increments, key=lambda item: item["BeforeEquipmentLv"]):
            if step["BeforeEquipmentLv"] != current:
                raise ValueError("Fragment progression is discontinuous")
            cumulative += sum(item["ItemCount"] for item in step["RequiredItemList"] if item["ItemType"] == 5 and item["ItemId"] == row["CompositeId"])
            current = step["AfterEquipmentLv"]
        if current != level:
            raise ValueError("Cannot derive selected gear level from actual recipe")
        curve = fragments.setdefault(cost_key, {})
        if str(level) in curve and curve[str(level)] != cumulative:
            raise ValueError("Fragment recipe differs among selected gear")
        curve[str(level)] = cumulative
        allowed.setdefault(cost_key, set()).add(level)
    for (rarity, level), coverage in owner_coverage.items():
        if coverage != owners:
            raise ValueError(f"Incomplete selected exclusive owner coverage: {rarity}/{level}")
    for key, curve in catalog["equipmentCosts"]["fragments"].items():
        for level, value in curve.items():
            if fragments[key][level] != value:
                raise ValueError(f"Cumulative recipe disagrees with existing published curve: {key}/{level}")
    for key, template in original["equipment"].items():
        if equipment[key] != template:
            raise ValueError(f"Equipment projection disagrees with existing display: {key}")
    material = contiguous(tables["EquipmentReinforcementMaterialMB"], "ReinforcementLevel")
    reinforcement = {}
    for kind, field in (("weapon", "WeaponRequiredItemList"), ("other", "OthersRequiredItemList")):
        curve = [0]
        for level in range(1, max(material) + 1):
            cost = sum(item["ItemCount"] for item in material[level][field] if item["ItemType"] == 12 and item["ItemId"] == 2)
            curve.append(curve[-1] + cost)
        if curve[:451] != catalog["equipmentCosts"]["reinforcement"][kind]:
            raise ValueError("Medicine curve disagrees with existing published cumulative projection")
        reinforcement[kind] = curve
    coefficients = {row["Id"]: row["ReinforcementCoefficient"] for row in tables["EquipmentReinforcementParameterMB"]}
    coefficient_curve = [1] + [coefficients[level] for level in range(1, max(coefficients) + 1)]
    if coefficient_curve[:451] != original["reinforcementCoefficients"]:
        raise ValueError("Reinforcement display disagrees with existing projection")
    return {
        "schemaVersion": 1, "version": "free-equipment-v1", "scope": "supportedGearLevelExtension",
        "limits": {"equipmentLevel": max(max(values) for values in allowed.values()), "reinforcementLevel": max(material)},
        "equipmentCosts": {"reinforcement": reinforcement,
                           "fragments": {key: dict(sorted(values.items(), key=lambda item: int(item[0]))) for key, values in fragments.items()},
                           "allowedLevels": {key: sorted(values) for key, values in allowed.items()}},
        "characterStats": {"equipment": {key: value for key, value in sorted(equipment.items()) if key not in original["equipment"]}, "reinforcementCoefficients": coefficient_curve},
        "dependencies": {"cumulativeFragmentCostsFromRecipes": True, "cumulativeMedicineCostsFromMaterials": True, "gearTemplateOwnerIndependent": True, "gearTemplateJobIndependent": True},
        "sources": sources,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-root", type=Path, required=True)
    args = parser.parse_args()
    tables, sources, original = load_snapshot(args.master_root.resolve())
    catalog = json.loads((ROOT / "public/data/catalog.json").read_text(encoding="utf-8"))
    levels = project_levels(tables, sources, catalog, original)
    gear = project_equipment(tables, sources, catalog, original)
    for name, data in (("free-levels", levels), ("free-equipment", gear)):
        output = ROOT / f"public/data/{name}.json"
        temporary = output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
        temporary.replace(output)
    print(f"Projected {len(levels['characters'])} selected identities; link 1-{levels['limits']['characterLevel']['max']}, player 1-{levels['limits']['playerLevel']['max']}; {len(gear['characterStats']['equipment'])} extra gear templates. Original fixed projection unchanged.")


if __name__ == "__main__":
    main()
