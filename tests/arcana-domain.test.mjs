import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeam, createMember, calculateTeam, validateTeam, createExport, parseImport, cloneTeam,
  getArcanaState, setArcanaPurchased, getArcanaRequiredRarity, getResourceAllowance, DomainValidationError,
} from '../src/domain.mjs';
import { addRosterCharacter, placeRosterCharacter } from '../src/team-interactions.mjs';

const characters = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `角色${index + 1}`, element: index === 7 ? 'dark' : 'blue', job: 1 }));
const bonus = value => ({ kind: 'base', type: 1, name: '攻击力', changeType: 2, value });
const catalog = {
  version: 'arcana-test-1', characters, runeCategories: [{ id: 5, name: '穿透', allowedSlots: [1, 2, 3] }, { id: 9, name: '速度', allowedSlots: [1, 2, 3] }],
  equipmentCosts: {
    fragments: { SSR: { 450: 50 }, exclusiveSSR: { 180: 80 } }, allowedLevels: { SSR: [450] },
    reinforcement: { weapon: Array.from({ length: 451 }, (_, level) => level * 1000), other: Array.from({ length: 451 }, (_, level) => level * 500) },
    sacredExperience: Array.from({ length: 41 }, (_, level) => level),
  },
  arcana: { schemaVersion: 1, permanentCharacterIds: [1, 2], groups: [
    { id: 101, name: '常驻秘仪', characterIds: [1, 2], lrBonuses: [bonus(100)] },
    { id: 102, name: '秘仪甲', characterIds: [3, 6], lrBonuses: [bonus(200)] },
    { id: 103, name: '秘仪乙', characterIds: [6, 7], lrBonuses: [bonus(300)] },
    { id: 104, name: '光暗秘仪', characterIds: [8], lrBonuses: [bonus(400)] },
  ] },
};
const policy = {
  version: 6, characterLevel: 450, unitPrices: { characterCopy: 12000, ssrFragments: 2, exclusiveFragments: 3, reinforcementMedicine: 10 },
  copies: { SR: { normal: 1, lightDark: 1 }, LR: { normal: 8, lightDark: 14 }, LR5: { normal: 20, lightDark: 26 } },
  allowances: { reinforcementMedicine: 60000, holySteel: 3500 }, holySteelPerExperience: 1,
  blessings: [{ id: 'crimson-grace', name: '赐福·绯红恩泽', resource: 'reinforcementMedicine', amount: 40000 }],
};
const freeLibrary = { format: 'mementomori-free-library', schemaVersion: 1, version: 1,
  characters: [{ characterId: 1, rarity: 'LR5' }, { characterId: 2, rarity: 'LR' }, { characterId: 3, rarity: 'SR' }, { characterId: 8, rarity: 'SR' }], exclusiveWeapons: [] };
const copy = value => JSON.parse(JSON.stringify(value));
const fullTeam = () => ({ ...createTeam(), members: characters.slice(0, 5).map(createMember) });
const purchase = (team, id) => setArcanaPurchased(team, id, true, catalog, policy, freeLibrary);

test('permanent LR groups unlock from actual free caps while limited free SR does not unlock its LR group', () => {
  const state = getArcanaState(createTeam(), catalog, policy, freeLibrary);
  const permanent = state.groups.find(group => group.id === 101);
  assert.equal(permanent.permanent, true);
  assert.equal(permanent.automaticallyUnlocked, true);
  assert.equal(permanent.unlocked, true);
  assert.equal(permanent.currentPurchaseDiamonds, 0);
  const limited = state.groups.find(group => group.id === 102);
  assert.equal(limited.permanent, false);
  assert.equal(limited.unlocked, false);
  assert.deepEqual(limited.missingCharacters.map(character => [character.characterId, character.fromRarity, character.diamonds]), [[3, 'SR', 84000], [6, null, 96000]]);
  assert.equal(limited.currentPurchaseDiamonds, 180000);
  assert.equal(state.groups.find(group => group.id === 104).currentPurchaseDiamonds, 156000);
  assert.equal(state.lrBonuses[0].value, 100);
  const lowerCaps = copy(freeLibrary);
  lowerCaps.characters[0].rarity = 'SR';
  assert.equal(getArcanaState(createTeam(), catalog, policy, lowerCaps).groups[0].unlocked, false);
});

test('buying overlapping LR groups shares character costs and promotes team SR without creating equipment', () => {
  const original = fullTeam();
  const before = calculateTeam(original, catalog, policy, freeLibrary);
  const first = purchase(original, 102);
  assert.equal(first.members[2].rarity, 'LR');
  assert.equal(original.members[2].rarity, 'SR');
  const secondQuote = getArcanaState(first, catalog, policy, freeLibrary).groups.find(group => group.id === 103);
  assert.equal(secondQuote.currentPurchaseDiamonds, 96000);
  assert.deepEqual(secondQuote.missingCharacterIds, [7]);
  const both = purchase(first, 103);
  const cost = calculateTeam(both, catalog, policy, freeLibrary);
  assert.equal(cost.characterDiamonds - before.characterDiamonds, 276000);
  assert.equal(cost.characterCosts.filter(row => row.characterId === 6).length, 1);
  assert.deepEqual(cost.characterCosts.find(row => row.characterId === 6).arcanaIds, [102, 103]);
  assert.deepEqual(cost.characterCosts.filter(row => row.sourceKind === 'arcana').map(row => [row.characterId, row.rarity, row.position]), [[6, 'LR', null], [7, 'LR', null]]);
  assert.equal(cost.equipmentCosts.length, 0);
  assert.equal(cost.arcanaState.lrBonuses[0].value, 600);
  const canceled = setArcanaPurchased(both, 102, false, catalog, policy, freeLibrary);
  assert.equal(canceled.members[2].rarity, 'LR');
  assert.deepEqual(canceled.purchasedArcanaIds, [103]);
  assert.equal(calculateTeam(canceled, catalog, policy, freeLibrary).characterCosts.filter(row => row.characterId === 6).length, 1);
});

test('existing LR and LR5 ownership unlocks LR bonuses without buying and never charges a second character', () => {
  const team = fullTeam();
  team.members[2].rarity = 'LR5';
  team.members[4] = createMember(6);
  team.members[4].rarity = 'LR';
  const state = getArcanaState(team, catalog, policy, freeLibrary);
  assert.equal(state.groups.find(group => group.id === 102).unlocked, true);
  assert.equal(state.groups.find(group => group.id === 102).purchased, false);
  const before = calculateTeam(team, catalog, policy, freeLibrary);
  const after = calculateTeam(purchase(team, 102), catalog, policy, freeLibrary);
  assert.equal(after.characterDiamonds, before.characterDiamonds);
  assert.equal(after.characterCosts.find(row => row.characterId === 3).copies, 20);
  assert.equal(after.characterCosts.find(row => row.characterId === 3).chargedCopies, 19);
  assert.equal(after.characterCosts.find(row => row.characterId === 6).copies, 8);
  assert.equal(after.characterCosts.length, 5);
});

test('member net investment includes its merged arcana body and all equipment while off-team arcana bodies are listed once', () => {
  const team = purchase(purchase(fullTeam(), 102), 103);
  Object.assign(team.members[0].equipment[1], { rarity: 'SSR', seriesId: 12, level: 450, reinforcementLevel: 300 });
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(cost.memberCosts.length, 5);
  assert.equal(cost.memberCosts[2].characterDiamonds, 84000);
  assert.deepEqual(cost.offTeamCharacterCosts.map(row => [row.characterId, row.sourceKind, row.diamonds]), [[6, 'arcana', 96000], [7, 'arcana', 96000]]);
  assert.equal(cost.offTeamCharacterDiamonds, 192000);
  assert.equal(cost.offTeamEquipmentDiamonds, 0);
  assert.equal(cost.offTeamDiamonds, 192000);
  const memberEquipment = cost.equipmentCosts.filter(row => row.position === 1);
  assert.equal(cost.memberCosts[0].rawEquipmentDiamonds, memberEquipment.reduce((sum, row) => sum + Object.values(row.chargedResourceDiamonds).reduce((subtotal, amount) => subtotal + amount, 0), 0));
  assert.equal(cost.memberCosts.reduce((sum, row) => sum + row.rawTotalDiamonds, 0) + cost.rawOffTeamDiamonds, cost.totalDiamonds);
  const joined = cloneTeam(team);
  joined.members[4] = { ...createMember(6), rarity: 'LR' };
  const next = calculateTeam(joined, catalog, policy, freeLibrary);
  assert.deepEqual(next.offTeamCharacterCosts.map(row => row.characterId), [7]);
  assert.equal(next.offTeamDiamonds, 96000);
  assert.equal(next.memberCosts[4].characterDiamonds, 96000);
  assert.equal(next.characterCosts.filter(row => row.characterId === 6).length, 1);
});

test('light dark LR charges fourteen cumulative copies minus its free SR and LR5 only adds its extra twelve copies', () => {
  const bought = purchase(createTeam(), 104);
  const baseline = calculateTeam(bought, catalog, policy, freeLibrary);
  assert.equal(baseline.characterDiamonds, 13 * 12000);
  const added = addRosterCharacter(bought, characters[7], { catalog, freeLibrary }).team;
  assert.equal(added.members[0].rarity, 'LR');
  added.members[0].rarity = 'LR5';
  const upgraded = calculateTeam(added, catalog, policy, freeLibrary);
  assert.equal(upgraded.characterDiamonds, 25 * 12000);
  assert.equal(upgraded.characterDiamonds - baseline.characterDiamonds, 12 * 12000);
  assert.equal(upgraded.characterCosts.filter(row => row.characterId === 8).length, 1);
});

test('dragging and replacing a purchased LR character use LR while preserving the destination gear', () => {
  const bought = purchase(createTeam(), 102);
  assert.equal(getArcanaRequiredRarity(bought, 3, catalog), 'LR');
  const added = addRosterCharacter(bought, characters[2], { catalog, freeLibrary });
  assert.equal(added.team.members[0].rarity, 'LR');
  assert.equal(added.team.members[0].equipment[0].matchlessSacredTreasureLevel, 40);
  const base = fullTeam();
  const selected = purchase(base, 102);
  selected.members[4].equipment[1].matchlessSacredTreasureLevel = 17;
  const placed = placeRosterCharacter(selected, characters[5], 4, { catalog, freeLibrary });
  assert.equal(placed.team.members[4].rarity, 'LR');
  assert.equal(placed.team.members[4].equipment[1].matchlessSacredTreasureLevel, 17);
});

test('invalid purchased IDs, duplicate groups, non LR purchase objects and team SR mismatches never reach export', () => {
  for (const selection of [[999], [102, 102], [{ id: 102, rarity: 'SSR' }], ['102'], null]) {
    const team = fullTeam();
    team.purchasedArcanaIds = selection;
    assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, false);
    assert.throws(() => createExport(team, catalog, policy, freeLibrary), DomainValidationError);
  }
  const team = fullTeam();
  team.purchasedArcanaIds = [102];
  assert.ok(validateTeam(team, catalog, policy, { freeLibrary }).errors.some(issue => issue.code === 'ARCANA_REQUIRES_LR'));
  assert.throws(() => setArcanaPurchased(team, 999, true, catalog, policy, freeLibrary), DomainValidationError);
  const badCatalog = copy(catalog);
  badCatalog.arcana.groups[0].rarity = 'SSR';
  assert.equal(validateTeam(fullTeam(), badCatalog, policy, { freeLibrary }).valid, false);
});

test('old files default to no purchases and current imports recompute prices and entitlements without trusting embedded quotes', () => {
  const original = purchase(purchase(fullTeam(), 102), 103);
  const exported = createExport(original, catalog, policy, freeLibrary);
  const cloned = cloneTeam(original);
  cloned.purchasedArcanaIds.push(104);
  assert.deepEqual(original.purchasedArcanaIds, [102, 103]);
  exported.costBreakdown.totalDiamonds = 0;
  exported.policySnapshot.unitPrices.characterCopy = 0;
  exported.freeLibrarySnapshot.characters = characters.map(character => ({ characterId: character.id, rarity: 'LR5' }));
  exported.arcanaSnapshot = { groups: [] };
  const imported = parseImport(exported, catalog, policy, freeLibrary);
  assert.equal(imported.costBreakdown.totalDiamonds, calculateTeam(original, catalog, policy, freeLibrary).totalDiamonds);
  assert.deepEqual(imported.team.purchasedArcanaIds, [102, 103]);
  const old = createExport(fullTeam(), catalog, policy, freeLibrary);
  delete old.team.purchasedArcanaIds;
  assert.deepEqual(parseImport(old, catalog, policy, freeLibrary).team.purchasedArcanaIds, []);
  const repriced = { ...policy, unitPrices: { ...policy.unitPrices, characterCopy: 10000 } };
  assert.equal(parseImport(exported, catalog, repriced, freeLibrary).costBreakdown.characterDiamonds,
    calculateTeam(original, catalog, repriced, freeLibrary).characterDiamonds);
});

test('reinforcement blessing adds forty thousand to sixty thousand base without changing other resources or double counting', () => {
  assert.equal(getResourceAllowance(policy, 'reinforcementMedicine'), 100000);
  assert.equal(getResourceAllowance(policy, 'holySteel'), 3500);
  assert.equal(getResourceAllowance({ ...policy, blessings: undefined }, 'reinforcementMedicine'), 60000);
  const team = fullTeam();
  Object.assign(team.members[0].equipment[0], { rarity: 'SSR', level: 450, reinforcementLevel: 100 });
  const threshold = calculateTeam(team, catalog, policy, freeLibrary).resources.reinforcementMedicine;
  assert.equal(threshold.baseAllowance, 60000);
  assert.equal(threshold.blessingAllowance, 40000);
  assert.equal(threshold.freeAllowance, 100000);
  assert.equal(threshold.charged, 0);
  team.members[0].equipment[0].reinforcementLevel = 101;
  assert.equal(calculateTeam(team, catalog, policy, freeLibrary).resources.reinforcementMedicine.diamonds, 10000);
  assert.equal(calculateTeam(team, catalog, policy, freeLibrary).resources.holySteel.blessingAllowance, 0);
});

test('malformed blessing resource, amount or duplicate ID is rejected even with no installed equipment', () => {
  const cases = [
    { ...policy.blessings[0], resource: 'characters' }, { ...policy.blessings[0], amount: -1 },
    { ...policy.blessings[0], amount: Infinity }, { ...policy.blessings[0], amount: '40000' },
    { ...policy.blessings[0], id: '' },
  ];
  for (const blessing of cases) {
    const invalid = { ...policy, blessings: [blessing] };
    assert.equal(validateTeam(createTeam(), catalog, invalid, { freeLibrary }).valid, false);
    assert.throws(() => getResourceAllowance(invalid, 'reinforcementMedicine'), DomainValidationError);
  }
  const duplicate = { ...policy, blessings: [policy.blessings[0], { ...policy.blessings[0] }] };
  assert.throws(() => calculateTeam(createTeam(), catalog, duplicate, freeLibrary), DomainValidationError);
});

test('R characters are free LR support for arcana without becoming selectable team characters', () => {
  const configured = copy(catalog);
  configured.arcana.supportCharacters = [{ id: 9, name: '免费R', element: 'red', job: 4, baseRarity: 2, freeRarity: 'LR' }];
  configured.arcana.permanentCharacterIds.push(9);
  configured.arcana.groups.push({ id: 105, name: 'R与限定', published: true, characterIds: [9, 3], lrBonuses: [bonus(500)], lr5Bonuses: null });
  const state = getArcanaState(createTeam(), configured, policy, freeLibrary);
  assert.deepEqual(state.groups.find(group => group.id === 105).missingCharacterIds, [3]);
  assert.equal(state.groups.find(group => group.id === 105).currentPurchaseDiamonds, 84000);
  assert.equal(state.ledger.find(character => character.characterId === 9).rarity, 'LR');
  assert.equal(state.ledger.find(character => character.characterId === 9).support, true);
  const bought = setArcanaPurchased(createTeam(), 105, true, configured, policy, freeLibrary);
  const cost = calculateTeam(bought, configured, policy, freeLibrary);
  assert.equal(cost.characterDiamonds, 84000);
  assert.equal(cost.characterCosts.find(character => character.characterId === 9).chargedCopies, 0);
  assert.equal(cost.arcanaState.groups.find(group => group.id === 105).bonusTierLabel, 'LR');
  const invalid = createTeam();
  invalid.members[0] = createMember(9);
  assert.ok(validateTeam(invalid, configured, policy, { freeLibrary }).errors.some(issue => issue.code === 'UNKNOWN_CHARACTER'));
});

test('unpublished zero-character groups cannot unlock or be purchased and other unknown characters remain invalid', () => {
  const configured = copy(catalog);
  configured.arcana.groups.push({ id: 106, name: '未开放', published: false, characterIds: [8, 0], lrBonuses: [bonus(500)] });
  const state = getArcanaState(createTeam(), configured, policy, freeLibrary);
  const unpublished = state.groups.find(group => group.id === 106);
  assert.equal(unpublished.published, false);
  assert.equal(unpublished.unlocked, false);
  assert.equal(unpublished.currentPurchaseDiamonds, null);
  assert.throws(() => setArcanaPurchased(createTeam(), 106, true, configured, policy, freeLibrary), DomainValidationError);
  const forged = createExport(fullTeam(), configured, policy, freeLibrary);
  forged.team.purchasedArcanaIds = [106];
  assert.throws(() => parseImport(forged, configured, policy, freeLibrary), DomainValidationError);
  configured.arcana.groups.at(-1).published = true;
  assert.equal(validateTeam(createTeam(), configured, policy, { freeLibrary }).valid, false);
  configured.arcana.groups.at(-1).published = false;
  configured.arcana.groups.at(-1).characterIds = [8, 999];
  assert.equal(validateTeam(createTeam(), configured, policy, { freeLibrary }).valid, false);
});

test('LR5 bonuses depend on every actual owned character and never grant a higher rarity or charge a new body', () => {
  const configured = copy(catalog);
  configured.arcana.groups[0].lr5Bonuses = [bonus(500)];
  configured.arcana.groups[0].lr5RarityBonus = 1;
  configured.arcana.groups[1].lr5Bonuses = [bonus(700)];
  configured.arcana.groups[1].lr5RarityBonus = 1;
  const initial = getArcanaState(fullTeam(), configured, { ...policy, arcana: { mode: 'ownedRarity' } }, freeLibrary);
  assert.equal(initial.groups[0].bonusTierLabel, 'LR');
  const allFreeLR5 = copy(freeLibrary);
  allFreeLR5.characters.find(character => character.characterId === 2).rarity = 'LR5';
  const team = fullTeam();
  const freeState = getArcanaState(team, configured, policy, allFreeLR5);
  assert.equal(freeState.groups[0].bonusTierLabel, 'LR5');
  assert.equal(freeState.groups[0].bonuses[0].value, 500);
  assert.equal(team.members[0].rarity, 'SR');
  assert.equal(team.members[1].rarity, 'SR');
  team.members[2].rarity = 'LR5';
  team.members[4] = createMember(6);
  team.members[4].rarity = 'LR5';
  const before = calculateTeam(team, configured, policy, allFreeLR5);
  assert.equal(before.arcanaState.groups[1].bonusTierLabel, 'LR5');
  assert.equal(before.arcanaState.groups[1].lr5RarityBonus, 1);
  assert.equal(before.arcanaState.lrBonuses[0].value, 1200);
  const bought = setArcanaPurchased(team, 102, true, configured, policy, allFreeLR5);
  assert.equal(calculateTeam(bought, configured, policy, allFreeLR5).characterDiamonds, before.characterDiamonds);
  assert.equal(bought.members[2].rarity, 'LR5');
  team.members[4].rarity = 'LR';
  assert.equal(getArcanaState(team, configured, policy, allFreeLR5).groups[1].bonusTierLabel, 'LR');
});

test('bonus display uses authoritative units and raw values rather than trusting formatted source strings', () => {
  const configured = copy(catalog);
  configured.arcana.groups[0].lrBonuses = [
    { kind: 'battle', type: 9, name: '暴击伤害', changeType: 1, value: 1500, unit: 'percent', displayValue: '+999999%' },
    { kind: 'base', type: 2, name: '生命', changeType: 3, value: 200, unit: 'perLevel', displayValue: '伪造显示' },
  ];
  const state = getArcanaState(createTeam(), configured, policy, freeLibrary);
  assert.equal(state.bonusRows.find(row => row.type === 9).displayValue, '+15%');
  assert.equal(state.bonusRows.find(row => row.type === 2).effectiveValue, 90000);
  assert.equal(state.bonusRows.find(row => row.type === 2).displayValue, '+90,000（450级）');
  assert.equal(state.bonusRows.find(row => row.type === 2).value, 200);
});
