import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeam, createMember, createEquipment, calculateTeam, validateTeam,
  createExport, parseImport, cloneTeam, DomainValidationError,
} from '../src/domain.mjs';

const catalog = {
  version: 'fixture-1',
  characters: [
    { id: 1, name: '蓝角色', element: 'blue' },
    { id: 2, name: '红角色', element: 'red' },
    { id: 3, name: '绿角色', element: 'green' },
    { id: 4, name: '光角色', element: 'light' },
    { id: 5, name: '暗角色', element: 'dark' },
    { id: 6, name: '黄角色', element: 'yellow' },
  ],
  runeCategories: [
    { id: 5, name: '穿透', ticketBased: true, allowedSlots: [1, 2, 3] },
    { id: 9, name: '速度', ticketBased: true, allowedSlots: [1, 2, 3] },
    { id: 1, name: '攻击', ticketBased: false, allowedSlots: [1, 2, 3] },
    { id: 10, name: '防御', ticketBased: false, allowedSlots: [4, 5, 6] },
  ],
  equipmentSeries: [
    { id: 12, name: '撒旦', rarities: ['SSR'], costResource: 'ssrFragments' },
    { id: 13, name: '米迦勒', rarities: ['UR'], costResource: 'urLrFragments' },
    { id: 14, name: '梅塔特隆', rarities: ['LR'], costResource: 'urLrFragments' },
  ],
  equipmentCosts: {
    reinforcement: {
      weapon: Array.from({ length: 451 }, (_, level) => level * 1000),
      other: Array.from({ length: 451 }, (_, level) => level * 500),
    },
    sacredExperience: Array.from({ length: 41 }, (_, level) => level === 0 ? 0 : 1 + level * (level - 1) / 2),
    fragments: {
      SSR: { 450: 50 }, UR: { 450: 200 }, LR: { 450: 200 },
      exclusiveSSR: { 180: 240, 200: 280, 220: 320, 240: 360 },
      exclusiveUR: { 450: 600 }, exclusiveLR: { 450: 600 },
    },
    allowedLevels: { SSR: [450], UR: [450], LR: [450] },
  },
};
const policy = {
  version: 'fixture-pricing-1', characterLevel: 450,
  allowances: { runeTickets: 100000, reinforcementMedicine: 100000, unidentifiedRune7: 0, holySteel: 3500 },
  unitPrices: {
    characterCopy: 17000, runeTicket: 10, runeTickets: 10, reinforcementMedicine: 10,
    unidentifiedRune7: 1000, holySteel: 100, ssrFragments: 44.2470588235294,
    urLrFragments: 211.4210142276423, exclusiveFragments: 46.0676829268293,
    lifeTreeDew: 400,
  },
  copies: { SR: { normal: 1, lightDark: 1 }, LR: { normal: 8, lightDark: 14 }, LR5: { normal: 20, lightDark: 26 } },
  holySteelPerExperience: 1, holySteelUnit: 'level1SacredEquivalent', rawHolySteelPerExperience: 1000,
  runes: { ticketCategoryIds: [5, 9], ticketExponentOffset: 0, unidentifiedRuneBaseLevel: 7 },
  equipment: { urLifeTreeDew: 0, lrLifeTreeDew: 50, exclusiveUrLifeTreeDew: 15, exclusiveLrLifeTreeDew: 65 },
};
const copy = value => JSON.parse(JSON.stringify(value));
const fullTeam = () => {
  const team = createTeam();
  team.members = catalog.characters.slice(0, 5).map(createMember);
  return team;
};
const equip = (member, slot, overrides = {}) => {
  const gear = {
    ...createEquipment(slot), rarity: 'SSR', seriesId: 12,
    ...overrides,
  };
  member.equipment[slot - 1] = gear;
  return gear;
};

test('empty slots keep stable positions and cost no character or equipment resources', () => {
  const team = createTeam();
  const result = calculateTeam(team, catalog, policy);
  assert.equal(result.memberCount, 0);
  assert.equal(result.totalDiamonds, 0);
  assert.deepEqual(createMember(catalog.characters[0]).equipment.map(item => item.slot), [1, 2, 3, 4, 5, 6]);
  assert.equal(validateTeam(team, catalog, policy).valid, true);
  assert.equal(validateTeam(team, catalog, policy, { requireFullTeam: true }).errors.filter(item => item.code === 'EMPTY_MEMBER').length, 5);
});

test('normal and light/dark characters use approved copies for SR, LR and LR5', () => {
  const team = fullTeam();
  ['SR', 'LR', 'LR5', 'LR', 'LR5'].forEach((rarity, index) => { team.members[index].rarity = rarity; });
  const result = calculateTeam(team, catalog, policy);
  assert.deepEqual(result.characterCosts.map(item => item.copies), [1, 8, 20, 14, 26]);
  assert.equal(result.characterDiamonds, 69 * 17000);
  assert.equal(result.totalDiamonds, 1173000);
});

test('free rune tickets and reinforcement medicine are shared by the team and charged independently', () => {
  const team = fullTeam();
  for (const member of team.members) {
    const gear = equip(member, 1, { reinforcementLevel: 30 });
    gear.runes[0] = { categoryId: 5, level: 15 };
    gear.runes[1] = { categoryId: 9, level: 15 };
  }
  const result = calculateTeam(team, catalog, policy);
  assert.equal(result.resources.runeTickets.consumed, 327680);
  assert.equal(result.resources.runeTickets.freeAllowance, 100000);
  assert.equal(result.resources.runeTickets.charged, 227680);
  assert.equal(result.resources.runeTickets.diamonds, 2276800);
  assert.equal(result.resources.reinforcementMedicine.consumed, 150000);
  assert.equal(result.resources.reinforcementMedicine.charged, 50000);
  assert.equal(result.resources.reinforcementMedicine.diamonds, 500000);
  const generousPolicy = copy(policy);
  generousPolicy.allowances.runeTickets = 400000;
  const generous = calculateTeam(team, catalog, generousPolicy);
  assert.equal(generous.resources.runeTickets.diamonds, 0);
  assert.equal(generous.resources.reinforcementMedicine.diamonds, 500000);
  assert.equal(generousPolicy.allowances.reinforcementMedicine, 100000);
});

test('the allowance threshold is free and the first extra material costs exactly ten diamonds', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  equip(team.members[0], 1, { reinforcementLevel: 100 });
  const atThreshold = calculateTeam(team, catalog, policy);
  assert.equal(atThreshold.resources.reinforcementMedicine.consumed, 100000);
  assert.equal(atThreshold.resources.reinforcementMedicine.diamonds, 0);
  const adjustedCatalog = copy(catalog);
  adjustedCatalog.equipmentCosts.reinforcement.weapon[100] = 100001;
  const oneOver = calculateTeam(team, adjustedCatalog, policy);
  assert.equal(oneOver.resources.reinforcementMedicine.charged, 1);
  assert.equal(oneOver.resources.reinforcementMedicine.diamonds, 10);
});

test('other runes are counted in fractional seven-level unidentified rune equivalents', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  const gear = equip(team.members[0], 1);
  gear.runes[0] = { categoryId: 1, level: 6 };
  const six = calculateTeam(team, catalog, policy);
  assert.equal(six.resources.unidentifiedRune7.consumed, 0.5);
  assert.equal(six.resources.unidentifiedRune7.diamonds, 500);
  gear.runes[0].level = 15;
  const fifteen = calculateTeam(team, catalog, policy);
  assert.equal(fifteen.resources.unidentifiedRune7.consumed, 256);
  assert.equal(fifteen.resources.unidentifiedRune7.diamonds, 256000);
});

const stockPolicy = () => {
  const configured = copy(policy);
  configured.runes.fixedStock = { level: 11, perCategory: 3, excludedCategoryIds: [5, 9] };
  return configured;
};
const installStockRune = (member, categoryId = 1, slot = 1, level = 11) => {
  const gear = equip(member, slot);
  gear.runes[0] = { categoryId, level };
  return gear;
};

test('ordinary rune fixed stock allows exactly three level-eleven runes per category without unidentified-rune charges', () => {
  const team = fullTeam();
  for (const member of team.members.slice(0, 3)) installStockRune(member);
  const result = calculateTeam(team, catalog, stockPolicy());
  assert.deepEqual(result.fixedRuneInventory, [
    { categoryId: 1, name: '攻击', level: 11, used: 3, available: 3, remaining: 0 },
    { categoryId: 10, name: '防御', level: 11, used: 0, available: 3, remaining: 3 },
  ]);
  assert.equal(result.resources.unidentifiedRune7.consumed, 0);
  assert.equal(result.resources.unidentifiedRune7.charged, 0);
  assert.equal(result.resources.unidentifiedRune7.diamonds, 0);
  assert.equal(validateTeam(team, catalog, stockPolicy()).valid, true);
  assert.doesNotThrow(() => createExport(team, catalog, stockPolicy()));
});

test('the fourth ordinary rune of one category exceeds the whole-team stock and prevents calculation and export', () => {
  const team = fullTeam();
  for (const member of team.members.slice(0, 4)) installStockRune(member);
  const configured = stockPolicy();
  const stockError = validateTeam(team, catalog, configured).errors.find(item => item.code === 'FIXED_RUNE_STOCK_EXCEEDED');
  assert.match(stockError.message, /攻击.*3.*11.*4/);
  assert.throws(() => calculateTeam(team, catalog, configured), error => error.errors.some(item => item.code === 'FIXED_RUNE_STOCK_EXCEEDED'));
  assert.throws(() => createExport(team, catalog, configured), error => error.errors.some(item => item.code === 'FIXED_RUNE_STOCK_EXCEEDED'));
});

test('ordinary rune inventories are independent per category while penetration and speed remain exchange-ticket runes', () => {
  const team = fullTeam();
  for (const member of team.members.slice(0, 3)) {
    const weapon = installStockRune(member, 1, 1);
    weapon.runes[1] = { categoryId: 5, level: 1 };
    weapon.runes[2] = { categoryId: 9, level: 15 };
    installStockRune(member, 10, 4);
  }
  const result = calculateTeam(team, catalog, stockPolicy());
  assert.deepEqual(result.fixedRuneInventory.map(item => [item.categoryId, item.used, item.remaining]), [[1, 3, 0], [10, 3, 0]]);
  assert.equal(result.resources.runeTickets.consumed, 3 * (2 + 32768));
  assert.equal(result.resources.unidentifiedRune7.consumed, 0);
});

test('fixed-stock ordinary runes reject every installed level other than eleven with a category-name explanation', () => {
  const configured = stockPolicy();
  for (const level of [1, 7, 10, 12, 15]) {
    const team = fullTeam();
    installStockRune(team.members[0], 1, 1, level);
    const levelError = validateTeam(team, catalog, configured).errors.find(item => item.code === 'FIXED_RUNE_LEVEL');
    assert.match(levelError.message, /攻击.*11/);
    assert.throws(() => createExport(team, catalog, configured), DomainValidationError);
  }
});

test('fixed stock import ignores forged policy allowances and validates current inventory and level restrictions', () => {
  const configured = stockPolicy();
  const team = fullTeam();
  for (const member of team.members.slice(0, 3)) installStockRune(member);
  const exported = createExport(team, catalog, configured);
  exported.policySnapshot.runes.fixedStock.perCategory = 999;
  exported.costBreakdown.fixedRuneInventory[0].available = 999;
  const imported = parseImport(exported, catalog, configured);
  assert.equal(imported.costBreakdown.fixedRuneInventory[0].available, 3);
  installStockRune(exported.team.members[3]);
  assert.throws(() => parseImport(exported, catalog, configured), error => error.errors.some(item => item.code === 'FIXED_RUNE_STOCK_EXCEEDED'));
  exported.team.members[3].equipment[0].runes[0].level = 0;
  exported.team.members[0].equipment[0].runes[0].level = 12;
  assert.throws(() => parseImport(exported, catalog, configured), error => error.errors.some(item => item.code === 'FIXED_RUNE_LEVEL'));
});

test('holy steel is accumulated as level-one sacred equivalents; matchless experience is displayed without consuming steel', () => {
  const team = fullTeam();
  for (const member of team.members) equip(member, 1, { legendSacredTreasureLevel: 40, matchlessSacredTreasureLevel: 40 });
  const result = calculateTeam(team, catalog, policy);
  assert.equal(result.legendExperience, 3905);
  assert.equal(result.matchlessExperience, 3905);
  assert.equal(result.resources.holySteel.consumed, 3905);
  assert.equal(result.resources.holySteel.freeAllowance, 3500);
  assert.equal(result.resources.holySteel.charged, 405);
  assert.equal(result.resources.holySteel.diamonds, 40500);
  assert.equal(result.equipmentCosts[0].legendExperience, 781);
  assert.equal(result.equipmentCosts[0].matchlessExperience, 781);
});

test('cumulative fragment tables and LR evolution cost are used once per equipped item', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[0].rarity = 'LR5';
  equip(team.members[0], 1, { rarity: 'LR', seriesId: 14, weaponKind: 'exclusive' });
  equip(team.members[0], 2, { rarity: 'LR', seriesId: 14 });
  equip(team.members[0], 3, { rarity: 'UR', seriesId: 13 });
  const result = calculateTeam(team, catalog, policy);
  assert.equal(result.resources.exclusiveFragments.consumed, 600);
  assert.equal(result.resources.urLrFragments.consumed, 400);
  assert.equal(result.resources.lifeTreeDew.consumed, 115);
  assert.equal(result.resources.lifeTreeDew.diamonds, 46000);
  assert.equal(result.resources.exclusiveFragments.diamonds, 27640.61);
  assert.equal(result.resources.urLrFragments.diamonds, 84568.41);
});

test('exclusive UR and LR weapons include their complete fifteen and sixty-five dew costs', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[0].rarity = 'LR5';
  const weapon = equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive' });
  assert.equal(calculateTeam(team, catalog, policy).resources.lifeTreeDew.consumed, 15);
  weapon.rarity = 'LR';
  weapon.seriesId = 14;
  assert.equal(calculateTeam(team, catalog, policy).resources.lifeTreeDew.consumed, 65);
});

test('rounding is applied after summing raw resource fees, not after summing displayed rows', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  const gear = equip(team.members[0], 1);
  gear.runes[0] = { categoryId: 1, level: 7 };
  const decimalPolicy = copy(policy);
  decimalPolicy.unitPrices.ssrFragments = 0.00666;
  decimalPolicy.unitPrices.unidentifiedRune7 = 0.333;
  const result = calculateTeam(team, catalog, decimalPolicy);
  assert.equal(result.resources.ssrFragments.diamonds, 0.33);
  assert.equal(result.resources.unidentifiedRune7.diamonds, 0.33);
  assert.equal(result.resourceDiamonds, 0.67);
  assert.equal(result.totalDiamonds, 17000.67);
});

test('exclusive SSR weapons use their own available levels and fragment resource', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  equip(team.members[0], 1, { weaponKind: 'exclusive', level: 240 });
  const result = calculateTeam(team, catalog, policy);
  assert.equal(result.resources.exclusiveFragments.consumed, 360);
  assert.equal(result.resources.ssrFragments.consumed, 0);
  team.members[0].equipment[0].level = 450;
  assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'UNAVAILABLE_GEAR_LEVEL'), true);
});

test('unknown material amounts and resource prices fail rather than silently become free', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  equip(team.members[0], 1, { reinforcementLevel: 25 });
  const missingMedicine = copy(catalog);
  delete missingMedicine.equipmentCosts.reinforcement.weapon[25];
  assert.throws(() => calculateTeam(team, missingMedicine, policy), error => error instanceof DomainValidationError && error.errors.some(item => item.code === 'UNKNOWN_RESOURCE_COST'));
  const missingPrice = copy(policy);
  delete missingPrice.unitPrices.ssrFragments;
  assert.throws(() => calculateTeam(team, catalog, missingPrice), error => error.errors.some(item => item.code === 'UNKNOWN_RESOURCE_PRICE'));
  const unknownResource = copy(catalog);
  unknownResource.equipmentSeries[0].costResource = 'notPriced';
  assert.throws(() => calculateTeam(team, unknownResource, policy), error => error.errors.some(item => item.code === 'UNKNOWN_RESOURCE'));
});

test('duplicate characters, wrong slots, duplicate runes, invalid rune slots and LR without LR5 are rejected', () => {
  const duplicate = fullTeam();
  duplicate.members[1].characterId = duplicate.members[0].characterId;
  assert.equal(validateTeam(duplicate, catalog, policy).errors.some(item => item.code === 'DUPLICATE_CHARACTER'), true);
  const team = createTeam();
  team.members[0] = createMember(1);
  const gear = equip(team.members[0], 4, { rarity: 'LR', seriesId: 14 });
  gear.slot = 5;
  gear.runes[0] = { categoryId: 5, level: 1 };
  gear.runes[1] = { categoryId: 5, level: 1 };
  const codes = validateTeam(team, catalog, policy).errors.map(item => item.code);
  for (const expected of ['LR_REQUIRES_LR5', 'INVALID_SLOT', 'DUPLICATE_RUNE_CATEGORY', 'RUNE_SLOT_RESTRICTION']) assert.equal(codes.includes(expected), true);
});

test('empty equipment cannot retain hidden upgrades or installed runes', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[0].equipment[0].legendSacredTreasureLevel = 1;
  assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'EMPTY_GEAR_HAS_UPGRADES'), true);
  assert.throws(() => calculateTeam(team, catalog, policy), DomainValidationError);
});

test('nonfinite numbers, unsupported level and too many rune holes never reach pricing', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  equip(team.members[0], 1, { reinforcementLevel: Infinity });
  assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'INVALID_UPGRADE_LEVEL'), true);
  team.members[0].equipment[0].reinforcementLevel = 0;
  team.level = 451;
  assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'FIXED_LEVEL'), true);
  team.level = 450;
  team.members[0].equipment[0].runes.push({ categoryId: 1, level: 1 });
  assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'INVALID_RUNE_SIZE'), true);
});

test('export captures all pricing variables; import recomputes under current owner policy and strips unknown team fields', () => {
  const team = fullTeam();
  team.name = '450级构筑';
  team.author = '测试玩家';
  team.notes = '用于离线构建';
  const exported = createExport(team, catalog, policy);
  assert.equal(exported.format, 'mementomori-team-plan');
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.policySnapshot.rawHolySteelPerExperience, 1000);
  assert.notEqual(exported.team, team);
  assert.equal(Number.isNaN(Date.parse(exported.exportedAt)), false);
  exported.policySnapshot.unitPrices.characterCopy = 1;
  exported.costBreakdown.totalDiamonds = 0;
  exported.team.totalDiamonds = 0;
  exported.team.members[0].diamonds = 0;
  const currentPolicy = copy(policy);
  currentPolicy.unitPrices.characterCopy = 18000;
  const imported = parseImport(JSON.stringify(exported), catalog, currentPolicy);
  assert.equal(imported.costBreakdown.totalDiamonds, 90000);
  assert.equal(imported.team.author, '测试玩家');
  assert.equal('totalDiamonds' in imported.team, false);
  assert.equal('diamonds' in imported.team.members[0], false);
  assert.equal(policy.unitPrices.characterCopy, 17000);
});

test('incomplete exports, unknown schema and malformed import data are rejected', () => {
  assert.throws(() => createExport(createTeam(), catalog, policy), DomainValidationError);
  assert.throws(() => parseImport('{', catalog, policy), error => error.errors[0].code === 'INVALID_JSON');
  const exported = createExport(fullTeam(), catalog, policy);
  exported.schemaVersion = 999;
  assert.throws(() => parseImport(exported, catalog, policy), error => error.errors[0].code === 'UNSUPPORTED_FORMAT');
  exported.schemaVersion = 1;
  exported.team.members[0].characterId = 9999;
  assert.throws(() => parseImport(exported, catalog, policy), error => error.errors.some(item => item.code === 'UNKNOWN_CHARACTER'));
});

test('cloning never links member equipment or runes to the original', () => {
  const original = fullTeam();
  const cloned = cloneTeam(original);
  cloned.members[0].rarity = 'LR5';
  cloned.members[0].equipment[0].runes[0].level = 15;
  assert.equal(original.members[0].rarity, 'SR');
  assert.equal(original.members[0].equipment[0].runes[0].level, 0);
  assert.equal(calculateTeam(original, catalog, policy).totalDiamonds, 85000);
});
