"""Explicit maintenance: project only the twelve treasure display terms, not game masters.

Supply a local read-only master directory. No accounts, private modules, network,
equipment baselines, combat formulas, or full master records are exported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import msgpack

ROOT = Path(__file__).resolve().parents[1]
SLOTS = {1: "武器", 2: "项链", 3: "手套", 4: "头盔", 5: "衣服", 6: "脚"}
# Stable display identities only. Values are always read from their exact level row.
TERMS = {
    "legend": {
        "label": "圣装",
        "table": "EquipmentLegendSacredTreasureMB",
        "slots": {
            1: ("WeaponAttackPowerPercent", 2, "AttackPower", "攻击力", 2, "percentIncrease"),
            2: ("SubHitPercent", 5, "Hit", "命中", 2, "percentIncrease"),
            3: ("GauntletCriticalDamagePercent", 9, "CriticalDamageEnhance", "暴击伤害", 1, "addRate"),
            4: ("HelmetPhysicalCriticalDamageRelaxPercent", 10, "PhysicalCriticalDamageRelax", "物理暴伤减免", 1, "addRate"),
            5: ("ArmorMagicCriticalDamageRelaxPercent", 11, "MagicCriticalDamageRelax", "魔法暴伤减免", 1, "addRate"),
            6: ("ShoesHpDrainPercent", 18, "HpDrain", "生命吸取", 1, "addRate"),
        },
    },
    "matchless": {
        "label": "魔装",
        "table": "EquipmentMatchlessSacredTreasureMB",
        "slots": {
            1: ("WeaponAttackPower", 2, "AttackPower", "攻击力", 1, "addValue"),
            2: ("SubPhysicalDamageRelax", 3, "PhysicalDamageRelax", "物理防御", 1, "addValue"),
            3: ("GauntletMagicDamageRelax", 4, "MagicDamageRelax", "魔法防御", 1, "addValue"),
            4: ("HelmetCritical", 7, "Critical", "暴击", 1, "addValue"),
            5: ("ArmorDefensePenetration", 12, "DefensePenetration", "防御穿透", 1, "addValue"),
            6: ("ShoesHp", 1, "Hp", "生命", 1, "addValue"),
        },
    },
}


def project(master_root: Path) -> dict:
    result = {
        "schemaVersion": 1,
        "version": "equipment-bonuses-v1",
        "scope": "treasureTermsOnly",
        "supportedJobs": [1, 2, 4],
        "minimumLevel": 0,
        "maximumLevel": 40,
        "dependencies": {
            "jobIndependent": True,
            "equipmentRarityIndependent": True,
            "equipmentLevelIndependent": True,
            "weaponOwnerIndependent": True,
            "requiresEquippedSlot": True,
            "percentIncreaseNeedsCharacterBaselineForFinalPoints": True,
            "includesTotalCharacterStats": False,
            "includesCombatPower": False,
        },
        "sources": [],
        "kinds": {},
    }
    for kind, description in TERMS.items():
        raw = (master_root / description["table"]).read_bytes()
        rows = msgpack.unpackb(raw, raw=False, strict_map_key=False)
        if not isinstance(rows, list):
            raise ValueError(f"Invalid table shape: {description['table']}")
        levels = {}
        for row in rows:
            if not isinstance(row, dict) or type(row.get("Lv")) is not int:
                raise ValueError(f"Invalid treasure level row: {description['table']}")
            level = row["Lv"]
            if 0 <= level <= 40:
                if level in levels:
                    raise ValueError(f"Duplicate treasure level {level}: {description['table']}")
                levels[level] = row
        if set(levels) != set(range(41)):
            raise ValueError(f"Incomplete treasure levels 0..40: {description['table']}")
        result["sources"].append({
            "table": description["table"],
            "sha256": hashlib.sha256(raw).hexdigest(),
            "projection": "six displayed terms at exact levels 0..40",
        })
        slots = {}
        for slot, (field, parameter_id, parameter, label, change_type, operation) in description["slots"].items():
            percent = kind == "legend"
            divisor = 100 if percent else 1
            values = []
            for level in range(41):
                value = levels[level].get(field)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError(f"Invalid {field} at level {level}: {description['table']}")
                if not percent and value != int(value):
                    raise ValueError(f"Non-integral flat bonus {field} at level {level}")
                display = value / divisor
                values.append(int(display) if display == int(display) else display)
            if values[0] != 0:
                raise ValueError(f"Nonzero level-zero treasure: {field}")
            slots[str(slot)] = {
                "slot": slot,
                "slotLabel": SLOTS[slot],
                "parameterTypeId": parameter_id,
                "parameterType": parameter,
                "label": label,
                "changeParameterTypeId": change_type,
                "operation": operation,
                "unit": "percent" if percent else "flat",
                "sourceField": field,
                "sourceUnit": "basisPoints" if percent else "flat",
                "sourceToDisplayDivisor": divisor,
                "values": values,
            }
        result["kinds"][kind] = {"label": description["label"], "slots": slots}
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-root", type=Path, required=True, help="Read-only local master directory")
    arguments = parser.parse_args()
    output = ROOT / "public/data/equipment-bonuses.json"
    projection = project(arguments.master_root.resolve())
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(projection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    print("Projected twelve treasure terms at exact levels 0..40; no full master records exported.")


if __name__ == "__main__":
    main()
