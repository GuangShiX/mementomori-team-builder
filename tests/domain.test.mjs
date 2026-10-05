import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeam, createMember, createEquipment, selectEquipmentRarity, calculateTeam, validateTeam,
  createExport, parseImport, cloneTeam, DomainValidationError,
  deriveWeaponSync,
  getBorrowableWeapons, isWeaponOwnerClaimed,
  deriveWeaponPricing, migrateLegacyWeaponConfiguration, getResourceAllowance,
  POLISH_ATTRIBUTES,
} from '../src/domain.mjs';

const catalog = {
  version: 'fixture-1',
  characters: [
    { id: 1, name: '蓝角色', element: 'blue', job: 1 },
    { id: 2, name: '红角色', element: 'red', job: 1 },
    { id: 3, name: '绿角色', element: 'green', job: 1 },
    { id: 4, name: '光角色', element: 'light', job: 2 },
    { id: 5, name: '暗角色', element: 'dark', job: 2 },
    { id: 6, name: '黄角色', element: 'yellow', job: 1 },
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

test('new equipment defaults to main-attribute polish without adding any empty-slot investment', () => {
  assert.deepEqual(POLISH_ATTRIBUTES, ['main', 'none', 'muscle', 'energy', 'health', 'intelligence']);
  const team = fullTeam();
  assert.deepEqual(team.members[0].equipment.map(gear => gear.polishAttribute), Array(6).fill('main'));
  const before = calculateTeam(team, catalog, policy);
  for (const gear of team.members[0].equipment) gear.polishAttribute = 'health';
  assert.equal(validateTeam(team, catalog, policy, { requireFullTeam: true }).valid, true);
  const after = calculateTeam(team, catalog, policy);
  assert.deepEqual(after.resources, before.resources);
  assert.equal(after.totalDiamonds, before.totalDiamonds);
  assert.equal(after.equipmentCosts.length, 0);
});

test('all polish choices survive cloning and export import without changing equipment fees', () => {
  const team = fullTeam();
  for (const slot of [1, 2, 3, 4, 5, 6]) equip(team.members[0], slot);
  const before = calculateTeam(team, catalog, policy);
  team.members[0].equipment.forEach((gear, index) => { gear.polishAttribute = POLISH_ATTRIBUTES[index]; });
  const expected = [...POLISH_ATTRIBUTES];
  assert.deepEqual(cloneTeam(team).members[0].equipment.map(gear => gear.polishAttribute), expected);
  const exported = createExport(team, catalog, policy);
  assert.deepEqual(exported.team.members[0].equipment.map(gear => gear.polishAttribute), expected);
  const imported = parseImport(exported, catalog, policy);
  assert.deepEqual(imported.team.members[0].equipment.map(gear => gear.polishAttribute), expected);
  assert.equal(imported.costBreakdown.totalDiamonds, before.totalDiamonds);
  assert.deepEqual(imported.costBreakdown.resources, before.resources);
  assert.equal(selectEquipmentRarity(team.members[0].equipment[1], 'UR').polishAttribute, 'none');
});

test('old drafts and imports missing polish use main while explicit no-polish is preserved', () => {
  const team = fullTeam();
  for (const member of team.members) for (const gear of member.equipment) delete gear.polishAttribute;
  team.members[0].equipment[1].polishAttribute = 'none';
  const cloned = cloneTeam(team);
  assert.equal(cloned.members[0].equipment[0].polishAttribute, 'main');
  assert.equal(cloned.members[0].equipment[1].polishAttribute, 'none');
  assert.equal(team.members[0].equipment[0].polishAttribute, undefined);
  assert.equal(selectEquipmentRarity(team.members[0].equipment[0], 'SSR').polishAttribute, 'main');
  const exported = createExport(team, catalog, policy);
  for (const member of exported.team.members) for (const gear of member.equipment) delete gear.polishAttribute;
  exported.team.members[0].equipment[1].polishAttribute = 'none';
  const imported = parseImport(exported, catalog, policy);
  assert.equal(imported.team.members[0].equipment[0].polishAttribute, 'main');
  assert.equal(imported.team.members[0].equipment[1].polishAttribute, 'none');
  assert.equal(exported.team.members[0].equipment[0].polishAttribute, undefined);
});

test('unknown polish selections are rejected instead of becoming a different attribute on export or import', () => {
  for (const value of ['attack', '', 0, null, ['main']]) {
    const team = fullTeam();
    team.members[0].equipment[1].polishAttribute = value;
    const invalid = error => error instanceof DomainValidationError && error.errors.some(item => item.code === 'INVALID_POLISH_ATTRIBUTE');
    assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'INVALID_POLISH_ATTRIBUTE'), true);
    assert.throws(() => createExport(team, catalog, policy), invalid);
    const exported = createExport(fullTeam(), catalog, policy);
    exported.team.members[0].equipment[1].polishAttribute = value;
    assert.throws(() => parseImport(exported, catalog, policy), invalid);
  }
});

test('first equipment selection defaults magic armor to forty without changing empty equipment factories', () => {
  for (const rarity of ['SSR', 'UR', 'LR']) {
    const empty = createEquipment(2);
    const selected = selectEquipmentRarity(empty, rarity);
    assert.equal(empty.matchlessSacredTreasureLevel, 0);
    assert.equal(selected.matchlessSacredTreasureLevel, 40);
    assert.equal(selected.legendSacredTreasureLevel, 0);
    assert.equal(selected.seriesId, { SSR: 12, UR: 13, LR: 14 }[rarity]);
    selected.runes[0].level = 10;
    assert.equal(empty.runes[0].level, 0);
  }
  assert.deepEqual(createMember(1).equipment.map(gear => gear.matchlessSacredTreasureLevel), [0, 0, 0, 0, 0, 0]);
  assert.throws(() => selectEquipmentRarity(createEquipment(2), 'SR'), RangeError);
});

test('existing equipment and imported builds retain magic armor zero or chosen level', () => {
  for (const level of [0, 17, 40]) {
    const team = fullTeam();
    const original = equip(team.members[0], 2, { matchlessSacredTreasureLevel: level });
    const imported = parseImport(createExport(team, catalog, policy), catalog, policy).team;
    assert.equal(imported.members[0].equipment[1].matchlessSacredTreasureLevel, level);
    const changed = selectEquipmentRarity(imported.members[0].equipment[1], 'UR');
    assert.equal(changed.matchlessSacredTreasureLevel, level);
    assert.equal(selectEquipmentRarity(changed, 'SSR').matchlessSacredTreasureLevel, level);
    assert.equal(original.matchlessSacredTreasureLevel, level);
  }
});

test('removing equipment clears magic armor and all investment while allowing a valid export', () => {
  const team = fullTeam();
  const baseline = calculateTeam(team, catalog, policy);
  const empty = team.members[0].equipment[1];
  const selected = selectEquipmentRarity(empty, 'SSR');
  team.members[0].equipment[1] = selected;
  assert.equal(calculateTeam(team, catalog, policy).matchlessExperience, catalog.equipmentCosts.sacredExperience[40]);
  Object.assign(selected, { reinforcementLevel: 10, legendSacredTreasureLevel: 10 });
  selected.runes[0] = { categoryId: 5, level: 10 };
  const removed = selectEquipmentRarity(selected, 'NONE');
  team.members[0].equipment[1] = removed;
  assert.deepEqual(removed, createEquipment(2));
  assert.equal(validateTeam(team, catalog, policy, { requireFullTeam: true }).valid, true);
  const exported = createExport(team, catalog, policy);
  assert.equal(exported.costBreakdown.matchlessExperience, 0);
  assert.deepEqual(exported.costBreakdown.resources, baseline.resources);
  assert.equal(exported.costBreakdown.totalDiamonds, baseline.totalDiamonds);
  assert.equal(parseImport(exported, catalog, policy).team.members[0].equipment[1].matchlessSacredTreasureLevel, 0);
  assert.equal(selectEquipmentRarity(removed, 'SSR').matchlessSacredTreasureLevel, 40);
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

test('two ordinary rune tiers have independent per-category inventory and preserve older level-eleven exports', () => {
  const team = fullTeam();
  const configured = stockPolicy();
  configured.runes.fixedStock = { tiers: [{ level: 11, perCategory: 3 }, { level: 10, perCategory: 3 }], excludedCategoryIds: [5, 9] };
  for (const member of team.members.slice(0, 3)) {
    installStockRune(member, 1, 1, 11);
    installStockRune(member, 1, 2, 10);
  }
  const result = calculateTeam(team, catalog, configured);
  assert.deepEqual(result.fixedRuneInventory.filter(item => item.categoryId === 1).map(item => [item.level, item.used, item.remaining]), [[11, 3, 0], [10, 3, 0]]);
  assert.equal(result.resources.unidentifiedRune7.consumed, 0);
  const oldTeam = fullTeam();
  installStockRune(oldTeam.members[0]);
  const oldExport = createExport(oldTeam, catalog, stockPolicy());
  assert.equal(parseImport(oldExport, catalog, configured).costBreakdown.fixedRuneInventory.find(item => item.categoryId === 1 && item.level === 11).used, 1);
  installStockRune(team.members[3], 1, 1, 11);
  assert.throws(() => calculateTeam(team, catalog, configured), err => err.errors.some(item => item.code === 'FIXED_RUNE_STOCK_EXCEEDED' && item.path.endsWith('.11')));
  team.members[3].equipment[0].runes[0].level = 9;
  assert.equal(validateTeam(team, catalog, configured).errors.some(item => item.code === 'FIXED_RUNE_LEVEL'), true);
});

const freeLibrary = {
  format: 'mementomori-free-library', schemaVersion: 1, id: 'fixture-free-library', version: 1,
  characters: [{ characterId: 1, rarity: 'LR5' }, { characterId: 2, rarity: 'SR' }, { characterId: 4, rarity: 'LR' }],
  exclusiveWeapons: [{ characterId: 1, rarity: 'SSR', level: 240 }, { characterId: 2, rarity: 'SSR', level: 180 }],
};

test('free character caps deduct cumulative copies and only charge investment above each entitlement', () => {
  const team = fullTeam();
  ['SR', 'LR', 'LR5', 'LR5', 'LR'].forEach((rarity, index) => { team.members[index].rarity = rarity; });
  const result = calculateTeam(team, catalog, policy, freeLibrary);
  assert.deepEqual(result.characterCosts.map(item => [item.copies, item.freeCopies, item.chargedCopies]), [[1, 1, 0], [8, 1, 7], [20, 0, 20], [26, 14, 12], [14, 0, 14]]);
  assert.equal(result.grossCharacterDiamonds, 69 * 17000);
  assert.equal(result.freeCharacterDiamonds, 16 * 17000);
  assert.equal(result.characterDiamonds, 53 * 17000);
  assert.equal(result.totalDiamonds, result.characterDiamonds);
  team.members[3].rarity = 'SR';
  assert.equal(calculateTeam(team, catalog, policy, freeLibrary).characterCosts[3].diamonds, 0);
});

test('free SSR exclusive weapon pays only incremental fragments above its baseline, without exempting upgrades', () => {
  const team = createTeam();
  team.members[0] = createMember(2);
  equip(team.members[0], 1, { weaponKind: 'exclusive', level: 200, reinforcementLevel: 1, legendSacredTreasureLevel: 1 });
  const configured = copy(policy);
  configured.allowances.reinforcementMedicine = 0;
  configured.allowances.holySteel = 0;
  const result = calculateTeam(team, catalog, configured, freeLibrary);
  assert.equal(result.resources.exclusiveFragments.consumed, 280);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 240);
  assert.equal(result.resources.exclusiveFragments.charged, 40);
  assert.equal(result.resources.reinforcementMedicine.charged, 1000);
  assert.equal(result.resources.holySteel.charged, 1);
  assert.equal(result.characterDiamonds, 0);
  assert.equal(result.exclusiveWeaponCosts[0].magicCrystals, 84);
  assert.equal(result.exclusiveWeaponCosts[0].freeMagicCrystals, 72);
  assert.equal(result.exclusiveWeaponCosts[0].chargedMagicCrystals, 12);
  assert.equal(result.exclusiveWeaponCosts[0].diamonds, 1842.71);
  assert.equal(result.totalDiamonds, 11942.71);
  team.members[0].equipment[0].level = 180;
  assert.equal(calculateTeam(team, catalog, configured, freeLibrary).resources.exclusiveFragments.charged, 0);
});

test('SSR free weapon credit survives UR and LR evolution but all additional leaf investment remains chargeable', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[0].rarity = 'LR5';
  equip(team.members[0], 1, { rarity: 'LR', seriesId: 14, weaponKind: 'exclusive' });
  const result = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(result.resources.exclusiveFragments.consumed, 600);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 360);
  assert.equal(result.resources.exclusiveFragments.charged, 240);
  assert.equal(result.resources.lifeTreeDew.charged, 65);
  assert.equal(result.exclusiveWeaponCosts[0].chargedMagicCrystals, 72);
  assert.equal(result.totalDiamonds, 37056.24);
  team.members[0].equipment[0] = createEquipment(1);
  equip(team.members[0], 2, { rarity: 'LR', seriesId: 14 });
  const normal = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(normal.resources.urLrFragments.freeLibraryCredit, 0);
  assert.equal(normal.exclusiveWeaponCosts.length, 0);
});

test('free library snapshot is exported while imports recompute using only the current supplied library', () => {
  const team = fullTeam();
  const exported = createExport(team, catalog, policy, freeLibrary);
  assert.deepEqual(exported.freeLibrarySnapshot, freeLibrary);
  exported.freeLibrarySnapshot.characters = catalog.characters.map(character => ({ characterId: character.id, rarity: 'LR5' }));
  exported.costBreakdown.totalDiamonds = 0;
  assert.equal(parseImport(exported, catalog, policy, freeLibrary).costBreakdown.characterDiamonds, 34000);
  assert.equal(parseImport(exported, catalog, policy).costBreakdown.characterDiamonds, 85000);
});

test('itemized exclusive weapon fees apply shared fragment and leaf allowances once after the free-library credit', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[0].rarity = 'LR5';
  equip(team.members[0], 1, { rarity: 'LR', seriesId: 14, weaponKind: 'exclusive' });
  const configured = copy(policy);
  configured.allowances.exclusiveFragments = 50;
  configured.allowances.lifeTreeDew = 10;
  const result = calculateTeam(team, catalog, configured, freeLibrary);
  assert.equal(result.exclusiveWeaponCosts[0].chargedFragments, 190);
  assert.equal(result.exclusiveWeaponCosts[0].chargedMagicCrystals, 57);
  assert.equal(result.exclusiveWeaponCosts[0].chargedLifeTreeDew, 55);
  assert.equal(result.exclusiveWeaponCosts[0].sharedAllowanceFragments, 50);
  assert.equal(result.exclusiveWeaponCosts[0].sharedAllowanceLifeTreeDew, 10);
  assert.equal(result.totalDiamonds, result.exclusiveWeaponCosts[0].diamonds);
});

test('purple-crystal price and fragment unit price must describe the same exclusive-weapon fee', () => {
  const team = fullTeam();
  equip(team.members[0], 1, { weaponKind: 'exclusive', level: 240 });
  const configured = copy(policy);
  configured.conversions = { magicCrystalPrice: 100, magicCrystalsPerExclusiveExchange: 3, exclusiveFragmentsPerExchange: 10 };
  assert.throws(() => calculateTeam(team, catalog, configured), err => err.errors.some(item => item.code === 'INCONSISTENT_EXCLUSIVE_PRICE'));
  configured.unitPrices.exclusiveFragments = 30;
  const result = calculateTeam(team, catalog, configured);
  assert.equal(result.exclusiveWeaponCosts[0].magicCrystals, 108);
  assert.equal(result.exclusiveWeaponCosts[0].magicCrystalUnitPrice, 100);
  assert.equal(result.exclusiveWeaponCosts[0].diamonds, 10800);
});

test('invalid free-library caps, duplicate entries and unavailable weapon baselines fail before valuation', () => {
  for (const change of [
    library => { library.characters[0].rarity = 'UR'; },
    library => { library.characters.push({ characterId: 1, rarity: 'SR' }); },
    library => { library.exclusiveWeapons[0].level = 450; },
    library => { library.characters[0].characterId = 9999; },
    library => { library.schemaVersion = 999; },
  ]) {
    const invalid = copy(freeLibrary);
    change(invalid);
    assert.throws(() => calculateTeam(fullTeam(), catalog, policy, invalid), DomainValidationError);
  }
  const invalidStock = stockPolicy();
  invalidStock.runes.fixedStock.tiers = [{ level: 11, perCategory: 3 }, { level: 11, perCategory: 3 }];
  assert.equal(validateTeam(fullTeam(), catalog, invalidStock).errors.some(item => item.code === 'INVALID_FIXED_RUNE_STOCK'), true);
});

const syncCatalog = () => {
  const configured = copy(catalog);
  for (const rarity of ['UR', 'LR']) {
    configured.equipmentCosts.fragments[`exclusive${rarity}`] = { 240: 360, 300: 400, 350: 500, 400: 550, 450: 600 };
  }
  return configured;
};
const syncLibrary = () => ({
  ...copy(freeLibrary),
  characters: [...copy(freeLibrary.characters), { characterId: 5, rarity: 'LR5' }, { characterId: 6, rarity: 'LR5' }],
  exclusiveWeapons: [...copy(freeLibrary.exclusiveWeapons), { characterId: 5, rarity: 'UR', level: 300 }, { characterId: 6, rarity: 'UR', level: 300 }],
});
const syncedTeam = () => {
  const team = fullTeam();
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 1 });
  return team;
};

test('two free UR300 gifts enable the first synchronization slot without duplicating free equipment cost', () => {
  const team = syncedTeam();
  const result = calculateTeam(team, syncCatalog(), policy, syncLibrary());
  assert.equal(result.weaponSync.slots[0].available, true);
  assert.equal(result.weaponSync.slots[0].effectiveLevel, 300);
  assert.deepEqual(result.weaponSync.slots[0].anchors.map(item => item.characterId), [5, 6]);
  assert.equal(result.weaponSync.slots[1].available, false);
  assert.equal(result.exclusiveWeaponCosts[0].level, 300);
  assert.equal(result.exclusiveWeaponCosts[0].effectiveLevel, 300);
  assert.equal(result.resources.exclusiveFragments.consumed, 400);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 360);
  assert.equal(result.resources.lifeTreeDew.charged, 15);
});

test('paid outside reserves upgrade gifted anchors once and synchronization charges base production rather than effective level', () => {
  const team = syncedTeam();
  equip(team.members[4], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  const configuredCatalog = syncCatalog();
  const library = syncLibrary();
  const result = calculateTeam(team, configuredCatalog, policy, library);
  assert.equal(result.weaponSync.effectiveLevels[0], 450);
  assert.equal(result.exclusiveWeaponCosts[0].syncSavedFragments, 200);
  assert.equal(result.resources.exclusiveFragments.consumed, 1600);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 1160);
  assert.equal(result.resources.exclusiveFragments.charged, 440);
  assert.equal(result.resources.lifeTreeDew.consumed, 45);
  assert.equal(result.resources.lifeTreeDew.freeLibraryCredit, 30);
  assert.equal(result.resources.lifeTreeDew.charged, 15);
  assert.equal(result.weaponSourceCosts.length, 1);
  assert.equal(result.weaponSourceCosts[0].characterDiamonds, 0);
  assert.equal(result.weaponSourceCosts[0].weaponDiamonds, 9213.54);
  assert.equal(result.characterCosts.find(item => item.sourceKind === 'reserve').position, null);
  const directlyCrafted = cloneTeam(team);
  directlyCrafted.members[0].equipment[0].syncSlot = 0;
  directlyCrafted.members[0].equipment[0].level = 450;
  const directCost = calculateTeam(directlyCrafted, configuredCatalog, policy, library);
  assert.equal(Math.round((directCost.totalDiamonds - result.totalDiamonds) * 100) / 100, 9213.54);
});

test('the second synchronization slot requires a third true anchor and uses the lowest of its best three', () => {
  const team = syncedTeam();
  equip(team.members[1], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 2 });
  equip(team.members[4], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  assert.equal(deriveWeaponSync(team, syncCatalog(), policy, syncLibrary()).slots[1].available, false, 'a synchronized output cannot become the third anchor');
  equip(team.members[2], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 400 });
  const result = calculateTeam(team, syncCatalog(), policy, syncLibrary());
  assert.deepEqual(result.weaponSync.effectiveLevels.slice(0, 2), [450, 400]);
  assert.deepEqual(result.weaponSync.slots[0].anchors.map(item => item.characterId), [5, 6]);
  assert.deepEqual(result.weaponSync.slots[1].anchors.map(item => item.characterId), [5, 6, 3]);
  team.members[0].equipment[0].reinforcementLevel = 450;
  team.members[1].equipment[0].reinforcementLevel = 400;
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).valid, true);
  team.members[1].equipment[0].reinforcementLevel = 401;
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).errors.some(item => item.code === 'REINFORCEMENT_EXCEEDS_LEVEL'), true);
});

test('sync targets cannot count their own free gifts and equipped low-level weapons suppress phantom higher gifts', () => {
  const team = syncedTeam();
  equip(team.members[4], 1, { weaponKind: 'exclusive', level: 240 });
  let state = deriveWeaponSync(team, syncCatalog(), policy, syncLibrary());
  assert.deepEqual(state.anchors.map(item => item.characterId), [6]);
  assert.equal(state.slots[0].available, false);
  equip(team.members[4], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 1 });
  state = deriveWeaponSync(team, syncCatalog(), policy, syncLibrary());
  assert.deepEqual(state.anchors.map(item => item.characterId), [6]);
  assert.equal(state.errors.some(item => item.code === 'DUPLICATE_WEAPON_SYNC_SLOT'), true);
  team.members[0].equipment[0].syncSlot = 0;
  team.members[0].equipment[0].rarity = 'NONE';
  team.members[0].equipment[0] = createEquipment(1);
  assert.equal(deriveWeaponSync(team, syncCatalog(), policy, syncLibrary()).slots[0].available, false, 'a target gift is never its own source');
});

test('synchronization rejects low-rarity targets, repeated source characters and base level above the actual source floor', () => {
  const configuredCatalog = syncCatalog();
  const library = syncLibrary();
  const low = syncedTeam();
  Object.assign(low.members[0].equipment[0], { rarity: 'SSR', seriesId: 12, level: 240 });
  assert.equal(validateTeam(low, configuredCatalog, policy, { freeLibrary: library }).errors.some(item => item.code === 'INELIGIBLE_SYNC_WEAPON'), true);
  const aboveFloor = syncedTeam();
  aboveFloor.members[0].equipment[0].level = 350;
  assert.equal(validateTeam(aboveFloor, configuredCatalog, policy, { freeLibrary: library }).errors.some(item => item.code === 'SYNC_LEVEL_BELOW_BASE'), true);
  const duplicates = syncedTeam();
  equip(duplicates.members[4], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300 });
  duplicates.weaponSources = [{ characterId: 5, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  assert.equal(validateTeam(duplicates, configuredCatalog, policy, { freeLibrary: library }).errors.some(item => item.code === 'DUPLICATE_WEAPON_SOURCE'), true);
  duplicates.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'LR', level: 450 }];
  assert.equal(validateTeam(duplicates, configuredCatalog, policy, { freeLibrary: library }).errors.some(item => item.code === 'LR_REQUIRES_LR5'), true);
});

test('export and clone preserve source inventory and sync selection while import discards forged effective levels and fees', () => {
  const team = syncedTeam();
  equip(team.members[4], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  const configuredCatalog = syncCatalog();
  const library = syncLibrary();
  const exported = createExport(team, configuredCatalog, policy, library);
  assert.equal(exported.team.members[0].equipment[0].syncSlot, 1);
  assert.equal(exported.team.weaponSources[0].level, 450);
  exported.costBreakdown.weaponSync.effectiveLevels[0] = 999;
  exported.costBreakdown.totalDiamonds = 0;
  exported.team.members[0].equipment[0].effectiveLevel = 999;
  exported.team.weaponSources[0].diamonds = 0;
  const imported = parseImport(exported, configuredCatalog, policy, library);
  assert.equal(imported.costBreakdown.weaponSync.effectiveLevels[0], 450);
  assert.equal('effectiveLevel' in imported.team.members[0].equipment[0], false);
  assert.equal('diamonds' in imported.team.weaponSources[0], false);
  const cloned = cloneTeam(imported.team);
  cloned.weaponSources[0].level = 300;
  assert.equal(imported.team.weaponSources[0].level, 450);
  const oldExport = createExport(fullTeam(), configuredCatalog, policy, library);
  delete oldExport.team.weaponSources;
  for (const member of oldExport.team.members) for (const gear of member.equipment) delete gear.syncSlot;
  const oldImported = parseImport(oldExport, configuredCatalog, policy, library);
  assert.deepEqual(oldImported.team.weaponSources, []);
  assert.equal(oldImported.team.members[0].equipment[0].syncSlot, 0);
});

test('borrowed free UR weapons price the actor body and weapon owner entitlement without activating own exclusive skills', () => {
  const team = createTeam();
  team.members[0] = createMember(3);
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, weaponOwnerCharacterId: 6 });
  const result = calculateTeam(team, syncCatalog(), policy, syncLibrary());
  assert.equal(result.characterDiamonds, 17000);
  assert.equal(result.resources.exclusiveFragments.charged, 0);
  assert.equal(result.resources.lifeTreeDew.charged, 0);
  assert.equal(result.totalDiamonds, 17000);
  assert.equal(result.exclusiveWeaponCosts[0].characterId, 3);
  assert.equal(result.exclusiveWeaponCosts[0].weaponOwnerCharacterId, 6);
  assert.equal(result.exclusiveWeaponCosts[0].borrowed, true);
  assert.equal(result.exclusiveWeaponCosts[0].ownExclusiveSkillActive, false);
  assert.equal(result.weaponSync.anchors.find(item => item.characterId === 6).source, 'team');
  const exportedTeam = cloneTeam(team);
  assert.equal(exportedTeam.members[0].equipment[0].weaponOwnerCharacterId, 6);
  team.members[0].equipment[0].weaponOwnerCharacterId = 3;
  assert.equal(calculateTeam(team, syncCatalog(), policy, syncLibrary()).exclusiveWeaponCosts[0].ownExclusiveSkillActive, true);
});

test('borrowed weapon restrictions enforce job, UR free inventory and one physical owner across equipped weapons and reserves', () => {
  const team = fullTeam();
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, weaponOwnerCharacterId: 6 });
  equip(team.members[1], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, weaponOwnerCharacterId: 6 });
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).errors.some(item => item.code === 'DUPLICATE_WEAPON_OWNER'), true);
  assert.equal(isWeaponOwnerClaimed(team, 2, 6), true);
  assert.equal(getBorrowableWeapons(team, 2, syncCatalog(), syncLibrary()).length, 0);
  team.members[1].equipment[0] = createEquipment(1);
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).errors.some(item => item.code === 'DUPLICATE_WEAPON_SOURCE'), true);
  team.weaponSources = [];
  team.members[0].equipment[0].weaponOwnerCharacterId = 5;
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).errors.some(item => item.code === 'BORROWED_WEAPON_JOB_MISMATCH'), true);
  team.members[0].equipment[0].weaponOwnerCharacterId = 2;
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).errors.some(item => item.code === 'UNAVAILABLE_BORROWED_WEAPON'), true);
});

test('normal UR/LR weapon slots are unavailable while UR/LR armor and SSR ordinary weapons remain legal', () => {
  const team = createTeam();team.members[0] = createMember(1);team.members[0].rarity = 'LR5';
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13 });
  assert.equal(validateTeam(team, catalog, policy).errors.some(item => item.code === 'UNAVAILABLE_NORMAL_WEAPON'), true);
  equip(team.members[0], 1, { rarity: 'SSR', seriesId: 12 });
  equip(team.members[0], 2, { rarity: 'UR', seriesId: 13 });
  equip(team.members[0], 3, { rarity: 'LR', seriesId: 14 });
  assert.equal(validateTeam(team, catalog, policy).valid, true);
});

test('a selected actor may supply a separate own reserve weapon when wearing borrowed gear without charging its body twice', () => {
  const team = fullTeam();
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, weaponOwnerCharacterId: 6 });
  team.weaponSources = [{ characterId: 1, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  const result = calculateTeam(team, syncCatalog(), policy, syncLibrary());
  assert.equal(result.characterCosts.filter(item => item.characterId === 1).length, 1);
  assert.equal(result.weaponSourceCosts[0].characterDiamonds, 0);
  assert.equal(result.weaponSync.anchors.some(item => item.characterId === 1 && item.source === 'reserve'), true);
  team.members[0].equipment[0].syncSlot = 1;
  const sync = deriveWeaponSync(team, syncCatalog(), policy, syncLibrary());
  assert.equal(sync.anchors.some(item => item.characterId === 6), false, 'borrowed target owner cannot become an anchor');
  assert.equal(sync.slots[0].effectiveLevel, 300);
  team.weaponSources[0].characterRarity = 'LR5';
  team.weaponSources[0].rarity = 'LR';
  assert.equal(validateTeam(team, syncCatalog(), policy, { freeLibrary: syncLibrary() }).errors.some(item => item.code === 'SOURCE_CHARACTER_RARITY_MISMATCH'), true);
});

const autoPolicy = () => ({ ...copy(policy), weaponSync: { mode: 'automatic', targetLevel: 450, billedLevel: 300, discountedOrdinals: [3, 6] } });

test('automatic weapon pricing bills only the third 450 weapon at300 and keeps all actual levels and reinforcement at450', () => {
  const team = fullTeam();
  for (const member of team.members) equip(member, 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450, reinforcementLevel: 450 });
  const result = calculateTeam(team, syncCatalog(), autoPolicy(), syncLibrary());
  assert.equal(result.weaponPricing.qualifyingCount, 5);
  assert.equal(result.weaponPricing.discountCount, 1);
  assert.deepEqual(result.exclusiveWeaponCosts.map(item => item.level), [450, 450, 450, 450, 450]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(item => item.billedLevel), [450, 450, 300, 450, 450]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(item => item.fragments), [600, 600, 400, 600, 600]);
  assert.equal(result.exclusiveWeaponCosts[2].automaticSyncDiscount, true);
  assert.equal(result.exclusiveWeaponCosts[2].levelDiscountFragments, 200);
  assert.equal(result.equipmentCosts[2].resources.reinforcementMedicine, 450000);
  assert.equal(result.resources.lifeTreeDew.consumed, 75);
  assert.equal(result.weaponSync, null);
  assert.deepEqual(result.weaponSourceCosts, []);
  assert.doesNotThrow(() => createExport(team, syncCatalog(), autoPolicy(), syncLibrary()));
});

test('automatic weapon ordinals count unique equipped450UR/LR exclusives only and keep the sixth ordinal for future use', () => {
  const team = fullTeam();
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  equip(team.members[1], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300 });
  equip(team.members[2], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  equip(team.members[3], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  equip(team.members[4], 1, { rarity: 'SSR', seriesId: 12, level: 450 });
  const result = calculateTeam(team, syncCatalog(), autoPolicy(), syncLibrary());
  assert.deepEqual(result.exclusiveWeaponCosts.map(item => item.discountOrdinal), [1, null, 2, 3]);
  assert.equal(result.exclusiveWeaponCosts[3].billedLevel, 300);
  const noHighTeam = createTeam();
  assert.equal(deriveWeaponPricing(noHighTeam, syncCatalog(), autoPolicy(), syncLibrary()).qualifyingCount, 0, 'free outside UR300 gifts cannot masquerade as450 weapons');
  const future = { ...team, members: catalog.characters.map(createMember) };
  for (const member of future.members) equip(member, 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  assert.deepEqual(deriveWeaponPricing(future, syncCatalog(), autoPolicy()).weapons.filter(item => item.discounted).map(item => item.ordinal), [3, 6]);
  assert.equal(validateTeam(future, syncCatalog(), autoPolicy()).errors.some(item => item.code === 'INVALID_TEAM_SIZE'), true, 'six-person public teams remain unsupported');
});

test('automatic LR weapon discount never exempts its rarity evolution leaves or activates borrowed own effects', () => {
  const team = fullTeam();
  for (const member of team.members.slice(0, 2)) equip(member, 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  team.members[2].rarity = 'LR5';
  equip(team.members[2], 1, { rarity: 'LR', seriesId: 14, weaponKind: 'exclusive', level: 450, weaponOwnerCharacterId: 6 });
  const result = calculateTeam(team, syncCatalog(), autoPolicy(), syncLibrary());
  const third = result.exclusiveWeaponCosts[2];
  assert.equal(third.level, 450);
  assert.equal(third.billedLevel, 300);
  assert.equal(third.lifeTreeDew, 65);
  assert.equal(third.freeLifeTreeDew, 15);
  assert.equal(third.chargedLifeTreeDew, 50);
  assert.equal(third.ownExclusiveSkillActive, false);
  assert.equal(third.freeFragments, 400);
});

test('automatic mode rejects hidden legacy sources or sync settings rather than charging invisible configuration', () => {
  const team = fullTeam();
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  assert.throws(() => calculateTeam(team, syncCatalog(), autoPolicy(), syncLibrary()), err => err.errors.some(item => item.code === 'LEGACY_WEAPON_CONFIG_REQUIRES_MIGRATION'));
  team.weaponSources = [];
  equip(team.members[0], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 1 });
  assert.throws(() => createExport(team, syncCatalog(), autoPolicy(), syncLibrary()), err => err.errors.some(item => item.code === 'LEGACY_WEAPON_CONFIG_REQUIRES_MIGRATION'));
});

test('legacy migration preserves verified actual450 and removes outside fees without trusting forged snapshot or quote levels', () => {
  const team = syncedTeam();
  equip(team.members[4], 1, { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 450 });
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  team.members[0].equipment[0].reinforcementLevel = 450;
  const exported = createExport(team, syncCatalog(), policy, syncLibrary());
  exported.costBreakdown.weaponSync.effectiveLevels[0] = 999;
  exported.policySnapshot.unitPrices.characterCopy = 0;
  const imported = parseImport(exported, syncCatalog(), autoPolicy(), syncLibrary());
  assert.equal(imported.team.members[0].equipment[0].level, 450);
  assert.equal(imported.team.members[0].equipment[0].reinforcementLevel, 450);
  assert.equal(imported.team.members[0].equipment[0].syncSlot, 0);
  assert.deepEqual(imported.team.weaponSources, []);
  assert.deepEqual(imported.costBreakdown.weaponSourceCosts, []);
  assert.equal(imported.costBreakdown.weaponPricing.qualifyingCount, 2);
  assert.equal(imported.warnings.some(message => /旧同步.*实际等级|旧同步武器/.test(message)), true);
  assert.equal(exported.team.members[0].equipment[0].level, 300, 'migration never mutates the original saved plan');
  const lower = syncedTeam();
  const forged = createExport(lower, syncCatalog(), policy, syncLibrary());
  forged.costBreakdown.weaponSync.effectiveLevels[0] = 450;
  assert.equal(parseImport(forged, syncCatalog(), autoPolicy(), syncLibrary()).team.members[0].equipment[0].level, 300);
});

test('unsafe legacy synchronization is rejected while source-only migration removes invisible inventory with a warning', () => {
  const team = syncedTeam();
  equip(team.members[4], 1, { weaponKind: 'exclusive', level: 240 });
  const before = JSON.stringify(team);
  assert.throws(() => migrateLegacyWeaponConfiguration(team, syncCatalog(), autoPolicy(), syncLibrary()), err => err.errors.some(item => item.code === 'INSUFFICIENT_SYNC_ANCHORS' && /保留备份/.test(item.message)));
  assert.equal(JSON.stringify(team), before);
  team.members[0].equipment[0] = createEquipment(1);
  team.members[4].equipment[0] = createEquipment(1);
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 450 }];
  const migrated = migrateLegacyWeaponConfiguration(team, syncCatalog(), autoPolicy(), syncLibrary());
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.team.weaponSources, []);
  assert.equal(calculateTeam(migrated.team, syncCatalog(), autoPolicy(), syncLibrary()).resources.exclusiveFragments.consumed, 0);
  assert.match(migrated.warnings[0], /不再收取隐藏库存费用/);
});

const forgeBlessing = { id: 'forge-grace', name: '恩泽·锻造', effect: 'freeEquipmentCrafting', rarity: 'SSR', weaponKind: 'normal', resource: 'ssrFragments' };
const forgingPolicy = () => ({ ...copy(policy), blessings: [copy(forgeBlessing)] });

test('ordinary SSR crafting blessing preserves material investment and unit prices while charging no crafting diamonds', () => {
  const team = fullTeam();
  for (const slot of [1, 2, 3, 4, 5, 6]) equip(team.members[0], slot);
  const configured = forgingPolicy();
  configured.allowances.ssrFragments = 100;
  const cost = calculateTeam(team, catalog, configured);
  const resource = cost.resources.ssrFragments;
  assert.equal(resource.consumed, 300);
  assert.equal(resource.unitPrice, policy.unitPrices.ssrFragments);
  assert.equal(resource.freeLibraryCredit, 0);
  assert.equal(resource.craftingBlessingCredit, 300);
  assert.equal(resource.craftingBlessingDiamonds, 13274.12);
  assert.equal(resource.freeAllowance, 100);
  assert.equal(resource.blessingAllowance, 0);
  assert.equal(resource.charged, 0);
  assert.equal(resource.diamonds, 0);
  assert.equal(cost.resourceDiamonds, 0);
  for (const gear of cost.equipmentCosts) {
    assert.equal(gear.resources.ssrFragments, 50);
    assert.equal(gear.blessingCredits.ssrFragments, 50);
    assert.equal(gear.craftingBlessingId, 'forge-grace');
    assert.equal(gear.sharedAllowanceCredits.ssrFragments, 0);
    assert.equal(gear.chargedResources.ssrFragments, 0);
  }
  assert.equal(getResourceAllowance(configured, 'ssrFragments'), 100);
  assert.equal(getResourceAllowance(configured, 'reinforcementMedicine'), 100000);
});

test('SSR crafting blessing does not exempt reinforcement, runes, sacred treasure or magic armor investment', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  const gear = equip(team.members[0], 1, { reinforcementLevel: 1, legendSacredTreasureLevel: 1, matchlessSacredTreasureLevel: 40 });
  gear.runes[0] = { categoryId: 5, level: 1 };
  const configured = forgingPolicy();
  configured.allowances = { runeTickets: 0, reinforcementMedicine: 0, holySteel: 0 };
  const cost = calculateTeam(team, catalog, configured);
  assert.equal(cost.resourceDiamonds, 10120);
  assert.equal(cost.resources.reinforcementMedicine.diamonds, 10000);
  assert.equal(cost.resources.runeTickets.diamonds, 20);
  assert.equal(cost.resources.holySteel.diamonds, 100);
  assert.equal(cost.matchlessExperience, catalog.equipmentCosts.sacredExperience[40]);
  for (const key of ['reinforcementMedicine', 'runeTickets', 'holySteel']) assert.equal(cost.resources[key].craftingBlessingCredit, 0);
});

test('SSR exclusive and UR LR crafting remain priced with only their original free weapon baseline credit', () => {
  for (const rarity of ['SSR', 'UR', 'LR']) {
    const team = createTeam();
    team.members[0] = createMember(2);
    if (rarity === 'LR') team.members[0].rarity = 'LR5';
    equip(team.members[0], 1, { rarity, seriesId: { SSR: 12, UR: 13, LR: 14 }[rarity], weaponKind: 'exclusive', level: rarity === 'SSR' ? 240 : 450 });
    const original = calculateTeam(team, catalog, policy, freeLibrary);
    const blessed = calculateTeam(team, catalog, forgingPolicy(), freeLibrary);
    assert.equal(blessed.totalDiamonds, original.totalDiamonds);
    assert.equal(blessed.resources.exclusiveFragments.freeLibraryCredit, 240);
    assert.equal(blessed.resources.exclusiveFragments.craftingBlessingCredit, 0);
    assert.equal(blessed.exclusiveWeaponCosts[0].chargedFragments, rarity === 'SSR' ? 120 : 360);
    assert.equal(blessed.exclusiveWeaponCosts[0].chargedLifeTreeDew, { SSR: 0, UR: 15, LR: 65 }[rarity]);
    assert.equal(blessed.equipmentCosts[0].craftingBlessingId, null);
  }
  for (const rarity of ['UR', 'LR']) {
    const team = createTeam();
    team.members[0] = createMember(1);
    if (rarity === 'LR') team.members[0].rarity = 'LR5';
    equip(team.members[0], 2, { rarity, seriesId: rarity === 'UR' ? 13 : 14 });
    const blessed = calculateTeam(team, catalog, forgingPolicy());
    assert.equal(blessed.resources.urLrFragments.craftingBlessingCredit, 0);
    assert.equal(blessed.resources.urLrFragments.charged, 200);
    assert.equal(blessed.totalDiamonds, calculateTeam(team, catalog, policy).totalDiamonds);
  }
});

test('exports distinguish crafting blessing credits and imports reprice with current crafting rules only', () => {
  const team = fullTeam();
  equip(team.members[0], 2);
  const paid = createExport(team, catalog, policy);
  paid.costBreakdown.totalDiamonds = 999999;
  const current = parseImport(paid, catalog, forgingPolicy());
  assert.equal(current.costBreakdown.resources.ssrFragments.charged, 0);
  assert.equal(current.costBreakdown.resources.ssrFragments.craftingBlessingCredit, 50);
  assert.equal(current.team.members[0].equipment[1].rarity, 'SSR');
  const free = createExport(team, catalog, forgingPolicy());
  assert.equal(free.policySnapshot.blessings[0].effect, 'freeEquipmentCrafting');
  assert.equal(free.costBreakdown.equipmentCosts[0].blessingCredits.ssrFragments, 50);
  free.policySnapshot.unitPrices.ssrFragments = 0;
  free.costBreakdown.resources.ssrFragments.diamonds = 0;
  const olderRules = parseImport(free, catalog, policy);
  assert.equal(olderRules.costBreakdown.resources.ssrFragments.craftingBlessingCredit, 0);
  assert.equal(olderRules.costBreakdown.resources.ssrFragments.charged, 50);
  assert.equal(olderRules.costBreakdown.resources.ssrFragments.diamonds, 2212.35);
});

test('crafting blessing scope and effect are validated while old and explicit resource allowance blessings remain compatible', () => {
  const invalid = [
    { ...forgeBlessing, effect: 'freeEverything' }, { ...forgeBlessing, rarity: 'UR' },
    { ...forgeBlessing, weaponKind: 'exclusive' }, { ...forgeBlessing, resource: 'exclusiveFragments' },
    { ...forgeBlessing, amount: 0 },
  ];
  for (const blessing of invalid) {
    const configured = { ...copy(policy), blessings: [blessing] };
    assert.equal(validateTeam(createTeam(), catalog, configured).valid, false);
    assert.throws(() => getResourceAllowance(configured, 'ssrFragments'), DomainValidationError);
  }
  const duplicate = forgingPolicy();
  duplicate.blessings.push({ ...forgeBlessing, id: 'second-forge' });
  assert.equal(validateTeam(createTeam(), catalog, duplicate).valid, false);
  const explicit = forgingPolicy();
  explicit.allowances.reinforcementMedicine = 60000;
  explicit.blessings.push({ id: 'red-grace', name: '红水恩泽', effect: 'resourceAllowance', resource: 'reinforcementMedicine', amount: 40000 });
  assert.equal(getResourceAllowance(explicit, 'reinforcementMedicine'), 100000);
  delete explicit.blessings[1].effect;
  assert.equal(getResourceAllowance(explicit, 'reinforcementMedicine'), 100000);
});
