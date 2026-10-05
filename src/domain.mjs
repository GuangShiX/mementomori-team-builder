export const EQUIPMENT_SLOTS = Object.freeze([1, 2, 3, 4, 5, 6]);
export const POLISH_ATTRIBUTES = Object.freeze(['main', 'none', 'muscle', 'energy', 'health', 'intelligence']);
export const RESOURCE_KEYS = Object.freeze([
  'runeTickets', 'reinforcementMedicine', 'unidentifiedRune7', 'holySteel',
  'ssrFragments', 'urLrFragments', 'exclusiveFragments', 'lifeTreeDew',
]);

const RARITIES = ['SR', 'LR', 'LR5'];
const EQUIPMENT_RARITIES = ['NONE', 'SSR', 'UR', 'LR'];
const FORMAT = 'mementomori-team-plan';
const SCHEMA_VERSION = 1;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integerIn = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const cloneJson = value => JSON.parse(JSON.stringify(value));
const round = (value, precision = 2) => {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const error = (errors, path, code, message) => errors.push({ path, code, message });
const defaultSeries = rarity => ({ SSR: 12, UR: 13, LR: 14 }[rarity] ?? null);
const getSeries = catalog => catalog.equipmentSeries ?? catalog.series;
const getFixedRuneTiers = stock => stock?.tiers ?? (stock ? [{ level: stock.level, perCategory: stock.perCategory }] : []);
const legacySyncSettings = () => ({ minimumLevel: 300, maximumSourceCount: 3, slots: [{ slot: 1, requiredAnchors: 2 }, { slot: 2, requiredAnchors: 3 }] });
const automaticWeaponPricing = policy => policy.weaponSync?.mode === 'automatic';
const syncSettings = policy => automaticWeaponPricing(policy) ? legacySyncSettings() : policy.weaponSync ?? legacySyncSettings();
const weaponOwnerId = (member, gear = member?.equipment?.[0]) => gear?.weaponOwnerCharacterId ?? member?.characterId;
const highestRarity = (left, right) => RARITIES[Math.max(RARITIES.indexOf(left), RARITIES.indexOf(right))] ?? null;
const blessingEffect = blessing => blessing.effect ?? 'resourceAllowance';

function validateResourceAllowances(policy, errors) {
  for (const key of RESOURCE_KEYS) {
    if (!finiteNonnegative(policy.allowances?.[key] ?? 0)) error(errors, `policy.allowances.${key}`, 'INVALID_ALLOWANCE', '免费材料额度必须为非负数。');
  }
  if (policy.blessings === undefined) return;
  if (!Array.isArray(policy.blessings)) {
    error(errors, 'policy.blessings', 'INVALID_BLESSINGS', '赐福必须为有效的额度列表。');
    return;
  }
  const seen = new Set();
  const craftingTargets = new Set();
  const fragmentBaselineResources = new Set();
  policy.blessings.forEach((blessing, index) => {
    const path = `policy.blessings[${index}]`;
    if (!isObject(blessing) || typeof blessing.id !== 'string' || blessing.id.length === 0 || seen.has(blessing.id)
      || typeof blessing.name !== 'string' || blessing.name.length === 0 || !RESOURCE_KEYS.includes(blessing.resource)) {
      error(errors, path, 'INVALID_BLESSING', '赐福必须包含唯一编号、名称及已知材料。');
      return;
    }
    seen.add(blessing.id);
    const effect = blessingEffect(blessing);
    if (effect === 'resourceAllowance') {
      if (!finiteNonnegative(blessing.amount)) error(errors, path, 'INVALID_BLESSING', '材料额度赐福必须包含非负额度。');
    } else if (effect === 'resourceDiamondAllowance') {
      if (!['lifeTreeDew', 'exclusiveFragments'].includes(blessing.resource) || !finiteNonnegative(blessing.amount)) {
        error(errors, path, 'INVALID_DIAMOND_BLESSING', '钻石额度赐福仅支持叶子与专武碎片／紫水晶的独立非负钻石预算。');
      }
    } else if (effect === 'freeExclusiveFragmentBaseline') {
      if (blessing.resource !== 'exclusiveFragments' || blessing.rarity !== 'UR'
        || !integerIn(blessing.level, 1, policy.characterLevel) || blessing.amount !== undefined) {
        error(errors, path, 'INVALID_EXCLUSIVE_BASELINE_BLESSING', '专武制作基线赐福必须指定有效 UR 等级与专武碎片，不包含叶子或钻石额度。');
      }
      if (fragmentBaselineResources.has(blessing.resource)) error(errors, path, 'DUPLICATE_EXCLUSIVE_BASELINE_BLESSING', '每把专武的制作基线赐福不能重复配置。');
      fragmentBaselineResources.add(blessing.resource);
    } else if (effect === 'freeEquipmentCrafting') {
      if (blessing.rarity !== 'SSR' || blessing.weaponKind !== 'normal' || blessing.resource !== 'ssrFragments' || blessing.amount !== undefined) {
        error(errors, path, 'INVALID_CRAFTING_BLESSING', '制作赐福仅免普通 SSR 装备的 SSR 碎片，不包含专武、UR／LR或养成额度。');
      }
      const target = `${blessing.rarity}:${blessing.weaponKind}:${blessing.resource}`;
      if (craftingTargets.has(target)) error(errors, path, 'DUPLICATE_CRAFTING_BLESSING', '同一装备制作权益不能重复配置赐福。');
      craftingTargets.add(target);
    } else error(errors, path, 'UNKNOWN_BLESSING_EFFECT', '赐福效果类型未知，无法估价。');
  });
  if (errors.length === 0) for (const key of RESOURCE_KEYS) {
    if (!finiteNonnegative(resourceAllowanceDetails(policy, key).freeAllowance)) error(errors, `policy.blessings`, 'INVALID_ALLOWANCE', '赐福与基础额度之和必须为有效非负数。');
    if (!finiteNonnegative(resourceDiamondAllowance(policy, key))) error(errors, 'policy.blessings', 'INVALID_DIAMOND_BLESSING', '赐福钻石预算之和必须为有效非负数。');
  }
}

function resourceAllowanceDetails(policy, resource) {
  const baseAllowance = policy.allowances?.[resource] ?? 0;
  const blessingAllowance = (policy.blessings ?? []).filter(blessing => blessingEffect(blessing) === 'resourceAllowance' && blessing.resource === resource).reduce((sum, blessing) => sum + blessing.amount, 0);
  return { baseAllowance, blessingAllowance, freeAllowance: baseAllowance + blessingAllowance };
}

function resourceDiamondAllowance(policy, resource) {
  return (policy.blessings ?? []).filter(blessing => blessingEffect(blessing) === 'resourceDiamondAllowance' && blessing.resource === resource).reduce((sum, blessing) => sum + blessing.amount, 0);
}

function validateExclusiveFragmentBaselines(policy, catalog, errors) {
  if (!Array.isArray(policy.blessings)) return;
  for (const [index, blessing] of policy.blessings.entries()) {
    if (!isObject(blessing) || blessingEffect(blessing) !== 'freeExclusiveFragmentBaseline') continue;
    const key = `exclusive${blessing.rarity}`;
    const amount = catalog.equipmentCosts?.fragments?.[key]?.[blessing.level];
    const allowed = catalog.equipmentCosts?.allowedLevels?.[key];
    if (!finiteNonnegative(amount) || (Array.isArray(allowed) && !allowed.includes(blessing.level))) {
      error(errors, `policy.blessings[${index}].level`, 'UNAVAILABLE_EXCLUSIVE_BASELINE', '专武赐福基线必须在当前公开累计制作表中可用。');
    }
  }
}

export function getResourceAllowance(policy, resource) {
  const errors = [];
  if (!RESOURCE_KEYS.includes(resource)) error(errors, 'resource', 'UNKNOWN_RESOURCE', '材料类型未知，无法取得免费额度。');
  validateResourceAllowances(policy, errors);
  if (errors.length) throw new DomainValidationError(errors);
  return resourceAllowanceDetails(policy, resource).freeAllowance;
}

export function getResourceDiamondAllowance(policy, resource) {
  const errors = [];
  if (!RESOURCE_KEYS.includes(resource)) error(errors, 'resource', 'UNKNOWN_RESOURCE', '材料类型未知，无法取得钻石额度。');
  validateResourceAllowances(policy, errors);
  if (errors.length) throw new DomainValidationError(errors);
  return resourceDiamondAllowance(policy, resource);
}

const arcanaGroups = catalog => Array.isArray(catalog?.arcana?.groups) ? catalog.arcana.groups : [];
const arcanaSupport = catalog => Array.isArray(catalog?.arcana?.supportCharacters) ? catalog.arcana.supportCharacters : [];
const arcanaCharacter = (catalog, id) => catalog.characters.find(character => character.id === id) ?? arcanaSupport(catalog).find(character => character?.id === id);
const publishedArcana = group => group?.published !== false;

function validateArcanaBonuses(bonuses, path, errors) {
  if (!Array.isArray(bonuses)) { error(errors, path, 'INVALID_ARCANA_BONUS', '秘仪加成列表无效。'); return; }
  bonuses.forEach((bonus, index) => {
    if (!isObject(bonus) || !['base', 'battle'].includes(bonus.kind) || !Number.isSafeInteger(bonus.type) || bonus.type < 1
      || typeof bonus.name !== 'string' || bonus.name.length === 0 || ![1, 2, 3].includes(bonus.changeType)
      || !Number.isSafeInteger(bonus.value) || bonus.value < 1
      || (bonus.unit !== undefined && !['flat', 'percent', 'perLevel'].includes(bonus.unit))
      || (bonus.scope !== undefined && bonus.scope !== 'allCharacters')) {
      error(errors, `${path}[${index}]`, 'INVALID_ARCANA_BONUS', '秘仪加成必须包含有效属性、变化类型及正整数原值。');
    }
  });
}

function formatArcanaBonus(bonus, characterLevel) {
  const unit = bonus.unit ?? (bonus.changeType === 2 ? 'percent' : bonus.changeType === 3 ? 'perLevel' : 'flat');
  const effectiveValue = unit === 'percent' ? bonus.value / 100 : unit === 'perLevel' ? bonus.value * characterLevel : bonus.value;
  return { ...bonus, unit, label: bonus.label ?? bonus.name, effectiveValue,
    displayValue: `+${effectiveValue.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}${unit === 'percent' ? '%' : unit === 'perLevel' ? `（${characterLevel}级）` : ''}` };
}

function validateArcanaCatalog(catalog, errors) {
  const arcana = catalog.arcana;
  if (arcana === undefined) return;
  if (!isObject(arcana) || arcana.schemaVersion !== 1 || !Array.isArray(arcana.groups) || !Array.isArray(arcana.permanentCharacterIds)) {
    error(errors, 'catalog.arcana', 'INVALID_ARCANA_CATALOG', '秘仪目录必须包含有效的 LR 组及常驻角色名单。');
    return;
  }
  if (arcana.format !== undefined && arcana.format !== 'mementomori-lr-arcana-catalog') error(errors, 'catalog.arcana.format', 'INVALID_ARCANA_CATALOG', '秘仪目录格式不受支持。');
  if (arcana.purchaseRarity !== undefined && arcana.purchaseRarity !== 'LR') error(errors, 'catalog.arcana.purchaseRarity', 'INVALID_ARCANA_TIER', '只提供 LR 档秘仪购买。');
  if (arcana.supportCharacters !== undefined && !Array.isArray(arcana.supportCharacters)) error(errors, 'catalog.arcana.supportCharacters', 'INVALID_ARCANA_SUPPORT', '秘仪 R 角色列表无效。');
  const supportIds = new Set();
  arcanaSupport(catalog).forEach((character, index) => {
    if (!isObject(character) || !Number.isSafeInteger(character.id) || character.id < 1 || supportIds.has(character.id)
      || catalog.characters.some(actor => actor.id === character.id) || typeof character.name !== 'string' || !character.name
      || !['blue', 'red', 'green', 'yellow', 'light', 'dark'].includes(character.element) || ![1, 2, 4].includes(character.job)
      || character.baseRarity !== 2 || character.freeRarity !== 'LR') error(errors, `catalog.arcana.supportCharacters[${index}]`, 'INVALID_ARCANA_SUPPORT', '秘仪支持角色只能包含不重复的免费 LR 档 R 角色。');
    supportIds.add(character?.id);
  });
  if (new Set(arcana.permanentCharacterIds).size !== arcana.permanentCharacterIds.length
    || arcana.permanentCharacterIds.some(id => !Number.isSafeInteger(id) || !arcanaCharacter(catalog, id))) {
    error(errors, 'catalog.arcana.permanentCharacterIds', 'INVALID_PERMANENT_CHARACTER_IDS', '常驻角色名单必须是目录中不重复的角色编号。');
  }
  const seen = new Set();
  arcana.groups.forEach((group, index) => {
    const path = `catalog.arcana.groups[${index}]`;
    if (!isObject(group) || !Number.isSafeInteger(group.id) || group.id < 1 || seen.has(group.id)
      || typeof group.name !== 'string' || group.name.length === 0 || !Array.isArray(group.characterIds) || group.characterIds.length === 0
      || new Set(group.characterIds).size !== group.characterIds.length || group.characterIds.some(id => !Number.isSafeInteger(id) || (!arcanaCharacter(catalog, id) && !(group.published === false && id === 0)))
      || !Array.isArray(group.lrBonuses) || (group.rarity !== undefined && group.rarity !== 'LR')
      || (group.published !== undefined && typeof group.published !== 'boolean')
      || (group.rarityFlag !== undefined && group.rarityFlag !== 512)
      || (group.collectionLevel !== undefined && group.collectionLevel !== 3)
      || (group.lr5RarityBonus !== undefined && (!Number.isSafeInteger(group.lr5RarityBonus) || group.lr5RarityBonus < 0))) {
      error(errors, path, 'INVALID_ARCANA_GROUP', '秘仪组必须包含唯一编号、已知角色及 LR 加成。');
      return;
    }
    seen.add(group.id);
    validateArcanaBonuses(group.lrBonuses, `${path}.lrBonuses`, errors);
    if (group.lr5Bonuses !== undefined && group.lr5Bonuses !== null) validateArcanaBonuses(group.lr5Bonuses, `${path}.lr5Bonuses`, errors);
  });
}

function validateArcanaSelection(team, catalog, errors) {
  const purchased = team?.purchasedArcanaIds === undefined ? [] : team.purchasedArcanaIds;
  if (!Array.isArray(purchased)) {
    error(errors, 'purchasedArcanaIds', 'INVALID_ARCANA_SELECTION', '购买秘仪必须为不重复的 LR 秘仪编号列表。');
    return;
  }
  const seen = new Set();
  purchased.forEach((id, index) => {
    if (!Number.isSafeInteger(id) || seen.has(id) || !arcanaGroups(catalog).some(group => group?.id === id && publishedArcana(group))) {
      error(errors, `purchasedArcanaIds[${index}]`, 'INVALID_ARCANA_SELECTION', '秘仪编号未知、重复或不是可购买的 LR 秘仪。');
    }
    seen.add(id);
  });
}

export function getArcanaRequiredRarity(team, characterId, catalog) {
  const purchased = Array.isArray(team?.purchasedArcanaIds) ? team.purchasedArcanaIds : [];
  return arcanaGroups(catalog).some(group => publishedArcana(group) && purchased.includes(group?.id) && group?.characterIds?.includes(characterId)) ? 'LR' : null;
}

function characterLedger(team, catalog, freeLibrary) {
  const ledger = new Map();
  const add = (id, rarity, source, metadata = {}) => {
    const character = arcanaCharacter(catalog, id);
    if (!character || !RARITIES.includes(rarity)) return;
    const entry = ledger.get(id) ?? { characterId: id, characterName: character.name, element: character.element,
      rarity: null, requiredRarity: null, freeRarity: null, teamRarity: null, reserveRarity: null,
      position: null, sourceIndex: null, purchasedArcanaIds: [], sourceKinds: [], support: character.baseRarity === 2 };
    entry.rarity = highestRarity(entry.rarity, rarity);
    if (source === 'freeLibrary') entry.freeRarity = rarity;
    else entry.requiredRarity = highestRarity(entry.requiredRarity, rarity);
    if (!entry.sourceKinds.includes(source)) entry.sourceKinds.push(source);
    Object.assign(entry, metadata);
    ledger.set(id, entry);
  };
  (Array.isArray(team?.members) ? team.members : []).forEach((member, index) => {
    if (member) add(member.characterId, member.rarity, 'team', { teamRarity: member.rarity, position: index + 1 });
  });
  (Array.isArray(team?.weaponSources) ? team.weaponSources : []).forEach((source, index) => add(source.characterId, source.characterRarity, 'reserve', { reserveRarity: source.characterRarity, sourceIndex: index }));
  for (const group of arcanaGroups(catalog)) {
    if (!publishedArcana(group) || !(Array.isArray(team?.purchasedArcanaIds) ? team.purchasedArcanaIds : []).includes(group.id)) continue;
    for (const id of Array.isArray(group.characterIds) ? group.characterIds : []) {
      add(id, 'LR', 'arcana');
      const entry = ledger.get(id);
      if (entry) entry.purchasedArcanaIds.push(group.id);
    }
  }
  for (const entry of Array.isArray(freeLibrary?.characters) ? freeLibrary.characters : []) add(entry.characterId, entry.rarity, 'freeLibrary');
  for (const character of arcanaSupport(catalog)) add(character.id, character.freeRarity, 'freeLibrary');
  return [...ledger.values()];
}

export function getArcanaState(team, catalog, policy, freeLibrary) {
  const errors = [];
  validateArcanaCatalog(catalog, errors);
  validateArcanaSelection(team, catalog, errors);
  if (policy.arcana?.mode !== undefined && policy.arcana.mode !== 'ownedRarity') error(errors, 'policy.arcana.mode', 'INVALID_ARCANA_MODE', '秘仪档位必须按角色实际持有稀有度判断。');
  if (errors.length) return { groups: [], ledger: [], lrBonuses: [], bonusRows: [], errors };
  const ledger = characterLedger(team, catalog, freeLibrary);
  const groups = errors.length ? [] : arcanaGroups(catalog).map(group => {
    const published = publishedArcana(group);
    const missingCharacters = published ? group.characterIds.flatMap(id => {
      const character = arcanaCharacter(catalog, id);
      const owned = ledger.find(entry => entry.characterId === id);
      if (RARITIES.indexOf(owned?.rarity) >= RARITIES.indexOf('LR')) return [];
      const tier = ['light', 'dark'].includes(character.element) ? 'lightDark' : 'normal';
      const copies = policy.copies?.LR?.[tier];
      const ownedCopies = owned?.rarity ? policy.copies?.[owned.rarity]?.[tier] : 0;
      const unitPrice = policy.unitPrices?.characterCopy;
      if (!Number.isSafeInteger(copies) || copies < 1 || !Number.isSafeInteger(ownedCopies) || ownedCopies < 0 || !finiteNonnegative(unitPrice)) error(errors, 'policy.copies', 'INVALID_CHARACTER_PRICE', 'LR 秘仪的本体数量或单价规则无效。');
      return [{ characterId: id, characterName: character.name, fromRarity: owned?.rarity ?? null, targetRarity: 'LR', diamonds: round(Math.max(0, copies - ownedCopies) * unitPrice, policy.rounding?.precision ?? 2) }];
    }) : [];
    const purchased = (team?.purchasedArcanaIds ?? []).includes(group.id);
    const permanent = group.characterIds.every(id => catalog.arcana.permanentCharacterIds.includes(id));
    const automaticallyUnlocked = published && permanent && group.characterIds.every(id => RARITIES.indexOf(ledger.find(entry => entry.characterId === id)?.freeRarity) >= RARITIES.indexOf('LR'));
    const lr5Unlocked = published && Array.isArray(group.lr5Bonuses) && group.characterIds.every(id => ledger.find(entry => entry.characterId === id)?.rarity === 'LR5');
    const bonuses = lr5Unlocked ? group.lr5Bonuses : group.lrBonuses;
    return { id: group.id, name: group.name, characterIds: [...group.characterIds], purchased, permanent, published,
      automaticallyUnlocked, unlocked: published && missingCharacters.length === 0,
      missingCharacters, missingCharacterIds: missingCharacters.map(character => character.characterId),
      currentPurchaseDiamonds: published ? round(missingCharacters.reduce((sum, character) => sum + character.diamonds, 0), policy.rounding?.precision ?? 2) : null,
      bonusTierLabel: lr5Unlocked ? 'LR5' : 'LR', lr5Unlocked, unavailableReason: group.unavailableReason ?? '',
      lr5RarityBonus: lr5Unlocked ? group.lr5RarityBonus ?? null : null,
      bonuses: bonuses.map(bonus => formatArcanaBonus(bonus, policy.characterLevel)) };
  });
  const totals = new Map();
  for (const group of groups.filter(item => item.unlocked)) for (const bonus of group.bonuses) {
    const key = JSON.stringify([bonus.kind, bonus.type, bonus.changeType]);
    const row = totals.get(key) ?? { ...bonus, value: 0, arcanaIds: [] };
    row.value += bonus.value;
    row.arcanaIds.push(group.id);
    totals.set(key, row);
  }
  const lrBonuses = [...totals.values()].map(bonus => formatArcanaBonus(bonus, policy.characterLevel));
  return { groups, ledger, lrBonuses, bonusRows: lrBonuses, errors };
}

export function setArcanaPurchased(team, id, purchased, catalog, policy, freeLibrary) {
  const errors = [];
  validateArcanaCatalog(catalog, errors);
  validateArcanaSelection(team, catalog, errors);
  const group = arcanaGroups(catalog).find(item => item?.id === id && publishedArcana(item));
  if (!group || typeof purchased !== 'boolean') error(errors, 'purchasedArcanaIds', 'INVALID_ARCANA_SELECTION', '仅支持购买或取消当前目录中的 LR 秘仪。');
  if (errors.length) throw new DomainValidationError(errors);
  const selected = new Set(team.purchasedArcanaIds ?? []);
  if (purchased) selected.add(id); else selected.delete(id);
  return { ...team, purchasedArcanaIds: [...selected], members: team.members.map(member => member && purchased && group.characterIds.includes(member.characterId) && member.rarity === 'SR' ? { ...member, rarity: 'LR' } : member) };
}

export function isWeaponOwnerClaimed(team, memberIndex, ownerId) {
  return (team?.members ?? []).some((member, index) => index !== memberIndex && member?.equipment?.[0]?.weaponKind === 'exclusive' && member.equipment[0].rarity !== 'NONE' && weaponOwnerId(member) === ownerId)
    || (Array.isArray(team?.weaponSources) ? team.weaponSources : []).some(source => source?.characterId === ownerId);
}

export function getBorrowableWeapons(team, memberIndex, catalog, freeLibrary) {
  const member = team?.members?.[memberIndex];
  const actor = catalog.characters.find(item => item.id === member?.characterId);
  if (!actor || ![1, 2, 4].includes(actor.job)) return [];
  return (Array.isArray(freeLibrary?.exclusiveWeapons) ? freeLibrary.exclusiveWeapons : []).flatMap(weapon => {
    const owner = catalog.characters.find(item => item.id === weapon.characterId);
    return weapon.rarity === 'UR' && owner?.job === actor.job && !isWeaponOwnerClaimed(team, memberIndex, owner.id)
      ? [{ ...weapon, characterName: owner.name, job: owner.job }] : [];
  }).sort((a, b) => b.level - a.level || a.characterId - b.characterId);
}

export function deriveWeaponPricing(team, catalog, policy) {
  const rules = policy.weaponSync;
  const automatic = automaticWeaponPricing(policy);
  let qualifyingCount = 0;
  const seenOwners = new Set();
  const weapons = (Array.isArray(team?.members) ? team.members : []).flatMap((member, index) => {
    const gear = member?.equipment?.[0];
    if (!gear || gear.rarity === 'NONE') return [];
    const ownerId = weaponOwnerId(member, gear);
    const qualifies = automatic && gear.weaponKind === 'exclusive' && ['UR', 'LR'].includes(gear.rarity)
      && gear.level === rules.targetLevel && !seenOwners.has(ownerId);
    if (gear.weaponKind === 'exclusive') seenOwners.add(ownerId);
    const ordinal = qualifies ? ++qualifyingCount : null;
    const discounted = qualifies && rules.discountedOrdinals.includes(ordinal);
    return [{ position: index + 1, characterId: member.characterId, weaponOwnerCharacterId: ownerId,
      level: gear.level, effectiveLevel: gear.level, billedLevel: discounted ? rules.billedLevel : gear.level,
      craftingLevel: discounted ? rules.billedLevel : gear.level, ordinal, discountOrdinal: ordinal,
      discounted, automaticSyncDiscount: discounted }];
  });
  return { mode: automatic ? 'automatic' : 'manual', qualifyingCount, discountCount: weapons.filter(weapon => weapon.discounted).length, weapons, errors: [] };
}

export function deriveWeaponSync(team, catalog, policy, freeLibrary) {
  const settings = syncSettings(policy);
  const errors = [];
  const members = Array.isArray(team?.members) ? team.members : [];
  const targets = new Set(members.filter(member => member?.equipment?.[0]?.syncSlot > 0).map(member => weaponOwnerId(member)));
  const candidates = new Map();
  const add = (weapon, source) => {
    if (!weapon || targets.has(weapon.characterId) || !['UR', 'LR'].includes(weapon.rarity)
      || !integerIn(weapon.level, settings.minimumLevel, policy.characterLevel)) return;
    const character = catalog.characters.find(item => item.id === weapon.characterId);
    if (!character) return;
    const previous = candidates.get(weapon.characterId);
    if (!previous || weapon.level > previous.level || (weapon.level === previous.level && source !== 'freeLibrary')) {
      candidates.set(weapon.characterId, { characterId: weapon.characterId, characterName: character.name, rarity: weapon.rarity, level: weapon.level, source });
    }
  };
  for (const weapon of Array.isArray(freeLibrary?.exclusiveWeapons) ? freeLibrary.exclusiveWeapons : []) add(weapon, 'freeLibrary');
  for (const member of members) {
    const gear = member?.equipment?.[0];
    if (gear?.weaponKind === 'exclusive' && !(gear.syncSlot > 0)) {
      const ownerId = weaponOwnerId(member, gear);
      candidates.delete(ownerId);
      add({ characterId: ownerId, rarity: gear.rarity, level: gear.level }, 'team');
    }
  }
  for (const weapon of Array.isArray(team?.weaponSources) ? team.weaponSources : []) {
    candidates.delete(weapon?.characterId);
    add(weapon, 'reserve');
  }
  const anchors = [...candidates.values()].sort((a, b) => b.level - a.level || a.characterId - b.characterId);
  const slots = settings.slots.map(config => {
    const usedBy = members.flatMap((member, index) => member?.equipment?.[0]?.syncSlot === config.slot ? [index + 1] : []);
    const chosen = anchors.slice(0, config.requiredAnchors);
    const available = chosen.length === config.requiredAnchors;
    return { slot: config.slot, requiredAnchors: config.requiredAnchors, available, effectiveLevel: available ? Math.min(...chosen.map(item => item.level)) : null, usedBy, anchors: chosen };
  });
  const effectiveLevels = members.map((member, index) => {
    const gear = member?.equipment?.[0];
    if (!gear) return null;
    const syncSlot = gear.syncSlot ?? 0;
    if (syncSlot === 0) return gear.level;
    const path = `members[${index}].equipment[0].syncSlot`;
    const slot = slots.find(item => item.slot === syncSlot);
    if (!slot) { error(errors, path, 'INVALID_WEAPON_SYNC_SLOT', '武器同步仅支持关闭、第 1 槽或第 2 槽。'); return null; }
    if (!slot.available) error(errors, path, 'INSUFFICIENT_SYNC_ANCHORS', `第 ${syncSlot} 同步槽需要 ${slot.requiredAnchors} 种真实制作的 300 级以上专武作为基石。`);
    if (slot.usedBy.length > 1) error(errors, path, 'DUPLICATE_WEAPON_SYNC_SLOT', `第 ${syncSlot} 同步槽只能放入一件专武。`);
    if (slot.available && gear.level > slot.effectiveLevel) error(errors, path, 'SYNC_LEVEL_BELOW_BASE', '同步等级不能低于该武器已制作的等级，请提高基石或解除同步。');
    return slot.effectiveLevel;
  });
  return { anchors, slots, effectiveLevels, errors };
}

function validateFreeLibrary(library, catalog, errors) {
  if (library == null) return;
  if (!isObject(library) || library.format !== 'mementomori-free-library' || library.schemaVersion !== 1 || !Number.isSafeInteger(library.version)
    || library.version < 1 || !Array.isArray(library.characters) || !Array.isArray(library.exclusiveWeapons)) {
    error(errors, 'freeLibrary', 'INVALID_FREE_LIBRARY', '免费库格式或版本无效。');
    return;
  }
  for (const [group, entries] of [['characters', library.characters], ['exclusiveWeapons', library.exclusiveWeapons]]) {
    const seen = new Set();
    for (const [index, entry] of entries.entries()) {
      const path = `freeLibrary.${group}[${index}]`;
      if (!isObject(entry) || !catalog.characters.some(character => character.id === entry.characterId) || seen.has(entry.characterId)) {
        error(errors, path, 'INVALID_FREE_LIBRARY_CHARACTER', '免费库角色必须来自当前目录且不能重复。');
        continue;
      }
      seen.add(entry.characterId);
      if (group === 'characters' && !RARITIES.includes(entry.rarity)) error(errors, `${path}.rarity`, 'INVALID_FREE_CHARACTER_RARITY', '免费角色稀有度仅支持 SR、LR 和 LR5。');
      if (group === 'exclusiveWeapons' && (!['SSR', 'UR', 'LR'].includes(entry.rarity)
        || !integerIn(entry.level, 1, 450)
        || !finiteNonnegative(catalog.equipmentCosts?.fragments?.[`exclusive${entry.rarity}`]?.[entry.level]))) {
        error(errors, path, 'INVALID_FREE_WEAPON', '免费专武的系列、等级或累计材料配置无效。');
      }
    }
  }
}

export class DomainValidationError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('；'));
    this.name = 'DomainValidationError';
    this.errors = errors;
  }
}

export function createEquipment(slot) {
  if (!EQUIPMENT_SLOTS.includes(slot)) throw new RangeError('装备槽必须为 1 至 6。');
  return {
    slot, rarity: 'NONE', seriesId: null, weaponKind: 'normal', level: 450, syncSlot: 0,
    polishAttribute: 'main',
    reinforcementLevel: 0, legendSacredTreasureLevel: 0, matchlessSacredTreasureLevel: 0,
    runes: Array.from({ length: 4 }, () => ({ categoryId: 5, level: 0 })),
  };
}

export function selectEquipmentRarity(gear, rarity) {
  if (!isObject(gear) || !EQUIPMENT_SLOTS.includes(gear.slot)) throw new RangeError('装备槽必须为 1 至 6。');
  if (!EQUIPMENT_RARITIES.includes(rarity)) throw new RangeError('装备稀有度仅支持无装备、SSR、UR 和 LR。');
  if (rarity === 'NONE') return createEquipment(gear.slot);
  return {
    ...gear, rarity, seriesId: defaultSeries(rarity),
    polishAttribute: gear.polishAttribute === undefined ? 'main' : gear.polishAttribute,
    matchlessSacredTreasureLevel: gear.rarity === 'NONE' ? 40 : gear.matchlessSacredTreasureLevel,
    runes: gear.runes.map(rune => ({ ...rune })),
  };
}

export function createMember(character) {
  const characterId = isObject(character) ? character.id : character;
  if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new RangeError('角色编号无效。');
  return { characterId, rarity: 'SR', equipment: EQUIPMENT_SLOTS.map(createEquipment) };
}

export function createTeam() {
  return { name: '我的配队', author: '', notes: '', level: 450, members: Array(5).fill(null), weaponSources: [], purchasedArcanaIds: [] };
}

export function cloneTeam(team) {
  return {
    name: team.name, author: team.author ?? '', notes: team.notes ?? '', level: team.level,
    purchasedArcanaIds: [...(team.purchasedArcanaIds ?? [])],
    weaponSources: (team.weaponSources ?? []).map(weapon => ({ characterId: weapon.characterId, characterRarity: weapon.characterRarity, rarity: weapon.rarity, level: weapon.level })),
    members: team.members.map(member => member === null ? null : {
      characterId: member.characterId, rarity: member.rarity,
      equipment: member.equipment.map(gear => ({
        slot: gear.slot, rarity: gear.rarity,
        seriesId: gear.seriesId ?? defaultSeries(gear.rarity),
        weaponKind: gear.weaponKind ?? 'normal', level: gear.level, syncSlot: gear.syncSlot ?? 0,
        polishAttribute: gear.polishAttribute === undefined ? 'main' : gear.polishAttribute,
        weaponOwnerCharacterId: gear.slot === 1 ? weaponOwnerId(member, gear) : null,
        reinforcementLevel: gear.reinforcementLevel,
        legendSacredTreasureLevel: gear.legendSacredTreasureLevel,
        matchlessSacredTreasureLevel: gear.matchlessSacredTreasureLevel,
        runes: gear.runes.map(rune => ({ categoryId: rune.categoryId, level: rune.level })),
      })),
    }),
  };
}

function validateStructure(team, catalog, policy, { requireFullTeam = false, freeLibrary } = {}) {
  const errors = [];
  if (!isObject(catalog) || !Array.isArray(catalog.characters) || !Array.isArray(catalog.runeCategories)) {
    error(errors, 'catalog', 'INVALID_CATALOG', '角色或符石目录无效。');
    return errors;
  }
  if (!isObject(policy) || !Number.isSafeInteger(policy.characterLevel)) {
    error(errors, 'policy.characterLevel', 'INVALID_POLICY', '计价规则缺少固定角色等级。');
    return errors;
  }
  if (policy.allowanceScope != null && policy.allowanceScope !== 'wholeTeam') error(errors, 'policy.allowanceScope', 'UNSUPPORTED_ALLOWANCE_SCOPE', '当前规则仅支持整支配队共享免费材料额度。');
  if (policy.rounding?.mode != null && policy.rounding.mode !== 'roundFinalTotal') error(errors, 'policy.rounding.mode', 'UNSUPPORTED_ROUNDING_MODE', '当前规则按原始费用求和后舍入总价。');
  if (!integerIn(policy.rounding?.precision ?? 2, 0, 6)) error(errors, 'policy.rounding.precision', 'INVALID_ROUNDING_PRECISION', '报价小数位数必须为 0 至 6 的整数。');
  validateResourceAllowances(policy, errors);
  validateExclusiveFragmentBaselines(policy, catalog, errors);
  validateArcanaCatalog(catalog, errors);
  if (automaticWeaponPricing(policy)) {
    const rules = policy.weaponSync;
    if (rules.targetLevel !== 450 || rules.billedLevel !== 300 || !Array.isArray(rules.discountedOrdinals)
      || rules.discountedOrdinals.length !== 2 || rules.discountedOrdinals[0] !== 3 || rules.discountedOrdinals[1] !== 6) {
      error(errors, 'policy.weaponSync', 'INVALID_AUTOMATIC_WEAPON_PRICING', '自动专武造价规则必须将第 3／6 把 450 级 UR／LR 专武的制作材料按 300 级计价。');
    }
  }
  const syncPolicy = syncSettings(policy);
  if (!isObject(syncPolicy) || syncPolicy.minimumLevel !== 300 || !integerIn(syncPolicy.maximumSourceCount, 0, 20)
    || !Array.isArray(syncPolicy.slots) || syncPolicy.slots.length !== 2
    || ![1, 2].every(slot => syncPolicy.slots.some(item => item?.slot === slot && item.requiredAnchors === slot + 1))) {
    error(errors, 'policy.weaponSync', 'INVALID_WEAPON_SYNC_POLICY', '武器同步规则必须保留 300 级门槛、第 1 槽两种基石和第 2 槽三种基石。');
  }
  if (policy.conversions?.magicCrystalPrice !== undefined) {
    const crystalPrice = policy.conversions.magicCrystalPrice;
    const crystals = policy.conversions.magicCrystalsPerExclusiveExchange ?? 3;
    const fragments = policy.conversions.exclusiveFragmentsPerExchange ?? 10;
    const fragmentPrice = policy.unitPrices?.exclusiveFragments;
    if (!finiteNonnegative(crystalPrice) || !finiteNonnegative(crystals) || crystals === 0
      || !finiteNonnegative(fragments) || fragments === 0 || !finiteNonnegative(fragmentPrice)
      || Math.abs(crystalPrice * crystals / fragments - fragmentPrice) > 1e-8) {
      error(errors, 'policy.conversions.magicCrystalPrice', 'INCONSISTENT_EXCLUSIVE_PRICE', '专武碎片单价必须与紫水晶单价及兑换比例一致。');
    }
  }
  const ticketCategoryIds = policy.runes?.ticketCategoryIds ?? [5, 9];
  if (!Array.isArray(ticketCategoryIds) || new Set(ticketCategoryIds).size !== ticketCategoryIds.length || ticketCategoryIds.some(id => !catalog.runeCategories.some(category => category.id === id))) error(errors, 'policy.runes.ticketCategoryIds', 'INVALID_RUNE_CONVERSION', '兑换券符石类型配置必须为目录中不重复的类型编号。');
  const fixedStock = policy.runes?.fixedStock;
  const fixedTiers = getFixedRuneTiers(fixedStock);
  if (fixedStock !== undefined) {
    if (!isObject(fixedStock) || !Array.isArray(fixedTiers) || fixedTiers.length === 0
      || fixedTiers.some(tier => !isObject(tier) || !integerIn(tier.level, 1, policy.limits?.runeLevel ?? 15) || !integerIn(tier.perCategory, 0, 120))
      || new Set(fixedTiers.map(tier => tier?.level)).size !== fixedTiers.length
      || !Array.isArray(fixedStock.excludedCategoryIds) || !Array.isArray(ticketCategoryIds)
      || fixedStock.excludedCategoryIds.length !== new Set(fixedStock.excludedCategoryIds).size
      || fixedStock.excludedCategoryIds.length !== ticketCategoryIds.length
      || fixedStock.excludedCategoryIds.some(id => !ticketCategoryIds.includes(id))) {
      error(errors, 'policy.runes.fixedStock', 'INVALID_FIXED_RUNE_STOCK', '普通符石固定库存配置无效；排除类型必须与兑换券符石类型一致。');
    }
  }
  validateFreeLibrary(freeLibrary, catalog, errors);
  if (errors.length > 0) return errors;
  if (!isObject(team)) {
    error(errors, 'team', 'INVALID_TEAM', '配队必须为一个对象。');
    return errors;
  }
  validateArcanaSelection(team, catalog, errors);
  for (const [field, maximum] of [['name', 120], ['author', 120], ['notes', 4000]]) {
    if (typeof team[field] !== 'string' || team[field].length > maximum) {
      error(errors, field, 'INVALID_TEXT', `${field === 'name' ? '配队名称' : field === 'author' ? '作者' : '备注'}必须为不超过 ${maximum} 字的文字。`);
    }
  }
  if (team.level !== policy.characterLevel) error(errors, 'level', 'FIXED_LEVEL', `当前规则固定角色等级为 ${policy.characterLevel}。`);
  if (!Array.isArray(team.members) || team.members.length !== 5) {
    error(errors, 'members', 'INVALID_TEAM_SIZE', '配队必须保留五个固定位置。');
    return errors;
  }
  const seenCharacters = new Set();
  const seenWeaponOwners = new Set();
  const fixedRuneCounts = new Map();
  const maxRuneLevel = catalog.limits?.runeLevel ?? policy.limits?.runeLevel ?? 15;
  const maxSacredLevel = catalog.limits?.sacredTreasureLevel ?? policy.limits?.sacredTreasureLevel ?? 40;
  const maxReinforcement = catalog.limits?.reinforcementLevel ?? policy.limits?.reinforcementLevel ?? policy.characterLevel;
  team.members.forEach((member, memberIndex) => {
    const memberPath = `members[${memberIndex}]`;
    if (member === null) {
      if (requireFullTeam) error(errors, memberPath, 'EMPTY_MEMBER', `第 ${memberIndex + 1} 个位置尚未选择角色。`);
      return;
    }
    if (!isObject(member)) {
      error(errors, memberPath, 'INVALID_MEMBER', `第 ${memberIndex + 1} 个位置的角色数据无效。`);
      return;
    }
    const character = catalog.characters.find(item => item.id === member.characterId);
    if (!character) error(errors, `${memberPath}.characterId`, 'UNKNOWN_CHARACTER', `第 ${memberIndex + 1} 个位置的角色不在公开目录中。`);
    if (character && !['blue', 'red', 'green', 'yellow', 'light', 'dark'].includes(character.element)) error(errors, `${memberPath}.characterId`, 'UNKNOWN_CHARACTER_ELEMENT', '角色属性信息不完整，无法确定本体成本。');
    if (seenCharacters.has(member.characterId)) error(errors, `${memberPath}.characterId`, 'DUPLICATE_CHARACTER', '同一角色不能重复加入配队。');
    seenCharacters.add(member.characterId);
    if (!RARITIES.includes(member.rarity)) error(errors, `${memberPath}.rarity`, 'INVALID_RARITY', '角色稀有度仅支持 SR、LR 和 LR5。');
    if (member.rarity === 'SR' && getArcanaRequiredRarity(team, member.characterId, catalog)) error(errors, `${memberPath}.rarity`, 'ARCANA_REQUIRES_LR', '已购买 LR 秘仪的队内角色必须至少为 LR。');
    if (!Array.isArray(member.equipment) || member.equipment.length !== 6) {
      error(errors, `${memberPath}.equipment`, 'INVALID_EQUIPMENT_SIZE', '每名角色必须保留六个固定装备槽。');
      return;
    }
    member.equipment.forEach((gear, gearIndex) => {
      const path = `${memberPath}.equipment[${gearIndex}]`;
      if (!isObject(gear)) {
        error(errors, path, 'INVALID_EQUIPMENT', '装备数据无效。');
        return;
      }
      if (gear.slot !== EQUIPMENT_SLOTS[gearIndex]) error(errors, `${path}.slot`, 'INVALID_SLOT', '装备槽顺序必须为 1 至 6，不能重复或交换。');
      if (!EQUIPMENT_RARITIES.includes(gear.rarity)) error(errors, `${path}.rarity`, 'INVALID_GEAR_RARITY', '装备稀有度仅支持无装备、SSR、UR 和 LR。');
      if (!POLISH_ATTRIBUTES.includes(gear.polishAttribute === undefined ? 'main' : gear.polishAttribute)) error(errors, `${path}.polishAttribute`, 'INVALID_POLISH_ATTRIBUTE', '打磨属性仅支持主属性、不打磨、力量、敏捷、体力或魔力。');
      if (gear.rarity === 'LR' && member.rarity !== 'LR5') error(errors, `${path}.rarity`, 'LR_REQUIRES_LR5', 'LR 装备仅能由 LR5 角色使用。');
      if (!integerIn(gear.level, 1, policy.characterLevel)) error(errors, `${path}.level`, 'INVALID_GEAR_LEVEL', `装备等级必须为 1 至 ${policy.characterLevel} 的整数。`);
      const weaponKind = gear.weaponKind ?? 'normal';
      const levelTableKey = weaponKind === 'exclusive' ? `exclusive${gear.rarity}` : gear.rarity;
      const costLevels = catalog.equipmentCosts?.fragments?.[levelTableKey];
      const allowedLevels = catalog.equipmentCosts?.allowedLevels?.[levelTableKey]
        ?? (costLevels ? Object.keys(costLevels).map(Number).filter(level => finiteNonnegative(costLevels[level])) : null);
      if (gear.rarity !== 'NONE' && Array.isArray(allowedLevels) && !allowedLevels.includes(gear.level)) {
        error(errors, `${path}.level`, 'UNAVAILABLE_GEAR_LEVEL', '该系列不支持所选装备等级。');
      }
      for (const [field, maximum] of [['reinforcementLevel', maxReinforcement], ['legendSacredTreasureLevel', maxSacredLevel], ['matchlessSacredTreasureLevel', maxSacredLevel]]) {
        if (!integerIn(gear[field], 0, maximum)) error(errors, `${path}.${field}`, 'INVALID_UPGRADE_LEVEL', `强化或圣装等级必须为 0 至 ${maximum} 的整数。`);
      }
      const syncSlot = gear.syncSlot ?? 0;
      if (automaticWeaponPricing(policy) && syncSlot !== 0) error(errors, `${path}.syncSlot`, 'LEGACY_WEAPON_CONFIG_REQUIRES_MIGRATION', '旧同步配置需要先迁移到自动造价规则，不能保留隐藏同步槽。');
      if (!integerIn(syncSlot, 0, 2)) error(errors, `${path}.syncSlot`, 'INVALID_WEAPON_SYNC_SLOT', '武器同步仅支持关闭、第 1 槽或第 2 槽。');
      if (syncSlot === 0 && Number.isSafeInteger(gear.reinforcementLevel) && gear.reinforcementLevel > gear.level) error(errors, `${path}.reinforcementLevel`, 'REINFORCEMENT_EXCEEDS_LEVEL', '强化等级不能超过装备等级。');
      if (!['normal', 'exclusive'].includes(weaponKind)) error(errors, `${path}.weaponKind`, 'INVALID_WEAPON_KIND', '武器类型无效。');
      if (gear.slot === 1 && weaponKind === 'normal' && ['UR', 'LR'].includes(gear.rarity)) error(errors, `${path}.weaponKind`, 'UNAVAILABLE_NORMAL_WEAPON', '通用 UR／LR 武器不可获取，请使用自己的专武或借用免费的同职业 UR 专武。');
      if (weaponKind === 'exclusive' && (gear.slot !== 1 || !['SSR', 'UR', 'LR'].includes(gear.rarity))) error(errors, `${path}.weaponKind`, 'INVALID_EXCLUSIVE_WEAPON', '专属武器仅支持第 1 槽的 SSR、UR 或 LR 装备。');
      if (gear.slot === 1 && weaponKind === 'exclusive' && gear.rarity !== 'NONE') {
        const ownerId = weaponOwnerId(member, gear);
        const owner = catalog.characters.find(item => item.id === ownerId);
        if (!owner) error(errors, `${path}.weaponOwnerCharacterId`, 'UNKNOWN_WEAPON_OWNER', '专武所属角色不在公开目录中。');
        if (seenWeaponOwners.has(ownerId)) error(errors, `${path}.weaponOwnerCharacterId`, 'DUPLICATE_WEAPON_OWNER', '每个免费专武只提供一把，同一所属角色的专武不能同时装备给两个人。');
        seenWeaponOwners.add(ownerId);
        if (ownerId !== member.characterId) {
          const gift = freeLibrary?.exclusiveWeapons.find(entry => entry.characterId === ownerId);
          if (gift?.rarity !== 'UR' || !['UR', 'LR'].includes(gear.rarity)) error(errors, `${path}.weaponOwnerCharacterId`, 'UNAVAILABLE_BORROWED_WEAPON', '只能借用免费库中的 UR 专武，并按需进化到 LR；SSR 专武不能借用。');
          if (!owner || !character || ![1, 2, 4].includes(owner.job) || owner.job !== character.job) error(errors, `${path}.weaponOwnerCharacterId`, 'BORROWED_WEAPON_JOB_MISMATCH', '借用专武必须与装备角色属于同一职业。');
        }
      }
      if (syncSlot > 0 && (gear.slot !== 1 || weaponKind !== 'exclusive' || !['UR', 'LR'].includes(gear.rarity) || gear.level < syncPolicy.minimumLevel)) error(errors, `${path}.syncSlot`, 'INELIGIBLE_SYNC_WEAPON', '只有已制作到 300 级以上的 UR／LR 专武可以放入同步槽。');
      const seriesId = gear.seriesId ?? defaultSeries(gear.rarity);
      if (gear.rarity !== 'NONE' && Array.isArray(getSeries(catalog))) {
        const series = getSeries(catalog).find(item => item.id === seriesId);
        if (!series || (Array.isArray(series.rarities) && !series.rarities.includes(gear.rarity))) error(errors, `${path}.seriesId`, 'INVALID_SERIES', '装备系列与稀有度不一致。');
        if (weaponKind === 'normal' && series?.allowedLevels && !series.allowedLevels.includes(gear.level)) error(errors, `${path}.level`, 'UNAVAILABLE_SERIES_LEVEL', '该系列不支持所选装备等级。');
      }
      if (!Array.isArray(gear.runes) || gear.runes.length !== 4) {
        error(errors, `${path}.runes`, 'INVALID_RUNE_SIZE', '每件装备必须保留四个符石孔。');
        return;
      }
      const seenRuneCategories = new Set();
      gear.runes.forEach((rune, runeIndex) => {
        const runePath = `${path}.runes[${runeIndex}]`;
        if (!isObject(rune)) {
          error(errors, runePath, 'INVALID_RUNE', '符石数据无效。');
          return;
        }
        const category = catalog.runeCategories.find(item => item.id === rune.categoryId);
        if (!category) error(errors, `${runePath}.categoryId`, 'UNKNOWN_RUNE_CATEGORY', '符石类型不在公开目录中。');
        if (!integerIn(rune.level, 0, maxRuneLevel)) error(errors, `${runePath}.level`, 'INVALID_RUNE_LEVEL', `符石等级必须为 0 至 ${maxRuneLevel} 的整数。`);
        if (rune.level > 0) {
          if (seenRuneCategories.has(rune.categoryId)) error(errors, `${runePath}.categoryId`, 'DUPLICATE_RUNE_CATEGORY', '同一件装备不能安装两颗同类型符石。');
          seenRuneCategories.add(rune.categoryId);
          const allowedSlots = category?.allowedSlots ?? category?.slots;
          if (Array.isArray(allowedSlots) && !allowedSlots.includes(gear.slot)) error(errors, runePath, 'RUNE_SLOT_RESTRICTION', '该符石类型不能用于此装备槽。');
          if (fixedStock && category && !fixedStock.excludedCategoryIds.includes(category.id)) {
            if (!fixedTiers.some(tier => tier.level === rune.level)) error(errors, `${runePath}.level`, 'FIXED_RUNE_LEVEL', `${category.name}仅提供 ${fixedTiers.map(tier => tier.level).join('、')} 级免费符石，不能选择其它等级。`);
            const inventoryKey = `${category.id}:${rune.level}`;
            fixedRuneCounts.set(inventoryKey, (fixedRuneCounts.get(inventoryKey) ?? 0) + 1);
          }
        }
      });
      if (gear.rarity === 'NONE' && (
        gear.reinforcementLevel !== 0 || gear.legendSacredTreasureLevel !== 0 || gear.matchlessSacredTreasureLevel !== 0
        || gear.runes.some(rune => rune?.level !== 0) || weaponKind !== 'normal' || gear.seriesId != null || syncSlot !== 0
      )) error(errors, path, 'EMPTY_GEAR_HAS_UPGRADES', '无装备的槽位不能保留强化、圣装、魔装或符石。');
    });
  });
  for (const [inventoryKey, used] of fixedRuneCounts) {
    const [categoryId, level] = inventoryKey.split(':').map(Number);
    const tier = fixedTiers.find(item => item.level === level);
    if (tier && used > tier.perCategory) {
      const category = catalog.runeCategories.find(item => item.id === categoryId);
      error(errors, `fixedRuneInventory.${categoryId}.${level}`, 'FIXED_RUNE_STOCK_EXCEEDED', `${category.name}整队仅提供 ${tier.perCategory} 颗 ${level} 级免费符石，当前使用 ${used} 颗。`);
    }
  }
  const sources = team.weaponSources ?? [];
  if (automaticWeaponPricing(policy) && Array.isArray(sources) && sources.length > 0) error(errors, 'weaponSources', 'LEGACY_WEAPON_CONFIG_REQUIRES_MIGRATION', '旧队外基石需要先迁移并移除，自动造价不计入隐藏队外库存。');
  if (!Array.isArray(sources) || sources.length > syncPolicy.maximumSourceCount) {
    error(errors, 'weaponSources', 'INVALID_WEAPON_SOURCE_LIST', `备用基石最多配置 ${syncPolicy.maximumSourceCount} 件专武。`);
  } else {
    const seenSources = new Set();
    for (const [index, source] of sources.entries()) {
      const path = `weaponSources[${index}]`;
      if (!isObject(source)) { error(errors, path, 'INVALID_WEAPON_SOURCE', '备用基石数据无效。'); continue; }
      const character = catalog.characters.find(item => item.id === source.characterId);
      if (!character) error(errors, `${path}.characterId`, 'UNKNOWN_CHARACTER', '备用基石角色不在公开目录中。');
      if (seenSources.has(source.characterId) || seenWeaponOwners.has(source.characterId)) error(errors, `${path}.characterId`, 'DUPLICATE_WEAPON_SOURCE', '备用基石不能重复，也不能与配队中已装备的专武所属角色重复。');
      seenSources.add(source.characterId);
      if (!RARITIES.includes(source.characterRarity)) error(errors, `${path}.characterRarity`, 'INVALID_RARITY', '备用基石角色稀有度仅支持 SR、LR 和 LR5。');
      const selectedActor = team.members.find(member => member?.characterId === source.characterId);
      if (selectedActor && source.characterRarity !== selectedActor.rarity) error(errors, `${path}.characterRarity`, 'SOURCE_CHARACTER_RARITY_MISMATCH', '备用基石所属角色已在配队中，其角色稀有度必须与配队中的同一角色一致。');
      if (!['UR', 'LR'].includes(source.rarity)) error(errors, `${path}.rarity`, 'INVALID_WEAPON_SOURCE_RARITY', '备用基石只支持 UR 和 LR 专武。');
      if (source.rarity === 'LR' && source.characterRarity !== 'LR5') error(errors, `${path}.rarity`, 'LR_REQUIRES_LR5', 'LR 备用专武需要 LR5 角色。');
      if (!integerIn(source.level, syncPolicy.minimumLevel, policy.characterLevel)
        || !finiteNonnegative(catalog.equipmentCosts?.fragments?.[`exclusive${source.rarity}`]?.[source.level])) error(errors, `${path}.level`, 'INVALID_WEAPON_SOURCE_LEVEL', '备用基石必须使用当前可制作的 300 至 450 级专武档位。');
    }
  }
  if (errors.length === 0 && !automaticWeaponPricing(policy)) {
    const sync = deriveWeaponSync(team, catalog, policy, freeLibrary);
    errors.push(...sync.errors);
    team.members.forEach((member, index) => {
      const gear = member?.equipment?.[0];
      if (gear?.syncSlot > 0 && Number.isSafeInteger(sync.effectiveLevels[index]) && gear.reinforcementLevel > sync.effectiveLevels[index]) error(errors, `members[${index}].equipment[0].reinforcementLevel`, 'REINFORCEMENT_EXCEEDS_LEVEL', '强化等级不能超过同步后的实际武器等级。');
    });
  }
  return errors;
}

function readCost(table, level, errors, path, label) {
  if (level === 0) return 0;
  const value = table?.[level];
  if (!finiteNonnegative(value)) {
    error(errors, path, 'UNKNOWN_RESOURCE_COST', `${label}等级 ${level} 的累计材料缺少有效公开数据，无法估价。`);
    return 0;
  }
  return value;
}

function collectCosts(team, catalog, policy, errors, freeLibrary) {
  const precision = policy.rounding?.precision ?? 2;
  const consumed = Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0]));
  const libraryCredits = Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0]));
  const craftingBlessingCredits = Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0]));
  const baselineBlessingCredits = Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0]));
  const exclusiveBaselineBlessing = (policy.blessings ?? []).find(blessing => blessingEffect(blessing) === 'freeExclusiveFragmentBaseline');
  const exclusiveBaselineFragments = exclusiveBaselineBlessing ? catalog.equipmentCosts.fragments[`exclusive${exclusiveBaselineBlessing.rarity}`][exclusiveBaselineBlessing.level] : 0;
  const arcanaState = getArcanaState(team, catalog, policy, freeLibrary);
  errors.push(...arcanaState.errors);
  const characterCosts = arcanaState.ledger.filter(entry => entry.requiredRarity !== null).map(entry => {
    const lightDark = ['light', 'dark'].includes(entry.element);
    const tier = lightDark ? 'lightDark' : 'normal';
    const copies = policy.copies?.[entry.requiredRarity]?.[tier];
    const copyPrice = policy.unitPrices?.characterCopy;
    const entitlementCopies = entry.freeRarity ? policy.copies?.[entry.freeRarity]?.[tier] : 0;
    if (!Number.isSafeInteger(copies) || copies < 1 || !finiteNonnegative(copyPrice)) error(errors, `policy.copies.${entry.requiredRarity}`, 'INVALID_CHARACTER_PRICE', '角色本体数量或单价规则无效。');
    if (!Number.isSafeInteger(entitlementCopies) || entitlementCopies < 0) error(errors, 'freeLibrary.characters', 'INVALID_FREE_CHARACTER_PRICE', '免费库角色对应的累计本体规则无效。');
    const freeCopies = Math.min(copies, entitlementCopies);
    const chargedCopies = copies - freeCopies;
    const sourceKind = entry.teamRarity ? 'team' : entry.reserveRarity ? 'reserve' : 'arcana';
    return { position: entry.position, sourceKind, sourceIndex: sourceKind === 'reserve' ? entry.sourceIndex : null,
      characterId: entry.characterId, characterName: entry.characterName, rarity: entry.requiredRarity,
      copies, freeCopies, chargedCopies, freeRarity: entry.freeRarity, arcanaIds: [...entry.purchasedArcanaIds],
      unitPrice: copyPrice, grossDiamonds: round(copies * copyPrice, precision),
      freeDiamonds: round(freeCopies * copyPrice, precision), diamonds: round(chargedCopies * copyPrice, precision) };
  });
  const equipmentCosts = [];
  const exclusiveWeaponCosts = [];
  const fixedStock = policy.runes?.fixedStock;
  const fixedRuneInventory = fixedStock ? catalog.runeCategories.filter(category => !fixedStock.excludedCategoryIds.includes(category.id)).flatMap(category => getFixedRuneTiers(fixedStock).map(tier => ({ categoryId: category.id, name: category.name, level: tier.level, used: 0, available: tier.perCategory, remaining: tier.perCategory }))) : [];
  let legendExperience = 0;
  let matchlessExperience = 0;
  const automatic = automaticWeaponPricing(policy);
  const weaponSync = automatic ? null : deriveWeaponSync(team, catalog, policy, freeLibrary);
  const weaponPricing = deriveWeaponPricing(team, catalog, policy);
  const pricedMembers = [...team.members, ...(automatic ? [] : team.weaponSources ?? []).map(source => ({
    characterId: source.characterId, rarity: source.characterRarity,
    equipment: [{ ...createEquipment(1), rarity: source.rarity, seriesId: defaultSeries(source.rarity), weaponKind: 'exclusive', level: source.level }],
  }))];
  const addResource = (resource, amount, path) => {
    if (!RESOURCE_KEYS.includes(resource) || !finiteNonnegative(amount)) {
      error(errors, path, 'UNKNOWN_RESOURCE', '材料类型或数量未知，无法估价。');
      return;
    }
    consumed[resource] += amount;
  };
  pricedMembers.forEach((member, memberIndex) => {
    if (!member) return;
    const sourceKind = memberIndex < 5 ? 'team' : 'reserve';
    const sourceIndex = sourceKind === 'reserve' ? memberIndex - 5 : null;
    const position = sourceKind === 'team' ? memberIndex + 1 : null;
    const character = catalog.characters.find(item => item.id === member.characterId);
    member.equipment.forEach((gear, gearIndex) => {
      if (gear.rarity === 'NONE') return;
      const path = sourceKind === 'team' ? `members[${memberIndex}].equipment[${gearIndex}]` : `weaponSources[${sourceIndex}]`;
      const syncSlot = gear.syncSlot ?? 0;
      const effectiveLevel = !automatic && sourceKind === 'team' && gear.slot === 1 ? weaponSync.effectiveLevels[memberIndex] : gear.level;
      const automaticPrice = automatic && sourceKind === 'team' && gear.slot === 1 ? weaponPricing.weapons.find(weapon => weapon.position === position) : null;
      const billedLevel = automaticPrice?.billedLevel ?? gear.level;
      const pricingMetadata = { billedLevel, craftingLevel: billedLevel, discounted: automaticPrice?.discounted ?? false, automaticSyncDiscount: automaticPrice?.discounted ?? false, discountOrdinal: automaticPrice?.ordinal ?? null };
      const gearResources = {};
      const gearLibraryCredits = {};
      const gearBlessingCredits = {};
      const gearBaselineBlessingCredits = {};
      const addGearResource = (resource, amount, credit = 0) => {
        addResource(resource, amount, path);
        gearResources[resource] = (gearResources[resource] ?? 0) + amount;
        if (credit > 0) {
          libraryCredits[resource] += credit;
          gearLibraryCredits[resource] = (gearLibraryCredits[resource] ?? 0) + credit;
        }
      };
      const seriesId = gear.seriesId ?? defaultSeries(gear.rarity);
      const series = getSeries(catalog)?.find(item => item.id === seriesId);
      const weaponKind = gear.weaponKind ?? 'normal';
      const exclusive = weaponKind === 'exclusive';
      const ownerId = exclusive ? weaponOwnerId(member, gear) : null;
      const owner = exclusive ? catalog.characters.find(item => item.id === ownerId) : null;
      const borrowed = exclusive && ownerId !== member.characterId;
      const ownership = { weaponOwnerCharacterId: ownerId, weaponOwnerCharacterName: owner?.name ?? null, borrowed, ownExclusiveSkillActive: exclusive && !borrowed };
      const fragmentTableKey = exclusive ? `exclusive${gear.rarity}` : series?.costTable ?? gear.rarity;
      const fragmentResource = exclusive ? 'exclusiveFragments' : series?.costResource ?? (gear.rarity === 'SSR' ? 'ssrFragments' : 'urLrFragments');
      const fragments = readCost(catalog.equipmentCosts?.fragments?.[fragmentTableKey], billedLevel, errors, `${path}.level`, '装备碎片');
      const freeWeapon = exclusive ? freeLibrary?.exclusiveWeapons.find(entry => entry.characterId === ownerId) : null;
      const freeWeaponFragments = freeWeapon ? readCost(catalog.equipmentCosts?.fragments?.[`exclusive${freeWeapon.rarity}`], freeWeapon.level, errors, 'freeLibrary.exclusiveWeapons', '免费专武碎片') : 0;
      const freeFragments = Math.min(fragments, freeWeaponFragments);
      addGearResource(fragmentResource, fragments, freeFragments);
      const baselineFragmentCredit = exclusive && exclusiveBaselineBlessing
        ? Math.max(0, Math.min(fragments, exclusiveBaselineFragments) - freeFragments) : 0;
      if (baselineFragmentCredit > 0) {
        gearBaselineBlessingCredits[fragmentResource] = baselineFragmentCredit;
        gearBlessingCredits[fragmentResource] = baselineFragmentCredit;
        baselineBlessingCredits[fragmentResource] += baselineFragmentCredit;
      }
      const craftingBlessing = (policy.blessings ?? []).find(blessing => blessingEffect(blessing) === 'freeEquipmentCrafting'
        && blessing.rarity === gear.rarity && blessing.weaponKind === weaponKind && blessing.resource === fragmentResource);
      if (craftingBlessing) {
        const credited = Math.max(0, fragments - freeFragments - baselineFragmentCredit);
        gearBlessingCredits[fragmentResource] = (gearBlessingCredits[fragmentResource] ?? 0) + credited;
        craftingBlessingCredits[fragmentResource] += credited;
      }
      let lifeTreeDew = 0;
      let freeLifeTreeDew = 0;
      if (['UR', 'LR'].includes(gear.rarity)) {
        const materialKey = { UR: { normal: 'urLifeTreeDew', exclusive: 'exclusiveUrLifeTreeDew' }, LR: { normal: 'lrLifeTreeDew', exclusive: 'exclusiveLrLifeTreeDew' } }[gear.rarity][weaponKind];
        lifeTreeDew = policy.equipment?.[materialKey];
        if (!finiteNonnegative(lifeTreeDew)) error(errors, `policy.equipment.${materialKey}`, 'UNKNOWN_EVOLUTION_COST', '装备进化所需生命树之露数量尚未配置。');
        else {
          const freeMaterialKey = { UR: 'exclusiveUrLifeTreeDew', LR: 'exclusiveLrLifeTreeDew' }[freeWeapon?.rarity];
          const entitledDew = freeMaterialKey ? policy.equipment?.[freeMaterialKey] : 0;
          if (!finiteNonnegative(entitledDew)) error(errors, 'freeLibrary.exclusiveWeapons', 'UNKNOWN_FREE_EVOLUTION_COST', '免费专武的进化材料配置无效。');
          else freeLifeTreeDew = Math.min(lifeTreeDew, entitledDew);
          addGearResource('lifeTreeDew', lifeTreeDew, freeLifeTreeDew);
        }
      }
      const medicine = readCost(catalog.equipmentCosts?.reinforcement?.[gear.slot === 1 ? 'weapon' : 'other'], gear.reinforcementLevel, errors, `${path}.reinforcementLevel`, '强化');
      addGearResource('reinforcementMedicine', medicine);
      const legend = readCost(catalog.equipmentCosts?.sacredExperience, gear.legendSacredTreasureLevel, errors, `${path}.legendSacredTreasureLevel`, '圣装');
      const matchless = readCost(catalog.equipmentCosts?.sacredExperience, gear.matchlessSacredTreasureLevel, errors, `${path}.matchlessSacredTreasureLevel`, '魔装');
      legendExperience += legend;
      matchlessExperience += matchless;
      const steelRatio = policy.holySteelPerExperience;
      if (legend > 0 && !finiteNonnegative(steelRatio)) error(errors, 'policy.holySteelPerExperience', 'INVALID_HOLY_STEEL_CONVERSION', '圣装经验兑换单位无效。');
      addGearResource('holySteel', legend > 0 && finiteNonnegative(steelRatio) ? legend * steelRatio : 0);
      gear.runes.forEach((rune, runeIndex) => {
        if (rune.level === 0) return;
        const category = catalog.runeCategories.find(item => item.id === rune.categoryId);
        const ticketCategoryIds = policy.runes?.ticketCategoryIds ?? [5, 9];
        const ticketBased = ticketCategoryIds.includes(category.id);
        if (fixedStock && !ticketBased) {
          const inventory = fixedRuneInventory.find(item => item.categoryId === category.id && item.level === rune.level);
          inventory.used += 1;
          inventory.remaining = inventory.available - inventory.used;
          return;
        }
        const offset = ticketBased ? policy.runes?.ticketExponentOffset ?? 0 : policy.runes?.unidentifiedRuneBaseLevel ?? 7;
        if (!integerIn(offset, 0, 30)) {
          error(errors, 'policy.runes', 'INVALID_RUNE_CONVERSION', '符石等价折算规则无效。');
          return;
        }
        const amount = 2 ** (rune.level - offset);
        addGearResource(ticketBased ? 'runeTickets' : 'unidentifiedRune7', amount);
      });
      equipmentCosts.push({ position, sourceKind, sourceIndex, characterId: character.id, characterName: character.name, slot: gear.slot, rarity: gear.rarity, seriesId, seriesName: series?.name ?? gear.rarity, weaponKind, ...ownership, ...pricingMetadata, level: gear.level, effectiveLevel, syncSlot, fragmentResource, fragments, legendExperience: legend, matchlessExperience: matchless, resources: gearResources, freeLibraryCredits: gearLibraryCredits, blessingCredits: gearBlessingCredits, baselineBlessingCredits: gearBaselineBlessingCredits, craftingBlessingId: craftingBlessing?.id ?? null, exclusiveBaselineBlessingId: exclusive ? exclusiveBaselineBlessing?.id ?? null : null });
      if (exclusive) {
        const crystalsPerExchange = policy.conversions?.magicCrystalsPerExclusiveExchange ?? 3;
        const fragmentsPerExchange = policy.conversions?.exclusiveFragmentsPerExchange ?? 10;
        if (!finiteNonnegative(crystalsPerExchange) || crystalsPerExchange === 0 || !finiteNonnegative(fragmentsPerExchange) || fragmentsPerExchange === 0) error(errors, 'policy.conversions', 'INVALID_EXCLUSIVE_CONVERSION', '专武碎片与紫水晶的兑换比例无效。');
        const crystalRatio = crystalsPerExchange / fragmentsPerExchange;
        const fragmentPrice = policy.unitPrices?.exclusiveFragments;
        const dewPrice = policy.unitPrices?.lifeTreeDew;
        const baseDiamonds = (fragmentAmount, dewAmount) => (fragmentAmount > 0 ? fragmentAmount * fragmentPrice : 0) + (dewAmount > 0 ? dewAmount * dewPrice : 0);
        const chargedFragments = fragments - freeFragments - baselineFragmentCredit;
        const chargedLifeTreeDew = lifeTreeDew - freeLifeTreeDew;
        const effectiveFragments = syncSlot > 0 || automaticPrice?.discounted ? readCost(catalog.equipmentCosts?.fragments?.[fragmentTableKey], effectiveLevel, errors, `${path}.level`, '实际等级专武') : fragments;
        const savedFragments = Math.max(0, effectiveFragments - fragments);
        const syncSavedFragments = automatic ? 0 : savedFragments;
        const levelDiscountFragments = automatic ? savedFragments : 0;
        exclusiveWeaponCosts.push({ position, sourceKind, sourceIndex, characterId: character.id, characterName: character.name, ...ownership, ...pricingMetadata, rarity: gear.rarity, level: gear.level, effectiveLevel, syncSlot, syncSavedFragments, syncSavedDiamonds: round(syncSavedFragments * fragmentPrice, precision), levelDiscountFragments, levelDiscountDiamonds: round(levelDiscountFragments * fragmentPrice, precision), freeRarity: freeWeapon?.rarity ?? null, freeLevel: freeWeapon?.level ?? null, fragments, freeFragments, baselineRarity: exclusiveBaselineBlessing?.rarity ?? null, baselineLevel: exclusiveBaselineBlessing?.level ?? null, baselineFragments: exclusiveBaselineFragments, blessingFragments: baselineFragmentCredit, chargedFragments, magicCrystals: fragments * crystalRatio, freeMagicCrystals: freeFragments * crystalRatio, blessingMagicCrystals: baselineFragmentCredit * crystalRatio, chargedMagicCrystals: chargedFragments * crystalRatio, magicCrystalUnitPrice: policy.conversions?.magicCrystalPrice ?? fragmentPrice / crystalRatio, lifeTreeDew, freeLifeTreeDew, chargedLifeTreeDew, grossDiamonds: round(baseDiamonds(fragments, lifeTreeDew), precision), freeDiamonds: round(baseDiamonds(freeFragments, freeLifeTreeDew), precision), blessingDiamonds: round(baseDiamonds(baselineFragmentCredit, 0), precision), diamonds: round(baseDiamonds(chargedFragments, chargedLifeTreeDew), precision) });
      }
    });
  });
  const resources = {};
  for (const key of RESOURCE_KEYS) {
    const amount = consumed[key];
    const allowanceDetails = resourceAllowanceDetails(policy, key);
    const allowance = allowanceDetails.freeAllowance;
    const unitPrice = policy.unitPrices?.[key];
    if (!finiteNonnegative(allowance)) error(errors, `policy.allowances.${key}`, 'INVALID_ALLOWANCE', '免费材料额度必须为非负数。');
    if (amount > 0 && !finiteNonnegative(unitPrice)) error(errors, `policy.unitPrices.${key}`, 'UNKNOWN_RESOURCE_PRICE', `${key} 单价尚未确认，无法估价。`);
    const freeLibraryCredit = libraryCredits[key];
    const craftingBlessingCredit = craftingBlessingCredits[key];
    const baselineBlessingCredit = baselineBlessingCredits[key];
    const blessingCredit = craftingBlessingCredit + baselineBlessingCredit;
    const chargedBeforeDiamondAllowance = finiteNonnegative(allowance) ? Math.max(0, amount - freeLibraryCredit - blessingCredit - allowance) : NaN;
    const diamondAllowance = resourceDiamondAllowance(policy, key);
    const chargeableDiamonds = chargedBeforeDiamondAllowance > 0 ? chargedBeforeDiamondAllowance * unitPrice : 0;
    const diamondAllowanceCredit = Math.min(chargeableDiamonds, diamondAllowance);
    const paidDiamonds = Math.max(0, chargeableDiamonds - diamondAllowanceCredit);
    const charged = diamondAllowanceCredit > 0 && unitPrice > 0 ? paidDiamonds / unitPrice : chargedBeforeDiamondAllowance;
    resources[key] = { consumed: amount, freeLibraryCredit, craftingBlessingCredit, baselineBlessingCredit, blessingCredit,
      craftingBlessingDiamonds: craftingBlessingCredit > 0 ? round(craftingBlessingCredit * unitPrice, precision) : 0,
      baselineBlessingDiamonds: baselineBlessingCredit > 0 ? round(baselineBlessingCredit * unitPrice, precision) : 0,
      ...allowanceDetails, chargedBeforeDiamondAllowance, diamondAllowance, diamondAllowanceCredit,
      remainingDiamondAllowance: Math.max(0, diamondAllowance - diamondAllowanceCredit),
      charged, unitPrice: finiteNonnegative(unitPrice) ? unitPrice : null, diamonds: round(paidDiamonds, precision) };
    const hardLimit = policy.hardLimits?.[key];
    if (hardLimit != null && (!finiteNonnegative(hardLimit) || amount > hardLimit)) error(errors, `resources.${key}`, 'RESOURCE_LIMIT_EXCEEDED', `${key} 超出当前规则允许的材料额度。`);
  }
  // Allocate team allowances once, in team/slot order, so per-weapon fees agree with the total.
  const remainingAllowances = Object.fromEntries(RESOURCE_KEYS.map(key => [key, resources[key].freeAllowance]));
  const remainingDiamondAllowances = Object.fromEntries(RESOURCE_KEYS.map(key => [key, resources[key].diamondAllowance]));
  for (const gear of equipmentCosts) {
    gear.chargedResources = {};
    gear.chargedResourcesBeforeDiamondAllowance = {};
    gear.chargedResourceDiamonds = {};
    gear.diamondAllowanceCredits = {};
    gear.sharedAllowanceCredits = {};
    for (const [key, amount] of Object.entries(gear.resources)) {
      const aboveLibrary = Math.max(0, amount - (gear.freeLibraryCredits[key] ?? 0) - (gear.blessingCredits[key] ?? 0));
      const sharedCredit = Math.min(aboveLibrary, remainingAllowances[key]);
      remainingAllowances[key] -= sharedCredit;
      gear.sharedAllowanceCredits[key] = sharedCredit;
      const chargedQuantity = aboveLibrary - sharedCredit;
      const chargeableDiamonds = chargedQuantity > 0 ? chargedQuantity * resources[key].unitPrice : 0;
      const diamondCredit = Math.min(chargeableDiamonds, remainingDiamondAllowances[key]);
      remainingDiamondAllowances[key] = Math.max(0, remainingDiamondAllowances[key] - diamondCredit);
      const paidDiamonds = Math.max(0, chargeableDiamonds - diamondCredit);
      gear.chargedResourcesBeforeDiamondAllowance[key] = chargedQuantity;
      gear.diamondAllowanceCredits[key] = diamondCredit;
      gear.chargedResourceDiamonds[key] = paidDiamonds;
      gear.chargedResources[key] = diamondCredit > 0 && resources[key].unitPrice > 0 ? paidDiamonds / resources[key].unitPrice : chargedQuantity;
    }
    gear.craftingDiamonds = round(gear.chargedResourceDiamonds[gear.fragmentResource] ?? 0, precision);
    gear.evolutionDiamonds = round(gear.chargedResourceDiamonds.lifeTreeDew ?? 0, precision);
    gear.diamonds = round(Object.values(gear.chargedResourceDiamonds).reduce((sum, value) => sum + value, 0), precision);
    gear.equivalentArtifactMaterials = null;
    gear.chargedEquivalentArtifactMaterials = null;
    if (gear.fragmentResource === 'urLrFragments') {
      const materialsPerExchange = policy.conversions?.relicMaterialsPerExchange ?? 2;
      const fragmentsPerExchange = policy.conversions?.urLrFragmentsPerExchange ?? 50;
      if (!finiteNonnegative(materialsPerExchange) || materialsPerExchange === 0
        || !finiteNonnegative(fragmentsPerExchange) || fragmentsPerExchange === 0) {
        error(errors, 'policy.conversions', 'INVALID_RELIC_CONVERSION', '圣遗物材料与装备碎片的兑换比例必须为正数。');
      } else {
        gear.equivalentArtifactMaterials = gear.fragments * materialsPerExchange / fragmentsPerExchange;
        gear.chargedEquivalentArtifactMaterials = gear.chargedResources.urLrFragments * materialsPerExchange / fragmentsPerExchange;
      }
    }
    if (gear.weaponKind !== 'exclusive') continue;
    const weapon = exclusiveWeaponCosts.find(item => item.sourceKind === gear.sourceKind && item.position === gear.position && item.sourceIndex === gear.sourceIndex);
    weapon.chargedFragments = gear.chargedResources.exclusiveFragments;
    weapon.chargedLifeTreeDew = gear.chargedResources.lifeTreeDew ?? 0;
    weapon.chargedFragmentsBeforeDiamondAllowance = gear.chargedResourcesBeforeDiamondAllowance.exclusiveFragments;
    weapon.chargedLifeTreeDewBeforeDiamondAllowance = gear.chargedResourcesBeforeDiamondAllowance.lifeTreeDew ?? 0;
    weapon.diamondAllowanceFragments = gear.diamondAllowanceCredits.exclusiveFragments;
    weapon.diamondAllowanceLifeTreeDew = gear.diamondAllowanceCredits.lifeTreeDew ?? 0;
    weapon.diamondAllowanceCredits = { exclusiveFragments: weapon.diamondAllowanceFragments, lifeTreeDew: weapon.diamondAllowanceLifeTreeDew };
    weapon.chargedResourceDiamonds = { exclusiveFragments: gear.chargedResourceDiamonds.exclusiveFragments, lifeTreeDew: gear.chargedResourceDiamonds.lifeTreeDew ?? 0 };
    weapon.sharedAllowanceFragments = gear.sharedAllowanceCredits.exclusiveFragments;
    weapon.sharedAllowanceLifeTreeDew = gear.sharedAllowanceCredits.lifeTreeDew ?? 0;
    const crystalRatio = (policy.conversions?.magicCrystalsPerExclusiveExchange ?? 3) / (policy.conversions?.exclusiveFragmentsPerExchange ?? 10);
    weapon.chargedMagicCrystals = weapon.chargedFragments * crystalRatio;
    weapon.chargedMagicCrystalsBeforeDiamondAllowance = weapon.chargedFragmentsBeforeDiamondAllowance * crystalRatio;
    const fragmentDiamonds = weapon.chargedResourceDiamonds.exclusiveFragments;
    const dewDiamonds = weapon.chargedResourceDiamonds.lifeTreeDew;
    weapon.chargedFragmentDiamonds = round(fragmentDiamonds, precision);
    weapon.chargedLifeTreeDewDiamonds = round(dewDiamonds, precision);
    weapon.diamonds = round(fragmentDiamonds + dewDiamonds, precision);
  }
  const weaponSourceCosts = (automatic ? [] : team.weaponSources ?? []).map((source, sourceIndex) => {
    const character = characterCosts.find(item => item.sourceKind === 'reserve' && item.sourceIndex === sourceIndex);
    const weapon = exclusiveWeaponCosts.find(item => item.sourceKind === 'reserve' && item.sourceIndex === sourceIndex);
    const characterDiamonds = character?.diamonds ?? 0;
    return { sourceIndex, characterId: source.characterId, characterName: weapon.characterName, characterRarity: source.characterRarity, rarity: source.rarity, level: source.level, characterDiamonds, weaponDiamonds: weapon.diamonds, diamonds: round((character ? character.chargedCopies * character.unitPrice : 0) + weapon.chargedResourceDiamonds.exclusiveFragments + weapon.chargedResourceDiamonds.lifeTreeDew, precision) };
  });
  return { characterCosts, equipmentCosts, exclusiveWeaponCosts, weaponSourceCosts, reserveSourceCosts: weaponSourceCosts, weaponSync, weaponPricing, arcanaState, resources, legendExperience, matchlessExperience, fixedRuneInventory, freeLibraryVersion: freeLibrary?.version ?? null };
}

export function validateTeam(team, catalog, policy, options = {}) {
  const errors = validateStructure(team, catalog, policy, options);
  if (errors.length === 0) collectCosts(team, catalog, policy, errors, options.freeLibrary);
  return { valid: errors.length === 0, errors };
}

export function calculateTeam(team, catalog, policy, freeLibrary) {
  const errors = validateStructure(team, catalog, policy, { freeLibrary });
  if (errors.length > 0) throw new DomainValidationError(errors);
  const result = collectCosts(team, catalog, policy, errors, freeLibrary);
  if (errors.length > 0) throw new DomainValidationError(errors);
  const rawCharacterDiamonds = result.characterCosts.reduce((sum, item) => sum + item.chargedCopies * item.unitPrice, 0);
  const rawResourceDiamonds = Object.values(result.resources).reduce((sum, item) => sum + (item.consumed > 0 ? Math.max(0, item.chargedBeforeDiamondAllowance * item.unitPrice - item.diamondAllowanceCredit) : 0), 0);
  const precision = policy.rounding?.precision ?? 2;
  const characterDiamonds = round(rawCharacterDiamonds, precision);
  const grossCharacterDiamonds = round(result.characterCosts.reduce((sum, item) => sum + item.copies * item.unitPrice, 0), precision);
  const freeCharacterDiamonds = round(result.characterCosts.reduce((sum, item) => sum + item.freeCopies * item.unitPrice, 0), precision);
  const resourceDiamonds = round(rawResourceDiamonds, precision);
  const equipmentRawDiamonds = equipment => equipment.reduce((sum, gear) => sum + Object.values(gear.chargedResourceDiamonds).reduce((subTotal, amount) => subTotal + amount, 0), 0);
  const memberCosts = team.members.flatMap((member, index) => {
    if (!member) return [];
    const position = index + 1;
    const character = result.characterCosts.find(item => item.sourceKind === 'team' && item.position === position);
    const rawCharacterDiamonds = character.chargedCopies * character.unitPrice;
    const rawEquipmentDiamonds = equipmentRawDiamonds(result.equipmentCosts.filter(item => item.sourceKind === 'team' && item.position === position));
    return [{ position, characterId: member.characterId, characterName: character.characterName,
      characterDiamonds: round(rawCharacterDiamonds, precision), equipmentDiamonds: round(rawEquipmentDiamonds, precision),
      totalDiamonds: round(rawCharacterDiamonds + rawEquipmentDiamonds, precision),
      rawCharacterDiamonds, rawEquipmentDiamonds, rawTotalDiamonds: rawCharacterDiamonds + rawEquipmentDiamonds }];
  });
  const offTeamCharacterCosts = result.characterCosts.filter(item => item.sourceKind !== 'team');
  const rawOffTeamCharacterDiamonds = offTeamCharacterCosts.reduce((sum, item) => sum + item.chargedCopies * item.unitPrice, 0);
  const rawOffTeamEquipmentDiamonds = equipmentRawDiamonds(result.equipmentCosts.filter(item => item.sourceKind !== 'team'));
  return { ...result, memberCosts, offTeamCharacterCosts,
    offTeamCharacterDiamonds: round(rawOffTeamCharacterDiamonds, precision), offTeamEquipmentDiamonds: round(rawOffTeamEquipmentDiamonds, precision),
    offTeamDiamonds: round(rawOffTeamCharacterDiamonds + rawOffTeamEquipmentDiamonds, precision),
    rawOffTeamDiamonds: rawOffTeamCharacterDiamonds + rawOffTeamEquipmentDiamonds,
    memberCount: team.members.filter(Boolean).length, grossCharacterDiamonds, freeCharacterDiamonds, characterDiamonds, resourceDiamonds,
    totalDiamonds: round(rawCharacterDiamonds + rawResourceDiamonds, precision), policyVersion: policy.version ?? null };
}

export function createExport(team, catalog, policy, freeLibrary) {
  const validation = validateTeam(team, catalog, policy, { requireFullTeam: true, freeLibrary });
  if (!validation.valid) throw new DomainValidationError(validation.errors);
  return {
    format: FORMAT, schemaVersion: SCHEMA_VERSION,
    catalogVersion: catalog.version ?? null, exportedAt: new Date().toISOString(),
    policySnapshot: cloneJson(policy), team: cloneTeam(team),
    ...(freeLibrary ? { freeLibrarySnapshot: cloneJson(freeLibrary) } : {}),
    costBreakdown: calculateTeam(team, catalog, policy, freeLibrary),
  };
}

export function migrateLegacyWeaponConfiguration(team, catalog, policy, freeLibrary) {
  if (!automaticWeaponPricing(policy)) return { team, warnings: [], changed: false };
  const sources = team?.weaponSources;
  const hasSources = sources != null && (!Array.isArray(sources) || sources.length > 0);
  const hasSync = Array.isArray(team?.members) && team.members.some(member => Array.isArray(member?.equipment) && member.equipment.some(gear => gear?.syncSlot != null && gear.syncSlot !== 0));
  if (!hasSources && !hasSync) return { team, warnings: [], changed: false };
  const legacyPolicy = { ...policy, weaponSync: legacySyncSettings() };
  const validation = validateTeam(team, catalog, legacyPolicy, { freeLibrary });
  if (!validation.valid) {
    throw new DomainValidationError(validation.errors.map(issue => ({ ...issue,
      message: `旧武器配置无法安全迁移：${issue.message} 原始文件或草稿应保留备份。` })));
  }
  const oldSync = deriveWeaponSync(team, catalog, legacyPolicy, freeLibrary);
  const migrated = cloneTeam(team);
  migrated.members.forEach((member, index) => {
    if (!member) return;
    for (const gear of member.equipment) {
      if (gear.slot === 1 && gear.syncSlot > 0) gear.level = oldSync.effectiveLevels[index];
      gear.syncSlot = 0;
    }
  });
  migrated.weaponSources = [];
  return { team: migrated, changed: true, warnings: [
    '旧同步武器已按合法基石恢复实际等级；旧同步槽及队外基石已移除，不再收取隐藏库存费用。所有费用已按当前自动专武造价规则重新计算。',
  ] };
}

export function parseImport(value, catalog, policy, freeLibrary) {
  let imported = value;
  if (typeof value === 'string') {
    try { imported = JSON.parse(value); }
    catch { throw new DomainValidationError([{ path: 'file', code: 'INVALID_JSON', message: '文件不是有效的 JSON 配队文件。' }]); }
  }
  if (!isObject(imported) || imported.format !== FORMAT || imported.schemaVersion !== SCHEMA_VERSION) {
    throw new DomainValidationError([{ path: 'file', code: 'UNSUPPORTED_FORMAT', message: '文件格式或版本不受支持。' }]);
  }
  const migrated = migrateLegacyWeaponConfiguration(imported.team, catalog, policy, freeLibrary);
  const validation = validateTeam(migrated.team, catalog, policy, { requireFullTeam: true, freeLibrary });
  if (!validation.valid) throw new DomainValidationError(validation.errors);
  const team = cloneTeam(migrated.team);
  return { team, costBreakdown: calculateTeam(team, catalog, policy, freeLibrary), warnings: [...migrated.warnings, '导入文件中的策略、免费库和费用已按当前规则重新计算。'] };
}
