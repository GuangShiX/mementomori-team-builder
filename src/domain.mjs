export const EQUIPMENT_SLOTS = Object.freeze([1, 2, 3, 4, 5, 6]);
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
    slot, rarity: 'NONE', seriesId: null, weaponKind: 'normal', level: 450,
    reinforcementLevel: 0, legendSacredTreasureLevel: 0, matchlessSacredTreasureLevel: 0,
    runes: Array.from({ length: 4 }, () => ({ categoryId: 5, level: 0 })),
  };
}

export function createMember(character) {
  const characterId = isObject(character) ? character.id : character;
  if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new RangeError('角色编号无效。');
  return { characterId, rarity: 'SR', equipment: EQUIPMENT_SLOTS.map(createEquipment) };
}

export function createTeam() {
  return { name: '我的配队', author: '', notes: '', level: 450, members: Array(5).fill(null) };
}

export function cloneTeam(team) {
  return {
    name: team.name, author: team.author ?? '', notes: team.notes ?? '', level: team.level,
    members: team.members.map(member => member === null ? null : {
      characterId: member.characterId, rarity: member.rarity,
      equipment: member.equipment.map(gear => ({
        slot: gear.slot, rarity: gear.rarity,
        seriesId: gear.seriesId ?? defaultSeries(gear.rarity),
        weaponKind: gear.weaponKind ?? 'normal', level: gear.level,
        reinforcementLevel: gear.reinforcementLevel,
        legendSacredTreasureLevel: gear.legendSacredTreasureLevel,
        matchlessSacredTreasureLevel: gear.matchlessSacredTreasureLevel,
        runes: gear.runes.map(rune => ({ categoryId: rune.categoryId, level: rune.level })),
      })),
    }),
  };
}

function validateStructure(team, catalog, policy, { requireFullTeam = false } = {}) {
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
  const ticketCategoryIds = policy.runes?.ticketCategoryIds ?? [5, 9];
  if (!Array.isArray(ticketCategoryIds) || new Set(ticketCategoryIds).size !== ticketCategoryIds.length || ticketCategoryIds.some(id => !catalog.runeCategories.some(category => category.id === id))) error(errors, 'policy.runes.ticketCategoryIds', 'INVALID_RUNE_CONVERSION', '兑换券符石类型配置必须为目录中不重复的类型编号。');
  const fixedStock = policy.runes?.fixedStock;
  if (fixedStock !== undefined) {
    if (!isObject(fixedStock) || !integerIn(fixedStock.level, 1, policy.limits?.runeLevel ?? 15) || !integerIn(fixedStock.perCategory, 0, 120)
      || !Array.isArray(fixedStock.excludedCategoryIds) || !Array.isArray(ticketCategoryIds)
      || fixedStock.excludedCategoryIds.length !== new Set(fixedStock.excludedCategoryIds).size
      || fixedStock.excludedCategoryIds.length !== ticketCategoryIds.length
      || fixedStock.excludedCategoryIds.some(id => !ticketCategoryIds.includes(id))) {
      error(errors, 'policy.runes.fixedStock', 'INVALID_FIXED_RUNE_STOCK', '普通符石固定库存配置无效；排除类型必须与兑换券符石类型一致。');
    }
  }
  if (errors.length > 0) return errors;
  if (!isObject(team)) {
    error(errors, 'team', 'INVALID_TEAM', '配队必须为一个对象。');
    return errors;
  }
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
      if (Number.isSafeInteger(gear.reinforcementLevel) && gear.reinforcementLevel > gear.level) error(errors, `${path}.reinforcementLevel`, 'REINFORCEMENT_EXCEEDS_LEVEL', '强化等级不能超过装备等级。');
      if (!['normal', 'exclusive'].includes(weaponKind)) error(errors, `${path}.weaponKind`, 'INVALID_WEAPON_KIND', '武器类型无效。');
      if (weaponKind === 'exclusive' && (gear.slot !== 1 || !['SSR', 'UR', 'LR'].includes(gear.rarity))) error(errors, `${path}.weaponKind`, 'INVALID_EXCLUSIVE_WEAPON', '专属武器仅支持第 1 槽的 SSR、UR 或 LR 装备。');
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
            if (rune.level !== fixedStock.level) error(errors, `${runePath}.level`, 'FIXED_RUNE_LEVEL', `${category.name}仅提供 ${fixedStock.level} 级免费符石，不能选择其它等级。`);
            fixedRuneCounts.set(category.id, (fixedRuneCounts.get(category.id) ?? 0) + 1);
          }
        }
      });
      if (gear.rarity === 'NONE' && (
        gear.reinforcementLevel !== 0 || gear.legendSacredTreasureLevel !== 0 || gear.matchlessSacredTreasureLevel !== 0
        || gear.runes.some(rune => rune?.level !== 0) || weaponKind !== 'normal' || gear.seriesId != null
      )) error(errors, path, 'EMPTY_GEAR_HAS_UPGRADES', '无装备的槽位不能保留强化、圣装、魔装或符石。');
    });
  });
  for (const [categoryId, used] of fixedRuneCounts) {
    if (used > fixedStock.perCategory) {
      const category = catalog.runeCategories.find(item => item.id === categoryId);
      error(errors, `fixedRuneInventory.${categoryId}`, 'FIXED_RUNE_STOCK_EXCEEDED', `${category.name}整队仅提供 ${fixedStock.perCategory} 颗 ${fixedStock.level} 级免费符石，当前使用 ${used} 颗。`);
    }
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

function collectCosts(team, catalog, policy, errors) {
  const precision = policy.rounding?.precision ?? 2;
  const consumed = Object.fromEntries(RESOURCE_KEYS.map(key => [key, 0]));
  const characterCosts = [];
  const equipmentCosts = [];
  const fixedStock = policy.runes?.fixedStock;
  const fixedRuneInventory = fixedStock ? catalog.runeCategories.filter(category => !fixedStock.excludedCategoryIds.includes(category.id)).map(category => ({ categoryId: category.id, name: category.name, level: fixedStock.level, used: 0, available: fixedStock.perCategory, remaining: fixedStock.perCategory })) : [];
  let legendExperience = 0;
  let matchlessExperience = 0;
  const addResource = (resource, amount, path) => {
    if (!RESOURCE_KEYS.includes(resource) || !finiteNonnegative(amount)) {
      error(errors, path, 'UNKNOWN_RESOURCE', '材料类型或数量未知，无法估价。');
      return;
    }
    consumed[resource] += amount;
  };
  team.members.forEach((member, memberIndex) => {
    if (!member) return;
    const character = catalog.characters.find(item => item.id === member.characterId);
    const lightDark = ['light', 'dark'].includes(character.element);
    const copies = policy.copies?.[member.rarity]?.[lightDark ? 'lightDark' : 'normal'];
    const copyPrice = policy.unitPrices?.characterCopy;
    if (!Number.isSafeInteger(copies) || copies < 1 || !finiteNonnegative(copyPrice)) {
      error(errors, `policy.copies.${member.rarity}`, 'INVALID_CHARACTER_PRICE', '角色本体数量或单价规则无效。');
    }
    characterCosts.push({ position: memberIndex + 1, characterId: character.id, characterName: character.name, rarity: member.rarity, copies, unitPrice: copyPrice, diamonds: round(copies * copyPrice, precision) });
    member.equipment.forEach((gear, gearIndex) => {
      if (gear.rarity === 'NONE') return;
      const path = `members[${memberIndex}].equipment[${gearIndex}]`;
      const gearResources = {};
      const addGearResource = (resource, amount) => {
        addResource(resource, amount, path);
        gearResources[resource] = (gearResources[resource] ?? 0) + amount;
      };
      const seriesId = gear.seriesId ?? defaultSeries(gear.rarity);
      const series = getSeries(catalog)?.find(item => item.id === seriesId);
      const weaponKind = gear.weaponKind ?? 'normal';
      const exclusive = weaponKind === 'exclusive';
      const fragmentTableKey = exclusive ? `exclusive${gear.rarity}` : series?.costTable ?? gear.rarity;
      const fragmentResource = exclusive ? 'exclusiveFragments' : series?.costResource ?? (gear.rarity === 'SSR' ? 'ssrFragments' : 'urLrFragments');
      const fragments = readCost(catalog.equipmentCosts?.fragments?.[fragmentTableKey], gear.level, errors, `${path}.level`, '装备碎片');
      addGearResource(fragmentResource, fragments);
      if (['UR', 'LR'].includes(gear.rarity)) {
        const materialKey = { UR: { normal: 'urLifeTreeDew', exclusive: 'exclusiveUrLifeTreeDew' }, LR: { normal: 'lrLifeTreeDew', exclusive: 'exclusiveLrLifeTreeDew' } }[gear.rarity][weaponKind];
        const lifeTreeDew = policy.equipment?.[materialKey];
        if (!finiteNonnegative(lifeTreeDew)) error(errors, `policy.equipment.${materialKey}`, 'UNKNOWN_EVOLUTION_COST', '装备进化所需生命树之露数量尚未配置。');
        else addGearResource('lifeTreeDew', lifeTreeDew);
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
          const inventory = fixedRuneInventory.find(item => item.categoryId === category.id);
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
      equipmentCosts.push({ position: memberIndex + 1, characterId: character.id, slot: gear.slot, rarity: gear.rarity, seriesId, seriesName: series?.name ?? gear.rarity, weaponKind, level: gear.level, legendExperience: legend, matchlessExperience: matchless, resources: gearResources });
    });
  });
  const resources = {};
  for (const key of RESOURCE_KEYS) {
    const amount = consumed[key];
    const allowance = policy.allowances?.[key] ?? 0;
    const unitPrice = policy.unitPrices?.[key];
    if (!finiteNonnegative(allowance)) error(errors, `policy.allowances.${key}`, 'INVALID_ALLOWANCE', '免费材料额度必须为非负数。');
    if (amount > 0 && !finiteNonnegative(unitPrice)) error(errors, `policy.unitPrices.${key}`, 'UNKNOWN_RESOURCE_PRICE', `${key} 单价尚未确认，无法估价。`);
    const charged = finiteNonnegative(allowance) ? Math.max(0, amount - allowance) : NaN;
    resources[key] = { consumed: amount, freeAllowance: allowance, charged, unitPrice: finiteNonnegative(unitPrice) ? unitPrice : null, diamonds: amount === 0 ? 0 : round(charged * unitPrice, precision) };
    const hardLimit = policy.hardLimits?.[key];
    if (hardLimit != null && (!finiteNonnegative(hardLimit) || amount > hardLimit)) error(errors, `resources.${key}`, 'RESOURCE_LIMIT_EXCEEDED', `${key} 超出当前规则允许的材料额度。`);
  }
  return { characterCosts, equipmentCosts, resources, legendExperience, matchlessExperience, fixedRuneInventory };
}

export function validateTeam(team, catalog, policy, options = {}) {
  const errors = validateStructure(team, catalog, policy, options);
  if (errors.length === 0) collectCosts(team, catalog, policy, errors);
  return { valid: errors.length === 0, errors };
}

export function calculateTeam(team, catalog, policy) {
  const errors = validateStructure(team, catalog, policy);
  if (errors.length > 0) throw new DomainValidationError(errors);
  const result = collectCosts(team, catalog, policy, errors);
  if (errors.length > 0) throw new DomainValidationError(errors);
  const rawCharacterDiamonds = result.characterCosts.reduce((sum, item) => sum + item.copies * item.unitPrice, 0);
  const rawResourceDiamonds = Object.values(result.resources).reduce((sum, item) => sum + (item.consumed > 0 ? item.charged * item.unitPrice : 0), 0);
  const precision = policy.rounding?.precision ?? 2;
  const characterDiamonds = round(rawCharacterDiamonds, precision);
  const resourceDiamonds = round(rawResourceDiamonds, precision);
  return { ...result, memberCount: team.members.filter(Boolean).length, characterDiamonds, resourceDiamonds, totalDiamonds: round(rawCharacterDiamonds + rawResourceDiamonds, precision), policyVersion: policy.version ?? null };
}

export function createExport(team, catalog, policy) {
  const validation = validateTeam(team, catalog, policy, { requireFullTeam: true });
  if (!validation.valid) throw new DomainValidationError(validation.errors);
  return {
    format: FORMAT, schemaVersion: SCHEMA_VERSION,
    catalogVersion: catalog.version ?? null, exportedAt: new Date().toISOString(),
    policySnapshot: cloneJson(policy), team: cloneTeam(team),
    costBreakdown: calculateTeam(team, catalog, policy),
  };
}

export function parseImport(value, catalog, policy) {
  let imported = value;
  if (typeof value === 'string') {
    try { imported = JSON.parse(value); }
    catch { throw new DomainValidationError([{ path: 'file', code: 'INVALID_JSON', message: '文件不是有效的 JSON 配队文件。' }]); }
  }
  if (!isObject(imported) || imported.format !== FORMAT || imported.schemaVersion !== SCHEMA_VERSION) {
    throw new DomainValidationError([{ path: 'file', code: 'UNSUPPORTED_FORMAT', message: '文件格式或版本不受支持。' }]);
  }
  const validation = validateTeam(imported.team, catalog, policy, { requireFullTeam: true });
  if (!validation.valid) throw new DomainValidationError(validation.errors);
  const team = cloneTeam(imported.team);
  return { team, costBreakdown: calculateTeam(team, catalog, policy), warnings: ['导入文件中的策略和费用已按当前规则重新计算。'] };
}
