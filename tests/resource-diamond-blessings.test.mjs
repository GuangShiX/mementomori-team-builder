import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeam, createMember, createEquipment, calculateTeam, validateTeam, cloneTeam,
  createExport, parseImport, getResourceAllowance, getResourceDiamondAllowance, DomainValidationError,
} from '../src/domain.mjs';

const catalog = {
  characters: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, name: `角色${index + 1}`, element: 'blue', job: 1 })),
  runeCategories: [{ id: 5, name: '穿透', allowedSlots: [1, 2, 3] }, { id: 9, name: '速度', allowedSlots: [1, 2, 3] }],
  equipmentCosts: {
    fragments: { SSR: { 450: 50 }, UR: { 450: 200 }, LR: { 450: 200 }, exclusiveSSR: { 180: 80, 240: 360 }, exclusiveUR: { 300: 400, 450: 600 }, exclusiveLR: { 300: 400, 450: 600 } },
    allowedLevels: { SSR: [450], UR: [450], LR: [450] },
    reinforcement: { weapon: Array(451).fill(0), other: Array(451).fill(0) }, sacredExperience: Array(41).fill(0),
  },
};
const policy = {
  version: 8, characterLevel: 450, unitPrices: { characterCopy: 12000, ssrFragments: 4, urLrFragments: 10, exclusiveFragments: 100, lifeTreeDew: 400 },
  copies: { SR: { normal: 1, lightDark: 1 }, LR: { normal: 8, lightDark: 14 }, LR5: { normal: 20, lightDark: 26 } },
  equipment: { urLifeTreeDew: 0, lrLifeTreeDew: 50, exclusiveUrLifeTreeDew: 15, exclusiveLrLifeTreeDew: 65 }, holySteelPerExperience: 1,
  allowances: { reinforcementMedicine: 0 }, blessings: [
    { id: 'red', name: '红水赐福', resource: 'reinforcementMedicine', amount: 88888 },
    { id: 'forge', name: '制作赐福', effect: 'freeEquipmentCrafting', rarity: 'SSR', weaponKind: 'normal', resource: 'ssrFragments' },
    { id: 'dew', name: '叶子赐福', effect: 'resourceDiamondAllowance', resource: 'lifeTreeDew', amount: 60000 },
    { id: 'crystal', name: '紫晶赐福', effect: 'resourceDiamondAllowance', resource: 'exclusiveFragments', amount: 80000 },
  ],
};
const library = { format: 'mementomori-free-library', schemaVersion: 1, version: 1, characters: [], exclusiveWeapons: [] };
const copy = value => JSON.parse(JSON.stringify(value));
const fullTeam = () => ({ ...createTeam(), members: catalog.characters.map(createMember) });
const equip = (team, index, slot, rarity, overrides = {}) => {
  const gear = { ...createEquipment(slot), rarity, seriesId: { SSR: 12, UR: 13, LR: 14 }[rarity], ...overrides };
  team.members[index].equipment[slot - 1] = gear;
  if (rarity === 'LR') team.members[index].rarity = 'LR5';
  return gear;
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
const baselinePolicy = () => {
  const configured = copy(policy);
  configured.blessings = configured.blessings.map(row => row.id === 'crystal'
    ? { id: 'crystal', name: '紫晶基线赐福', effect: 'freeExclusiveFragmentBaseline', resource: 'exclusiveFragments', rarity: 'UR', level: 240 } : row);
  return configured;
};
const baselineCatalog = () => {
  const configured = copy(catalog);
  configured.equipmentCosts.fragments.exclusiveUR[240] = 360;
  return configured;
};

test('SSR exclusives consume finite purple budget while ordinary SSR crafting and free library credits never consume it twice', () => {
  const team = fullTeam();
  equip(team, 0, 1, 'SSR', { weaponKind: 'exclusive', level: 180 });
  equip(team, 0, 2, 'SSR');
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.resources.ssrFragments.craftingBlessingCredit, 50);
  assert.equal(result.resources.ssrFragments.diamondAllowanceCredit, 0);
  assert.equal(result.resources.exclusiveFragments.chargedBeforeDiamondAllowance, 80);
  assert.equal(result.resources.exclusiveFragments.diamondAllowanceCredit, 8000);
  assert.equal(result.resources.exclusiveFragments.remainingDiamondAllowance, 72000);
  assert.equal(result.exclusiveWeaponCosts[0].chargedFragmentDiamonds, 0);
  const granted = { ...library, exclusiveWeapons: [{ characterId: 1, rarity: 'SSR', level: 180 }] };
  const credited = calculateTeam(team, catalog, policy, granted);
  assert.equal(credited.resources.exclusiveFragments.freeLibraryCredit, 80);
  assert.equal(credited.resources.exclusiveFragments.diamondAllowanceCredit, 0);
  assert.equal(credited.resources.exclusiveFragments.remainingDiamondAllowance, 80000);
});

test('leaf and purple budgets are shared once across weapons and itemized net fees equal the resource totals', () => {
  const team = fullTeam();
  for (let index = 0; index < 3; index++) equip(team, index, 1, 'LR', { weaponKind: 'exclusive' });
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.resources.exclusiveFragments.diamonds, 100000);
  assert.equal(result.resources.lifeTreeDew.diamonds, 18000);
  assert.equal(result.resourceDiamonds, 118000);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.diamondAllowanceFragments), [60000, 20000, 0]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.diamondAllowanceLifeTreeDew), [26000, 26000, 8000]);
  for (const key of ['exclusiveFragments', 'lifeTreeDew']) {
    close(result.equipmentCosts.reduce((sum, row) => sum + (row.chargedResourceDiamonds[key] ?? 0), 0), result.resources[key].diamonds);
    close(result.exclusiveWeaponCosts.reduce((sum, row) => sum + row.chargedResourceDiamonds[key], 0), result.resources[key].diamonds);
    close(result.exclusiveWeaponCosts.reduce((sum, row) => sum + row.diamondAllowanceCredits[key], 0), result.resources[key].diamondAllowanceCredit);
  }
  assert.equal(result.exclusiveWeaponCosts[2].chargedLifeTreeDew, 45);
  assert.equal(getResourceAllowance(policy, 'lifeTreeDew'), 0);
  assert.equal(getResourceDiamondAllowance(policy, 'lifeTreeDew'), 60000);
  assert.equal(getResourceAllowance(policy, 'reinforcementMedicine'), 88888);
});

test('automatic450 to300 crafting, free library and quantity allowances all apply before any diamond budget', () => {
  const team = fullTeam();
  for (let index = 0; index < 3; index++) equip(team, index, 1, 'UR', { weaponKind: 'exclusive' });
  const configured = copy(policy);
  configured.weaponSync = { mode: 'automatic', targetLevel: 450, billedLevel: 300, discountedOrdinals: [3, 6] };
  configured.allowances.exclusiveFragments = 60;
  configured.blessings.find(row => row.id === 'crystal').amount = 10000;
  const granted = { ...library, exclusiveWeapons: [{ characterId: 1, rarity: 'SSR', level: 240 }, { characterId: 2, rarity: 'SSR', level: 180 }, { characterId: 3, rarity: 'UR', level: 300 }] };
  const result = calculateTeam(team, catalog, configured, granted);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.billedLevel), [450, 450, 300]);
  assert.equal(result.resources.exclusiveFragments.consumed, 1600);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 840);
  assert.equal(result.resources.exclusiveFragments.chargedBeforeDiamondAllowance, 700);
  assert.equal(result.resources.exclusiveFragments.diamondAllowanceCredit, 10000);
  assert.equal(result.resources.exclusiveFragments.charged, 600);
  assert.equal(result.resources.exclusiveFragments.diamonds, 60000);
  assert.equal(result.exclusiveWeaponCosts[2].level, 450);
  assert.equal(result.exclusiveWeaponCosts[2].diamondAllowanceFragments, 0);
  assert.equal(result.exclusiveWeaponCosts[2].chargedFragments, 0);
});

test('leftover leaf diamonds do not pay for fragments and UR LR armor fragments never use the purple pool', () => {
  const team = fullTeam();
  equip(team, 0, 1, 'UR', { weaponKind: 'exclusive' });
  equip(team, 0, 2, 'LR');
  const configured = copy(policy);
  configured.blessings.find(row => row.id === 'crystal').amount = 1000;
  const result = calculateTeam(team, catalog, configured, library);
  assert.equal(result.resources.exclusiveFragments.diamonds, 59000);
  assert.equal(result.resources.lifeTreeDew.remainingDiamondAllowance, 34000);
  assert.equal(result.resources.urLrFragments.diamondAllowance, 0);
  assert.equal(result.resources.urLrFragments.diamondAllowanceCredit, 0);
  assert.equal(result.resources.urLrFragments.diamonds, 2000);
});

test('changing an LR exclusive back to UR recomputes and releases the leaf budget without changing policy amounts', () => {
  const team = fullTeam();
  for (let index = 0; index < 3; index++) equip(team, index, 1, 'LR', { weaponKind: 'exclusive' });
  const original = cloneTeam(team);
  assert.equal(calculateTeam(team, catalog, policy, library).resources.lifeTreeDew.diamonds, 18000);
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13 });
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.resources.lifeTreeDew.diamondAllowanceCredit, 58000);
  assert.equal(result.resources.lifeTreeDew.remainingDiamondAllowance, 2000);
  assert.equal(result.resources.lifeTreeDew.diamonds, 0);
  assert.equal(policy.blessings.find(row => row.id === 'dew').amount, 60000);
  assert.equal(calculateTeam(original, catalog, policy, library).resources.lifeTreeDew.diamonds, 18000);
});

test('the last cash credit produces fractional equivalent quantities without rounding exchange batches or double charging crystals', () => {
  const team = fullTeam();
  equip(team, 0, 1, 'SSR', { weaponKind: 'exclusive', level: 180 });
  const configured = copy(policy);
  configured.blessings.find(row => row.id === 'crystal').amount = 0.5;
  configured.unitPrices.exclusiveFragments = 46.0676829268293;
  const result = calculateTeam(team, catalog, configured, library);
  const weapon = result.exclusiveWeaponCosts[0];
  assert.ok(weapon.chargedFragments > 79 && weapon.chargedFragments < 80);
  close(weapon.chargedFragments * configured.unitPrices.exclusiveFragments, 80 * configured.unitPrices.exclusiveFragments - 0.5);
  close(weapon.chargedMagicCrystals * weapon.magicCrystalUnitPrice, weapon.chargedResourceDiamonds.exclusiveFragments);
  assert.equal(weapon.diamondAllowanceFragments, 0.5);
  assert.equal(result.resources.exclusiveFragments.remainingDiamondAllowance, 0);
  const exported = createExport(team, catalog, configured, library);
  exported.costBreakdown.totalDiamonds = 0;
  exported.policySnapshot.blessings.find(row => row.id === 'crystal').amount = 999999;
  assert.equal(parseImport(exported, catalog, configured, library).costBreakdown.resourceDiamonds, result.resourceDiamonds);
});

test('zero material unit prices preserve quantity information and leave diamond budgets unused without dividing by zero', () => {
  const team = fullTeam();
  equip(team, 0, 1, 'LR', { weaponKind: 'exclusive' });
  const configured = copy(policy);
  configured.unitPrices.exclusiveFragments = 0;
  configured.unitPrices.lifeTreeDew = 0;
  const result = calculateTeam(team, catalog, configured, library);
  assert.equal(result.resources.exclusiveFragments.charged, 600);
  assert.equal(result.resources.exclusiveFragments.remainingDiamondAllowance, 80000);
  assert.equal(result.resources.lifeTreeDew.charged, 65);
  assert.equal(result.resources.lifeTreeDew.remainingDiamondAllowance, 60000);
  assert.equal(result.resourceDiamonds, 0);
  assert.ok(Number.isFinite(result.exclusiveWeaponCosts[0].chargedFragments));
});

test('diamond blessings reject unknown resource pools, malformed amounts, duplicate IDs and overflow while old policies retain their fees', () => {
  for (const patch of [{ resource: 'urLrFragments' }, { resource: 'magicCrystals' }, { amount: -1 }, { amount: Infinity }, { amount: '80000' }, { amount: null }]) {
    const configured = copy(policy);
    Object.assign(configured.blessings.find(row => row.id === 'crystal'), patch);
    assert.equal(validateTeam(fullTeam(), catalog, configured, { freeLibrary: library }).valid, false);
    assert.throws(() => getResourceDiamondAllowance(configured, 'exclusiveFragments'), DomainValidationError);
  }
  const duplicate = copy(policy);
  duplicate.blessings.find(row => row.id === 'crystal').id = 'dew';
  assert.equal(validateTeam(fullTeam(), catalog, duplicate).valid, false);
  const overflow = copy(policy);
  overflow.blessings.find(row => row.id === 'crystal').amount = 1e308;
  overflow.blessings.push({ id: 'overflow', name: '溢出', effect: 'resourceDiamondAllowance', resource: 'exclusiveFragments', amount: 1e308 });
  assert.equal(validateTeam(fullTeam(), catalog, overflow).valid, false);
  const older = copy(policy);
  older.blessings = older.blessings.filter(row => row.effect !== 'resourceDiamondAllowance');
  const team = fullTeam();
  equip(team, 0, 1, 'SSR', { weaponKind: 'exclusive', level: 180 });
  assert.equal(calculateTeam(team, catalog, older, library).resourceDiamonds, 8000);
  assert.equal(getResourceDiamondAllowance(older, 'exclusiveFragments'), 0);
});

test('each exclusive gets its own UR240 baseline after automatic fabrication rather than drawing from a shared crystal cash pool', () => {
  const team = fullTeam();
  for (let index = 0; index < 3; index++) equip(team, index, 1, 'UR', { weaponKind: 'exclusive' });
  const configured = baselinePolicy();
  configured.weaponSync = { mode: 'automatic', targetLevel: 450, billedLevel: 300, discountedOrdinals: [3, 6] };
  const result = calculateTeam(team, baselineCatalog(), configured, library);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.fragments), [600, 600, 400]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.blessingFragments), [360, 360, 360]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.chargedFragments), [240, 240, 40]);
  assert.equal(result.resources.exclusiveFragments.consumed, 1600);
  assert.equal(result.resources.exclusiveFragments.baselineBlessingCredit, 1080);
  assert.equal(result.resources.exclusiveFragments.charged, 520);
  assert.equal(result.resources.exclusiveFragments.diamondAllowance, 0);
  assert.equal(result.resources.exclusiveFragments.diamonds, 52000);
  assert.equal(getResourceDiamondAllowance(configured, 'exclusiveFragments'), 0);
  assert.equal(result.resources.lifeTreeDew.diamondAllowance, 60000);
  assert.equal(result.resources.lifeTreeDew.diamondAllowanceCredit, 18000);
  assert.equal(result.resources.lifeTreeDew.remainingDiamondAllowance, 42000);
  assert.equal(result.exclusiveWeaponCosts[2].level, 450);
  assert.equal(result.exclusiveWeaponCosts[2].billedLevel, 300);
});

test('exclusive fragment baseline and library use the larger entitlement once, cap at actual investment and never cover ordinary crafting', () => {
  const team = fullTeam();
  equip(team, 0, 1, 'UR', { weaponKind: 'exclusive' });
  equip(team, 1, 1, 'UR', { weaponKind: 'exclusive' });
  equip(team, 2, 1, 'SSR', { weaponKind: 'exclusive', level: 180 });
  equip(team, 3, 2, 'UR');
  const granted = { ...library, exclusiveWeapons: [{ characterId: 1, rarity: 'UR', level: 300 }, { characterId: 2, rarity: 'SSR', level: 180 }] };
  const result = calculateTeam(team, baselineCatalog(), baselinePolicy(), granted);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.freeFragments), [400, 80, 0]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.blessingFragments), [0, 280, 80]);
  assert.deepEqual(result.exclusiveWeaponCosts.map(row => row.chargedFragments), [200, 240, 0]);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 480);
  assert.equal(result.resources.exclusiveFragments.baselineBlessingCredit, 360);
  assert.equal(result.resources.exclusiveFragments.consumed, 1280);
  assert.equal(result.resources.exclusiveFragments.charged, 440);
  assert.equal(result.resources.urLrFragments.charged, 200);
  assert.equal(result.resources.urLrFragments.baselineBlessingCredit, 0);
  const ordinary = result.equipmentCosts.find(row => row.position === 4);
  assert.equal(ordinary.equivalentArtifactMaterials, 8);
  assert.equal(ordinary.chargedEquivalentArtifactMaterials, 8);
  assert.equal(ordinary.craftingDiamonds, 2000);
  assert.equal(result.equipmentCosts.find(row => row.position === 1).equivalentArtifactMaterials, null);
});

test('per-weapon crystal baseline does not exempt leaves, reinforcement, rune or sacred investment and member totals use every net resource once', () => {
  const team = fullTeam();
  const gear = equip(team, 0, 1, 'UR', { weaponKind: 'exclusive', reinforcementLevel: 100, legendSacredTreasureLevel: 40 });
  gear.runes[0] = { categoryId: 5, level: 15 };
  const configured = baselinePolicy();
  configured.unitPrices.reinforcementMedicine = 10;
  configured.unitPrices.runeTickets = 10;
  configured.unitPrices.holySteel = 100;
  configured.blessings = configured.blessings.filter(row => row.id !== 'dew');
  const costs = baselineCatalog();
  costs.equipmentCosts.reinforcement.weapon[100] = 90000;
  costs.equipmentCosts.sacredExperience[40] = 4000;
  const result = calculateTeam(team, costs, configured, library);
  assert.equal(result.resources.exclusiveFragments.charged, 240);
  assert.equal(result.resources.lifeTreeDew.charged, 15);
  assert.equal(result.resources.lifeTreeDew.diamonds, 6000);
  assert.equal(result.resources.reinforcementMedicine.diamonds, 11120);
  assert.equal(result.resources.runeTickets.diamonds, 327680);
  assert.equal(result.resources.holySteel.diamonds, 400000);
  assert.equal(result.memberCosts[0].equipmentDiamonds, 768800);
  assert.equal(result.memberCosts[0].characterDiamonds, 12000);
  assert.equal(result.memberCosts[0].totalDiamonds, 780800);
  assert.equal(result.offTeamDiamonds, 0);
  assert.equal(result.memberCosts.reduce((sum, row) => sum + row.rawTotalDiamonds, 0), result.totalDiamonds);
  assert.equal(result.equipmentCosts[0].craftingDiamonds, 24000);
  assert.equal(result.equipmentCosts[0].diamonds, result.memberCosts[0].equipmentDiamonds);
});

test('member net costs follow shared allowances and leaf cash allocation without counting weapon rows twice', () => {
  const team = fullTeam();
  for (let index = 0; index < 3; index++) equip(team, index, 1, 'LR', { weaponKind: 'exclusive' });
  const result = calculateTeam(team, baselineCatalog(), baselinePolicy(), library);
  assert.deepEqual(result.memberCosts.slice(0, 3).map(row => row.equipmentDiamonds), [24000, 24000, 42000]);
  assert.equal(result.resourceDiamonds, 90000);
  for (const member of result.memberCosts) {
    const items = result.equipmentCosts.filter(row => row.position === member.position);
    close(member.rawEquipmentDiamonds, items.reduce((sum, row) => sum + Object.values(row.chargedResourceDiamonds).reduce((subtotal, amount) => subtotal + amount, 0), 0));
  }
  close(result.memberCosts.reduce((sum, row) => sum + row.rawEquipmentDiamonds, 0), result.resourceDiamonds);
  close(result.memberCosts.reduce((sum, row) => sum + row.rawTotalDiamonds, 0) + result.rawOffTeamDiamonds, result.totalDiamonds);
});

test('old shared-crystal quotes import using current per-weapon baselines and ignore forged member totals', () => {
  const team = fullTeam();
  equip(team, 0, 1, 'UR', { weaponKind: 'exclusive' });
  const old = createExport(team, baselineCatalog(), policy, library);
  assert.equal(old.costBreakdown.resources.exclusiveFragments.diamonds, 0);
  old.costBreakdown.memberCosts[0].totalDiamonds = 0;
  const imported = parseImport(old, baselineCatalog(), baselinePolicy(), library);
  assert.equal(imported.costBreakdown.resources.exclusiveFragments.diamonds, 24000);
  assert.equal(imported.costBreakdown.resources.exclusiveFragments.diamondAllowance, 0);
  assert.equal(imported.costBreakdown.memberCosts[0].equipmentDiamonds, 24000);
  assert.equal(imported.costBreakdown.memberCosts[0].totalDiamonds, 36000);
  assert.equal(old.policySnapshot.blessings.find(row => row.id === 'crystal').amount, 80000);
  const current = createExport(imported.team, baselineCatalog(), baselinePolicy(), library);
  assert.equal(current.policySnapshot.blessings.find(row => row.id === 'crystal').effect, 'freeExclusiveFragmentBaseline');
  assert.deepEqual(imported.team, old.team);
});

test('exclusive baseline requires one valid current UR fragment table level and malformed or duplicate entitlements fail', () => {
  for (const patch of [{ resource: 'lifeTreeDew' }, { rarity: 'SSR' }, { level: 241 }, { level: -1 }, { level: 240.5 }, { amount: 80000 }]) {
    const configured = baselinePolicy();
    Object.assign(configured.blessings.find(row => row.id === 'crystal'), patch);
    assert.equal(validateTeam(createTeam(), baselineCatalog(), configured, { freeLibrary: library }).valid, false);
  }
  const missing = baselineCatalog();
  delete missing.equipmentCosts.fragments.exclusiveUR[240];
  assert.equal(validateTeam(createTeam(), missing, baselinePolicy()).valid, false);
  const duplicate = baselinePolicy();
  duplicate.blessings.push({ ...duplicate.blessings.find(row => row.id === 'crystal'), id: 'second-baseline', level: 300 });
  assert.throws(() => calculateTeam(fullTeam(), baselineCatalog(), duplicate, library), DomainValidationError);
  const zero = baselinePolicy();
  zero.unitPrices.exclusiveFragments = 0;
  const team = fullTeam();
  equip(team, 0, 1, 'UR', { weaponKind: 'exclusive' });
  const result = calculateTeam(team, baselineCatalog(), zero, library);
  assert.equal(result.resources.exclusiveFragments.baselineBlessingCredit, 360);
  assert.equal(result.resources.exclusiveFragments.charged, 240);
  assert.equal(result.resources.exclusiveFragments.diamonds, 0);
  assert.ok(Number.isFinite(result.memberCosts[0].totalDiamonds));
});

test('ordinary high-rarity crafting reports fractional artifact equivalents with its net fragment fee and rejects zero exchange denominators', () => {
  const team = fullTeam();
  equip(team, 0, 2, 'UR');
  const costs = baselineCatalog();
  costs.equipmentCosts.fragments.UR[450] = 201;
  const result = calculateTeam(team, costs, baselinePolicy(), library);
  const ordinary = result.equipmentCosts[0];
  assert.equal(ordinary.equivalentArtifactMaterials, 8.04);
  assert.equal(ordinary.chargedEquivalentArtifactMaterials, 8.04);
  assert.equal(ordinary.craftingDiamonds, 2010);
  assert.equal(ordinary.diamonds, 2010);
  const invalid = baselinePolicy();
  invalid.conversions = { relicMaterialsPerExchange: 2, urLrFragmentsPerExchange: 0 };
  assert.throws(() => calculateTeam(team, costs, invalid, library), error => error.errors.some(item => item.code === 'INVALID_RELIC_CONVERSION'));
});
