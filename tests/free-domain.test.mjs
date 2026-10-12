import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createTeam, createMember, createEquipment, calculateTeam, validateTeam, selectEquipmentRarity,
  getArcanaState, setArcanaPurchased, getBorrowableWeapons, getEffectivePolicy,
  createExport, parseImport, cloneTeam, deriveWeaponPricing, deriveWeaponSync,
} from '../src/domain.mjs';
import { placeRosterCharacter } from '../src/team-interactions.mjs';
import { applyEquipmentPreset } from '../src/equipment-presets.mjs';

const [baseCatalog, cupPolicy, freeLibrary, arcana] = await Promise.all(
  ['catalog', 'pricing-policy', 'free-library', 'arcana-catalog'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))),
);
const catalog = { ...baseCatalog, mode: 'free', arcana,
  freeLevels: { limits: { characterLevel: { min: 1, max: 1000 }, playerLevel: { min: 1, max: 1100 } } },
};
const policy = { ...structuredClone(cupPolicy), mode: 'free', blessings: [], allowances: {},
  unitPrices: { ...cupPolicy.unitPrices, characterCopy: 17000, unidentifiedRune7: 256 },
  runes: { ticketCategoryIds: [5, 9], ticketExponentOffset: 0, unidentifiedRuneBaseLevel: 7 },
  weaponSync: { mode: 'none' },
  baseline: { ...cupPolicy.baseline, playerLevel: 560 },
};
const actor = catalog.characters.find(character => character.baseRarity === 8 && character.element === 'blue');
const select = (team, character, position = 0) => placeRosterCharacter(team, character, position, { catalog, policy, freeLibrary }).team;
const fresh = (level = 450, playerLevel = 560) => createTeam({ level, playerLevel });
const equip = (member, slot, overrides) => member.equipment[slot - 1] = {
  ...selectEquipmentRarity(createEquipment(slot), 'SSR'), matchlessSacredTreasureLevel: 0, ...overrides,
};

// Old tables are reused intentionally, so free accounting is independent of the new growth projection.
test('free mode ignores gifted bodies, weapons and arcana holdings while charging all existing paid resources', () => {
  let team = select(fresh(), actor);
  equip(team.members[0], 2, { level: 450, reinforcementLevel: 240, legendSacredTreasureLevel: 1, matchlessSacredTreasureLevel: 40,
    runes: [{ categoryId: 9, level: 10 }, { categoryId: 1, level: 10 }, { categoryId: 5, level: 0 }, { categoryId: 5, level: 0 }] });
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(cost.characterCosts[0].unitPrice, 17000);
  assert.equal(cost.characterCosts[0].freeCopies, 0);
  assert.equal(cost.characterCosts[0].diamonds, 17000);
  assert.equal(cost.resources.runeTickets.consumed, 2 ** 10);
  assert.equal(cost.resources.unidentifiedRune7.consumed, 2 ** 3);
  assert.equal(cost.resources.unidentifiedRune7.paidDiamonds, 8 * 256);
  assert.ok(cost.resources.reinforcementMedicine.paidDiamonds > 0);
  assert.ok(cost.resources.holySteel.paidDiamonds > 0);
  assert.ok(cost.resources.ssrFragments.paidDiamonds > 0);
  assert.ok(cost.resources.exclusiveFragments.paidDiamonds > 0);
  assert.equal(cost.matchlessExperience, catalog.equipmentCosts.sacredExperience[40] + catalog.equipmentCosts.sacredExperience[40]);
  for (const resource of Object.values(cost.resources)) {
    assert.equal(resource.freeLibraryCredit, 0);
    assert.equal(resource.blessingCredit, 0);
    assert.equal(resource.freeAllowance, 0);
    assert.equal(resource.teamDiamondAllowanceCredit, 0);
  }
  assert.equal(cost.teamDiamondAllowance, 0);
  assert.equal(cost.arcanaState.ledger.some(entry => entry.sourceKinds.includes('freeLibrary')), false);
  assert.equal(cost.memberCosts[0].rawTotalDiamonds, cost.paidDiamonds);
});

test('R and N have zero body price but paid compatible weapons, without purchasing the weapon owner body', () => {
  for (const character of catalog.characters.filter(item => [1, 2].includes(item.baseRarity))) {
    const team = select(fresh(), character);
    const weapon = team.members[0].equipment[0];
    assert.equal(weapon.rarity, 'UR');
    assert.notEqual(weapon.weaponOwnerCharacterId, character.id);
    const cost = calculateTeam(team, catalog, policy, freeLibrary);
    assert.equal(cost.characterCosts.length, 1);
    assert.equal(cost.characterCosts[0].characterId, character.id);
    assert.equal(cost.characterCosts[0].unitPrice, 0);
    assert.equal(cost.characterCosts[0].diamonds, 0);
    assert.equal(cost.characterCosts[0].freeCopies, 0);
    assert.ok(cost.resources.exclusiveFragments.paidDiamonds > 0);
    assert.equal(cost.resources.lifeTreeDew.paidDiamonds, 15 * 400);
    assert.equal(cost.exclusiveWeaponCosts[0].ownExclusiveSkillActive, false);
    assert.equal(cost.teamDiamondAllowance, 0);
  }
});

test('free arcana starts unowned, buys R conditions for zero and charges each SR source only once', () => {
  let team = fresh();
  const state = getArcanaState(team, catalog, policy, freeLibrary);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.groups.some(group => group.unlocked), false);
  const group = arcana.groups.find(item => item.published !== false
    && item.characterIds.some(id => catalog.characters.find(character => character.id === id)?.baseRarity === 2)
    && item.characterIds.some(id => catalog.characters.find(character => character.id === id)?.baseRarity === 8));
  assert.ok(group);
  team = setArcanaPurchased(team, group.id, true, catalog, policy, freeLibrary);
  const sr = catalog.characters.find(character => group.characterIds.includes(character.id) && character.baseRarity === 8);
  team = select(team, sr);
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(cost.arcanaState.groups.find(item => item.id === group.id).unlocked, true);
  assert.equal(cost.characterCosts.filter(item => item.characterId === sr.id).length, 1);
  assert.equal(cost.characterCosts.find(item => item.characterId === sr.id).diamonds,
    policy.copies.LR[['light', 'dark'].includes(sr.element) ? 'lightDark' : 'normal'] * 17000);
  for (const item of cost.characterCosts.filter(item => catalog.characters.find(character => character.id === item.characterId)?.baseRarity === 2)) {
    assert.equal(item.diamonds, 0);
    assert.equal(item.rarity, 'LR');
  }
  team = setArcanaPurchased(team, group.id, false, catalog, policy, freeLibrary);
  assert.equal(getArcanaState(team, catalog, policy, freeLibrary).ledger.some(item => item.support && item.position == null), false);
});

test('paid borrowed weapons enforce job, owner eligibility and one-per-owner without free-library eligibility', () => {
  const low = catalog.characters.find(character => character.baseRarity === 2 && character.job === actor.job);
  let team = select(fresh(), low, 0);
  const choices = getBorrowableWeapons(team, 0, catalog, freeLibrary);
  const notGifted = choices.find(weapon => !freeLibrary.exclusiveWeapons.some(gift => gift.characterId === weapon.characterId));
  assert.ok(notGifted);
  team.members[0].equipment[0].weaponOwnerCharacterId = notGifted.characterId;
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  const second = catalog.characters.find(character => character.baseRarity === 8 && character.job === actor.job && character.id !== notGifted.characterId);
  team = select(team, second, 1);
  team.members[1].equipment[0] = { ...team.members[0].equipment[0], runes: team.members[0].equipment[0].runes.map(rune => ({ ...rune })) };
  assert.ok(validateTeam(team, catalog, policy).errors.some(error => error.code === 'DUPLICATE_WEAPON_OWNER'));
  team.members[1].equipment[0] = createEquipment(1);
  team.members[0].equipment[0].weaponOwnerCharacterId = catalog.characters.find(character => character.baseRarity === 8 && character.job !== actor.job).id;
  assert.ok(validateTeam(team, catalog, policy).errors.some(error => error.code === 'BORROWED_WEAPON_JOB_MISMATCH'));
  team.members[0].equipment[0].weaponOwnerCharacterId = low.id;
  assert.ok(validateTeam(team, catalog, policy).errors.some(error => error.code === 'NO_EXCLUSIVE_WEAPON'));
});

test('free mode never discounts the third 450 weapon and forbids hidden synchronization sources', () => {
  const team = fresh();
  team.members = catalog.characters.filter(character => character.baseRarity === 8).slice(0, 3).map(character => {
    const member = createMember(character);
    member.equipment[0] = { ...selectEquipmentRarity(member.equipment[0], 'UR'), weaponKind: 'exclusive', weaponOwnerCharacterId: character.id, level: 450 };
    return member;
  }).concat([null, null]);
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(cost.exclusiveWeaponCosts.length, 3);
  assert.deepEqual(cost.exclusiveWeaponCosts.map(weapon => weapon.billedLevel), [450, 450, 450]);
  assert.equal(new Set(cost.exclusiveWeaponCosts.map(weapon => weapon.fragments)).size, 1);
  assert.equal(deriveWeaponPricing(team, catalog, policy).discountCount, 0);
  assert.deepEqual(deriveWeaponSync(team, catalog, policy, freeLibrary).slots, []);
  team.members[0].equipment[0].syncSlot = 1;
  assert.ok(validateTeam(team, catalog, policy).errors.some(error => error.code === 'DISABLED_WEAPON_SYNC'));
  team.members[0].equipment[0].syncSlot = 0;
  team.weaponSources = [{ characterId: actor.id, characterRarity: 'LR', rarity: 'UR', level: 450 }];
  assert.ok(validateTeam(team, catalog, policy).errors.some(error => error.code === 'DISABLED_WEAPON_SOURCES'));
});

test('free level defaults use only actual legal weapons and never fabricate a low-level exclusive', () => {
  let team = select(fresh(179, 200), actor);
  assert.equal(team.members[0].equipment[0].rarity, 'NONE');
  assert.equal(validateTeam(team, catalog, policy).valid, true);
  const low = catalog.characters.find(character => character.baseRarity === 2);
  team = select(fresh(200, 200), low);
  assert.equal(team.members[0].equipment[0].rarity, 'SSR');
  assert.equal(team.members[0].equipment[0].weaponKind, 'normal');
  assert.equal(team.members[0].equipment[0].level, 180);
  assert.equal(validateTeam(team, catalog, policy).valid, true);
  assert.throws(() => applyEquipmentPreset(team.members[0], 'adaptive4', catalog, getEffectivePolicy(team, policy)), /同职业/);
});

test('free effective levels round-trip without trusting exported prices, free-library or policy snapshots', () => {
  const team = fresh(300, 700);
  team.members = catalog.characters.filter(character => character.baseRarity === 8).slice(0, 5).map(character => createMember(character, { level: 300 }));
  const effective = getEffectivePolicy(team, policy);
  assert.equal(effective.characterLevel, 300);
  assert.equal(effective.baseline.playerLevel, 700);
  assert.equal(effective.baseline.levelLink.level, 300);
  assert.equal(policy.characterLevel, 450);
  const exported = createExport(team, catalog, policy, freeLibrary);
  assert.equal(exported.team.playerLevel, 700);
  assert.equal(exported.policySnapshot.characterLevel, 300);
  assert.equal(exported.freeLibrarySnapshot, undefined);
  exported.policySnapshot = { mode: 'cup', characterLevel: 1, unitPrices: { characterCopy: 0 } };
  exported.freeLibrarySnapshot = freeLibrary;
  exported.costBreakdown.totalDiamonds = 0;
  const imported = parseImport(exported, catalog, policy, freeLibrary);
  assert.deepEqual(imported.team, cloneTeam(team));
  assert.equal(imported.costBreakdown.characterDiamonds, 5 * 17000);
  assert.equal(imported.costBreakdown.totalDiamonds, calculateTeam(team, catalog, policy).totalDiamonds);
});

test('cup plans import into free accounting using the local player default and removing hidden source flags', () => {
  const team = fresh();
  team.members = catalog.characters.filter(character => character.baseRarity === 8).slice(0, 5).map(createMember);
  delete team.playerLevel;
  team.members[0].equipment[0] = { ...selectEquipmentRarity(team.members[0].equipment[0], 'UR'), weaponKind: 'exclusive', level: 450, syncSlot: 1 };
  team.weaponSources = [{ characterId: actor.id, characterRarity: 'LR', rarity: 'UR', level: 300 }];
  const imported = parseImport({ format: 'mementomori-team-plan', schemaVersion: 1, team }, catalog, policy, freeLibrary);
  assert.equal(imported.team.playerLevel, 560);
  assert.deepEqual(imported.team.weaponSources, []);
  assert.equal(imported.team.members[0].equipment[0].syncSlot, 0);
  assert.equal(imported.team.members[0].equipment[0].level, 450);
  assert.ok(imported.warnings.some(warning => warning.includes('自由配队')));
  assert.equal(validateTeam(imported.team, catalog, policy).valid, true);
});

test('free levels reject unsupported bounds and malformed player input', () => {
  for (const [level, playerLevel] of [[0, 560], [1001, 560], [450, 0], [450, 1101], [450.5, 560], [450, '560']]) {
    const validation = validateTeam(fresh(level, playerLevel), catalog, policy);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(error => ['INVALID_FREE_LEVEL', 'INVALID_POLICY'].includes(error.code)));
  }
  assert.equal(validateTeam(fresh(1000, 1100), catalog, policy).valid, true);
  const forgedPolicy = { ...policy, blessings: cupPolicy.blessings };
  assert.equal(validateTeam(fresh(), catalog, forgedPolicy).valid, false);
  assert.equal(validateTeam(fresh(), catalog, { ...policy, runes: cupPolicy.runes }).valid, false);
});
