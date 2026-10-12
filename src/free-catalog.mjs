/** Merge only the public variable-level projections used by the free builder. */
export function createFreeCatalog(catalog, { arcana, equipmentBonuses, characterStats, freeLevels, freeEquipment }) {
  if (freeLevels?.schemaVersion !== 1 || freeEquipment?.schemaVersion !== 1) throw new Error('自由配队等级数据版本不兼容');
  // Data is shared with the cup at the site root; /free/ assets resolve one level up.
  const rebaseAssets = value => Array.isArray(value) ? value.map(rebaseAssets)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseAssets(item)]))
      : typeof value === 'string' && value.startsWith('./assets/') ? '../' + value.slice(2) : value;
  return rebaseAssets({
    ...catalog, mode: 'free', arcana, equipmentBonuses, freeLevels,
    limits: { ...catalog.limits, ...freeEquipment.limits },
    equipmentCosts: { ...catalog.equipmentCosts, ...freeEquipment.equipmentCosts },
    characterStats: { ...characterStats,
      equipment: { ...characterStats.equipment, ...freeEquipment.characterStats.equipment },
      reinforcementCoefficients: freeEquipment.characterStats.reinforcementCoefficients,
    },
  });
}
