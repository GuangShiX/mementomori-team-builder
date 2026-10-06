import { DomainValidationError, selectEquipmentRarity } from './domain.mjs';

// Slot identities follow the game's six equipment positions.
export const EQUIPMENT_PRESETS = Object.freeze([
  Object.freeze({ id: 'ur2-ssr4', label: '2UR / 2LR + 4SSR', composition: '2UR / 2LR + 4SSR', rarity: 'UR', highSlots: Object.freeze([1, 2]), requiresLR5: false, adaptive: true }),
  Object.freeze({ id: 'adaptive4', label: '4UR / 4LR + 2SSR', composition: '4UR / 4LR + 2SSR', rarity: 'UR', highSlots: Object.freeze([1, 2, 4, 5]), requiresLR5: false, adaptive: true }),
  Object.freeze({ id: 'lr6', label: '6UR / 6LR', composition: '6UR / 6LR', rarity: 'UR', highSlots: Object.freeze([1, 2, 3, 4, 5, 6]), requiresLR5: false, adaptive: true }),
]);

const issue = (path, code, message) => new DomainValidationError([{ path, code, message }]);

export function getEquipmentPresetOptions(member) {
  return EQUIPMENT_PRESETS.map(preset => {
    if (!preset.adaptive) return preset;
    const rarity = member?.rarity === 'LR5' ? 'LR' : 'UR';
    const count = preset.highSlots.length;
    const composition = `${count}${rarity}${count < 6 ? ` + ${6 - count}SSR` : ''}`;
    return { ...preset, rarity, label: composition, composition, requiresLR5: rarity === 'LR' };
  });
}

export function changeMemberRarity(member, rarity, catalog) {
  if (!['SR', 'LR', 'LR5'].includes(rarity) || !member || !Array.isArray(member.equipment)
    || !catalog.characters.some(character => character.id === member.characterId)) {
    throw issue('member.rarity', 'INVALID_RARITY', '请为合法角色选择SR、LR或LR5。');
  }
  return {
    ...member, rarity,
    equipment: member.equipment.map(gear => {
      const downgraded = rarity !== 'LR5' && gear.rarity === 'LR';
      const upgraded = member.rarity === 'LR' && rarity === 'LR5' && gear.rarity === 'UR';
      const next = downgraded ? selectEquipmentRarity(gear, 'UR')
        : upgraded ? selectEquipmentRarity(gear, 'LR') : { ...gear };
      return { ...next, runes: gear.runes.map(rune => ({ ...rune })) };
    }),
  };
}

export function applyEquipmentPreset(member, presetId, catalog, policy) {
  const preset = getEquipmentPresetOptions(member).find(item => item.id === presetId);
  if (!preset) throw issue('presetId', 'UNKNOWN_EQUIPMENT_PRESET', '快捷装备方案未知。');
  if (!member || !catalog.characters.some(character => character.id === member.characterId)
    || !Array.isArray(member.equipment) || member.equipment.length !== 6) {
    throw issue('member', 'INVALID_PRESET_MEMBER', '请先选择一名合法配队角色。');
  }
  if (preset.requiresLR5 && member.rarity !== 'LR5') throw issue('member.rarity', 'LR_REQUIRES_LR5', 'LR装备方案需要LR5角色，请先调整角色稀有度。');
  const equipment = member.equipment.map((gear, index) => {
    const slot = index + 1;
    if (gear.slot !== slot || !Array.isArray(gear.runes)) throw issue('member.equipment', 'INVALID_PRESET_EQUIPMENT', '快捷配装需要六个固定装备槽。');
    const rarity = preset.highSlots.includes(slot) ? preset.rarity : 'SSR';
    const weaponKind = slot === 1 ? 'exclusive' : 'normal';
    const table = catalog.equipmentCosts?.fragments?.[slot === 1 ? `exclusive${rarity}` : rarity];
    const desiredLevel = rarity !== 'SSR' && [2, 4, 5].includes(slot) ? 240 : policy.characterLevel;
    const levels = Object.keys(table ?? {}).map(Number).filter(level => Number.isSafeInteger(level) && level <= Math.min(desiredLevel, policy.characterLevel));
    if (!levels.length) throw issue(`member.equipment[${index}].level`, 'PRESET_LEVEL_UNAVAILABLE', '该部位没有符合方案的装备等级。');
    const level = Math.max(...levels);
    const reinforcementTarget = slot === 2 ? 60 : [4, 5].includes(slot) ? 240 : policy.characterLevel;
    const updated = selectEquipmentRarity(gear, rarity);
    return {
      ...updated, slot, weaponKind, level, syncSlot: 0,
      weaponOwnerCharacterId: slot === 1 ? gear.weaponKind === 'exclusive' ? gear.weaponOwnerCharacterId ?? member.characterId : member.characterId : null,
      reinforcementLevel: Math.min(reinforcementTarget, level),
      runes: gear.runes.map(rune => ({ ...rune })),
    };
  });
  return { ...member, equipment };
}
