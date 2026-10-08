import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTeam, cloneTeam, createEquipment, createExport, createMember, createTeam,
  DomainValidationError, parseImport, validateTeam,
} from '../src/domain.mjs';

// Synthetic pricing fixtures isolate the budget contract; they are not evidence of game growth data.
const catalog = {
  version: 'team-diamond-fixture',
  characters: Array.from({ length: 7 }, (_, index) => ({
    id: index + 1, name: `预算角色${index + 1}`, element: 'blue', job: 1, baseRarity: index === 0 ? 2 : 8,
  })),
  runeCategories: [{ id: 5, name: '穿透', allowedSlots: [1, 2, 3] }, { id: 9, name: '速度', allowedSlots: [1, 2, 3] }],
  equipmentCosts: {
    fragments: {
      SSR: { 450: 50 }, UR: { 450: 200 }, LR: { 450: 200 },
      exclusiveSSR: { 180: 80 }, exclusiveUR: { 240: 100, 300: 400, 450: 600 },
      exclusiveLR: { 300: 400, 450: 600 },
    },
    reinforcement: {
      weapon: Array.from({ length: 451 }, (_, level) => level * 100),
      other: Array.from({ length: 451 }, (_, level) => level * 50),
    },
    sacredExperience: Array.from({ length: 41 }, (_, level) => level),
  },
  arcana: { schemaVersion: 1, permanentCharacterIds: [], groups: [
    { id: 101, name: '队外秘仪', characterIds: [6, 7], lrBonuses: [] },
  ] },
};
const policy = {
  version: 'team-budget-fixture', characterLevel: 450,
  unitPrices: { characterCopy: 12000, runeTickets: 10, reinforcementMedicine: 10, holySteel: 100,
    ssrFragments: 4, urLrFragments: 10, exclusiveFragments: 100, lifeTreeDew: 400 },
  copies: { SR: { normal: 1, lightDark: 1 }, LR: { normal: 8, lightDark: 14 }, LR5: { normal: 20, lightDark: 26 } },
  equipment: { urLifeTreeDew: 0, lrLifeTreeDew: 50, exclusiveUrLifeTreeDew: 15, exclusiveLrLifeTreeDew: 65 },
  allowances: { reinforcementMedicine: 10 }, holySteelPerExperience: 1,
  blessings: [
    { id: 'forge', name: '恩泽·锻造', effect: 'freeEquipmentCrafting', rarity: 'SSR', weaponKind: 'normal', resource: 'ssrFragments' },
    { id: 'crystal', name: '恩泽·紫晶', effect: 'freeExclusiveFragmentBaseline', resource: 'exclusiveFragments', rarity: 'UR', level: 240,
      teamDiamondAllowance: { amount: 100000, triggerBaseRarities: [1, 2] } },
  ],
};
const library = { format: 'mementomori-free-library', schemaVersion: 1, version: 1,
  characters: [{ characterId: 1, rarity: 'LR5' }], exclusiveWeapons: [] };
const copy = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);
const fullTeam = () => ({ ...createTeam(), members: catalog.characters.slice(0, 5).map(character => {
  const member = createMember(character);
  if (character.id === 1) member.rarity = 'LR5';
  return member;
}) });
const equip = (team, index, slot, rarity, overrides = {}) => {
  const gear = { ...createEquipment(slot), rarity, seriesId: { SSR: 12, UR: 13, LR: 14 }[rarity], ...overrides };
  team.members[index].equipment[slot - 1] = gear;
  if (rarity === 'LR') team.members[index].rarity = 'LR5';
  return gear;
};
const freeAllLibrary = () => ({ ...library, characters: catalog.characters.map(character => ({ characterId: character.id, rarity: 'LR5' })) });

function verifyLedger(result) {
  const characters = result.characterCosts.reduce((sum, row) => sum + row.paidDiamonds, 0);
  const equipment = result.equipmentCosts.reduce((sum, row) => sum + row.paidDiamonds, 0);
  const resources = Object.values(result.resources).reduce((sum, row) => sum + row.paidDiamonds, 0);
  close(equipment, resources);
  close(result.paidDiamonds, characters + equipment);
  close(result.paidDiamonds, result.memberCosts.reduce((sum, row) => sum + row.rawTotalDiamonds, 0) + result.rawOffTeamDiamonds);
  close(result.rawPaidDiamonds - result.paidDiamonds, result.teamDiamondAllowanceCredit);
  close(result.teamDiamondAllowanceCredit, result.characterCosts.reduce((sum, row) => sum + row.teamDiamondAllowanceCredit, 0)
    + result.equipmentCosts.reduce((sum, row) => sum + row.teamDiamondAllowanceCredit, 0));
  for (const gear of result.equipmentCosts) {
    close(gear.rawPaidDiamonds - gear.paidDiamonds, gear.teamDiamondAllowanceCredit);
    close(gear.paidDiamonds, Object.values(gear.chargedResourceDiamonds).reduce((sum, value) => sum + value, 0));
    if (gear.weaponKind === 'exclusive') {
      const weapon = result.exclusiveWeaponCosts.find(row => row.position === gear.position && row.sourceIndex === gear.sourceIndex && row.sourceKind === gear.sourceKind);
      close(weapon.paidDiamonds, (gear.chargedResourceDiamonds.exclusiveFragments ?? 0) + (gear.chargedResourceDiamonds.lifeTreeDew ?? 0));
      close(weapon.rawPaidDiamonds - weapon.paidDiamonds, weapon.teamDiamondAllowanceCredit);
    }
  }
}

test('a selected R grants one whole-team budget against body fees without changing copy investment or UR240 baseline', () => {
  const team = fullTeam();
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.configuredTeamDiamondAllowance, 100000);
  assert.equal(result.teamDiamondAllowance, 100000);
  assert.deepEqual(result.teamDiamondAllowanceTriggerCharacterIds, [1]);
  assert.equal(result.teamDiamondAllowanceCredit, 48000);
  assert.equal(result.remainingTeamDiamondAllowance, 52000);
  assert.equal(result.totalDiamonds, 0);
  assert.equal(result.grossCharacterDiamonds, 288000);
  assert.equal(result.freeCharacterDiamonds, 240000);
  assert.deepEqual(result.characterCosts.map(row => row.chargedCopies), [0, 1, 1, 1, 1]);
  assert.deepEqual(result.characterCosts.map(row => row.teamDiamondAllowanceCredit), [0, 12000, 12000, 12000, 12000]);
  verifyLedger(result);
  equip(team, 1, 1, 'UR', { weaponKind: 'exclusive' });
  const armed = calculateTeam(team, catalog, policy, library);
  assert.equal(armed.resources.exclusiveFragments.baselineBlessingCredit, 100);
  assert.equal(armed.resources.exclusiveFragments.rawPaidDiamonds, 50000);
  assert.equal(armed.exclusiveWeaponCosts[0].chargedFragments, 500);
  assert.equal(armed.exclusiveWeaponCosts[0].baselineLevel, 240);
  assert.equal(armed.resources.exclusiveFragments.diamonds, 0);
  assert.equal(armed.resources.lifeTreeDew.teamDiamondAllowanceCredit, 2000);
  assert.equal(armed.resources.lifeTreeDew.diamonds, 4000);
  assert.equal(armed.resources.lifeTreeDew.charged, 15);
  assert.equal(armed.totalDiamonds, 4000);
  verifyLedger(armed);
});

test('UR/LR fragments, red medicine, leaves, purple crystals, runes and sacred experience all accept the common budget', () => {
  const cases = [
    ['urLrFragments', team => equip(team, 1, 2, 'UR'), 2000],
    ['lifeTreeDew', team => equip(team, 1, 2, 'LR'), 20000],
    ['reinforcementMedicine', team => equip(team, 1, 2, 'SSR', { reinforcementLevel: 20 }), 9900],
    ['exclusiveFragments', team => equip(team, 1, 1, 'UR', { weaponKind: 'exclusive' }), 50000],
    ['runeTickets', team => equip(team, 1, 2, 'SSR', { runes: [{ categoryId: 9, level: 10 }, ...createEquipment(2).runes.slice(1)] }), 10240],
    ['holySteel', team => equip(team, 1, 2, 'SSR', { legendSacredTreasureLevel: 40 }), 4000],
  ];
  for (const [resourceKey, configure, rawPrice] of cases) {
    const team = fullTeam();
    configure(team);
    const result = calculateTeam(team, catalog, policy, freeAllLibrary());
    assert.equal(result.resources[resourceKey].rawPaidDiamonds, rawPrice, resourceKey);
    assert.equal(result.resources[resourceKey].teamDiamondAllowanceCredit, rawPrice, resourceKey);
    assert.equal(result.resources[resourceKey].diamonds, 0, resourceKey);
    assert.equal(result.totalDiamonds, 0, resourceKey);
    verifyLedger(result);
  }
});

test('the budget caps at total net fees and exceeding it never produces negative rows or duplicate member discounts', () => {
  const team = fullTeam();
  team.members[1].rarity = 'LR5';
  equip(team, 1, 2, 'LR');
  equip(team, 2, 1, 'UR', { weaponKind: 'exclusive' });
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.rawPaidDiamonds, 354000);
  assert.equal(result.totalDiamonds, 254000);
  assert.equal(result.teamDiamondAllowanceCredit, 100000);
  assert.equal(result.remainingTeamDiamondAllowance, 0);
  assert.deepEqual(result.characterCosts.map(row => row.teamDiamondAllowanceCredit), [0, 100000, 0, 0, 0]);
  assert.equal(result.memberCosts[1].characterDiamonds, 140000);
  assert.equal(result.memberCosts[1].equipmentDiamonds, 22000);
  assert.equal(result.memberCosts[1].totalDiamonds, 162000);
  assert.ok(result.equipmentCosts.every(row => row.teamDiamondAllowanceCredit === 0 && row.paidDiamonds >= 0));
  verifyLedger(result);
});

test('two eligible cards still grant only one allowance, and only actual lineup membership activates it', () => {
  const configuredCatalog = copy(catalog);
  configuredCatalog.characters[1].baseRarity = 2;
  const granted = freeAllLibrary();
  const team = fullTeam();
  team.members[1].rarity = 'LR5';
  equip(team, 2, 2, 'LR');
  const result = calculateTeam(team, configuredCatalog, policy, granted);
  assert.equal(result.teamDiamondAllowance, 100000);
  assert.deepEqual(result.teamDiamondAllowanceTriggerCharacterIds, [1, 2]);
  assert.equal(result.teamDiamondAllowanceCredit, 22000);
  const saved = cloneTeam(team);
  team.members[0] = null;
  assert.equal(calculateTeam(team, configuredCatalog, policy, granted).teamDiamondAllowance, 100000);
  team.members[1] = null;
  const removed = calculateTeam(team, configuredCatalog, policy, granted);
  assert.equal(removed.teamDiamondAllowance, 0);
  assert.equal(removed.totalDiamonds, 22000);
  assert.equal(calculateTeam(saved, configuredCatalog, policy, granted).totalDiamonds, 0);
  // Owned/free R cards outside the lineup do not activate the lineup condition.
  assert.equal(removed.configuredTeamDiamondAllowance, 100000);
  assert.deepEqual(removed.teamDiamondAllowanceTriggerCharacterIds, []);
});

test('an actual catalog N entry activates the configured N trigger without trusting member-provided base rarity', () => {
  const configuredCatalog = copy(catalog);
  Object.assign(configuredCatalog.characters[0], { baseRarity: 1, defaultRarity: 'N', allowedRarities: ['N'] });
  const configuredPolicy = copy(policy);
  configuredPolicy.copies.N = { normal: 1, lightDark: 1 };
  const granted = { ...library, characters: [{ characterId: 1, rarity: 'N' }] };
  const team = fullTeam();
  team.members[0] = createMember(configuredCatalog.characters[0]);
  const result = calculateTeam(team, configuredCatalog, configuredPolicy, granted);
  assert.equal(result.teamDiamondAllowance, 100000);
  assert.deepEqual(result.teamDiamondAllowanceTriggerCharacterIds, [1]);
  assert.equal(result.teamDiamondAllowanceCredit, 48000);
  assert.equal(result.totalDiamonds, 0);
  verifyLedger(result);
  configuredPolicy.blessings[1].teamDiamondAllowance.triggerBaseRarities = [2];
  assert.equal(calculateTeam(team, configuredCatalog, configuredPolicy, granted).teamDiamondAllowance, 0);
  team.members[1].baseRarity = 2;
  assert.equal(calculateTeam(team, configuredCatalog, configuredPolicy, granted).teamDiamondAllowance, 0);
});

test('purchased arcana body fees share the same ledger and receive remaining lineup allowance exactly once', () => {
  const team = fullTeam();
  team.purchasedArcanaIds = [101];
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.rawPaidDiamonds, 240000);
  assert.equal(result.totalDiamonds, 140000);
  assert.equal(result.memberCosts.reduce((sum, row) => sum + row.totalDiamonds, 0), 0);
  assert.equal(result.offTeamDiamonds, 140000);
  assert.deepEqual(result.offTeamCharacterCosts.map(row => [row.characterId, row.rawPaidDiamonds, row.teamDiamondAllowanceCredit, row.diamonds]), [
    [6, 96000, 52000, 44000], [7, 96000, 0, 96000],
  ]);
  const noEligible = cloneTeam(team);
  noEligible.members[0] = null;
  assert.equal(calculateTeam(noEligible, catalog, policy, library).teamDiamondAllowance, 0);
  verifyLedger(result);
});

test('legacy off-team weapon sources use the same net budget without charging reserve summaries a second time', () => {
  const team = fullTeam();
  team.weaponSources = [{ characterId: 6, characterRarity: 'SR', rarity: 'UR', level: 300 }];
  const result = calculateTeam(team, catalog, policy, library);
  assert.equal(result.rawPaidDiamonds, 96000);
  assert.equal(result.totalDiamonds, 0);
  assert.equal(result.remainingTeamDiamondAllowance, 4000);
  assert.equal(result.weaponSourceCosts[0].rawPaidDiamonds, 48000);
  assert.equal(result.weaponSourceCosts[0].teamDiamondAllowanceCredit, 48000);
  assert.equal(result.weaponSourceCosts[0].characterDiamonds, 0);
  assert.equal(result.weaponSourceCosts[0].weaponDiamonds, 0);
  assert.equal(result.weaponSourceCosts[0].diamonds, 0);
  assert.equal(result.offTeamDiamonds, 0);
  verifyLedger(result);
});

test('fractional reference prices stay exact until final rounding while common-credit rows retain actual material demand', () => {
  const team = fullTeam();
  equip(team, 1, 1, 'LR', { weaponKind: 'exclusive' });
  equip(team, 1, 2, 'LR');
  const configured = copy(policy);
  configured.unitPrices.exclusiveFragments = 46.0676829268293;
  configured.unitPrices.urLrFragments = 211.4210142276423;
  const result = calculateTeam(team, catalog, configured, freeAllLibrary());
  const beforeBudget = 500 * configured.unitPrices.exclusiveFragments + 200 * configured.unitPrices.urLrFragments + 115 * 400;
  close(result.rawPaidDiamonds, beforeBudget);
  close(result.paidDiamonds, beforeBudget - 100000);
  assert.equal(result.totalDiamonds, Math.round((beforeBudget - 100000) * 100) / 100);
  assert.equal(result.resources.exclusiveFragments.consumed, 600);
  assert.equal(result.resources.exclusiveFragments.charged, 500);
  assert.equal(result.resources.urLrFragments.consumed, 200);
  assert.equal(result.resources.urLrFragments.charged, 200);
  assert.equal(result.exclusiveWeaponCosts[0].chargedFragments, 500);
  assert.equal(result.equipmentCosts[1].equivalentArtifactMaterials, 8);
  assert.equal(result.equipmentCosts[1].chargedEquivalentArtifactMaterials, 8);
  verifyLedger(result);
});

test('shared resource allowances, gift baseline and pool-specific cash credits precede the general cash budget', () => {
  const team = fullTeam();
  equip(team, 1, 1, 'UR', { weaponKind: 'exclusive' });
  equip(team, 2, 2, 'SSR', { reinforcementLevel: 30 });
  const configured = copy(policy);
  configured.blessings.push({ id: 'dew', name: '恩泽·生命', effect: 'resourceDiamondAllowance', resource: 'lifeTreeDew', amount: 60000 });
  configured.allowances.exclusiveFragments = 10;
  const granted = freeAllLibrary();
  granted.exclusiveWeapons = [{ characterId: 2, rarity: 'UR', level: 240 }];
  const result = calculateTeam(team, catalog, configured, granted);
  assert.equal(result.resources.exclusiveFragments.consumed, 600);
  assert.equal(result.resources.exclusiveFragments.freeLibraryCredit, 100);
  assert.equal(result.resources.exclusiveFragments.baselineBlessingCredit, 0);
  assert.equal(result.resources.exclusiveFragments.rawPaidDiamonds, 49000);
  assert.equal(result.resources.exclusiveFragments.teamDiamondAllowanceCredit, 49000);
  assert.equal(result.resources.lifeTreeDew.freeLibraryCredit, 15);
  assert.equal(result.resources.lifeTreeDew.teamDiamondAllowanceCredit, 0);
  assert.equal(result.resources.reinforcementMedicine.teamDiamondAllowanceCredit, 14900);
  assert.equal(result.teamDiamondAllowanceCredit, 63900);
  assert.equal(result.remainingTeamDiamondAllowance, 36100);
  assert.equal(result.totalDiamonds, 0);
  verifyLedger(result);
});

test('import recomputes current eligibility and allowance rather than trusting injected policy or exported quote fields', () => {
  const team = fullTeam();
  const exported = createExport(team, catalog, policy, library);
  exported.policySnapshot.blessings[1].teamDiamondAllowance.amount = 999999999;
  exported.costBreakdown.totalDiamonds = -100000;
  exported.costBreakdown.teamDiamondAllowance = 999999999;
  exported.team.teamDiamondAllowanceTriggerCharacterIds = [999];
  const parsed = parseImport(exported, catalog, policy, library);
  assert.equal(parsed.costBreakdown.teamDiamondAllowance, 100000);
  assert.equal(parsed.costBreakdown.teamDiamondAllowanceCredit, 48000);
  assert.equal(parsed.costBreakdown.totalDiamonds, 0);
  assert.equal(parsed.team.teamDiamondAllowanceTriggerCharacterIds, undefined);
  const noTriggerCatalog = copy(catalog);
  noTriggerCatalog.characters[0].baseRarity = 8;
  assert.equal(parseImport(exported, noTriggerCatalog, policy, library).costBreakdown.teamDiamondAllowance, 0);
  assert.equal(parseImport(exported, noTriggerCatalog, policy, library).costBreakdown.totalDiamonds, 48000);
});

test('malformed general budgets and SR eligibility are rejected while omitted or zero budgets preserve old pricing', () => {
  for (const allowance of [null, [], {}, { amount: -1, triggerBaseRarities: [1, 2] },
    { amount: Infinity, triggerBaseRarities: [1, 2] }, { amount: '100000', triggerBaseRarities: [1, 2] },
    { amount: 100000, triggerBaseRarities: [] }, { amount: 100000, triggerBaseRarities: [2, 2] },
    { amount: 100000, triggerBaseRarities: [8] }, { amount: 100000, triggerBaseRarities: ['2'] },
    { amount: 100000, triggerBaseRarities: null }]) {
    const configured = copy(policy);
    configured.blessings[1].teamDiamondAllowance = allowance;
    const validation = validateTeam(fullTeam(), catalog, configured, { freeLibrary: library });
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(row => row.code === 'INVALID_TEAM_DIAMOND_ALLOWANCE'));
    assert.throws(() => calculateTeam(fullTeam(), catalog, configured, library), DomainValidationError);
  }
  const wrongEffect = copy(policy);
  wrongEffect.blessings[0].teamDiamondAllowance = { amount: 100000, triggerBaseRarities: [1, 2] };
  assert.equal(validateTeam(fullTeam(), catalog, wrongEffect, { freeLibrary: library }).valid, false);
  const older = copy(policy);
  delete older.blessings[1].teamDiamondAllowance;
  assert.equal(calculateTeam(fullTeam(), catalog, older, library).totalDiamonds, 48000);
  assert.equal(calculateTeam(fullTeam(), catalog, older, library).teamDiamondAllowance, 0);
  older.blessings[1].teamDiamondAllowance = { amount: 0, triggerBaseRarities: [1, 2] };
  assert.equal(calculateTeam(fullTeam(), catalog, older, library).totalDiamonds, 48000);
});
