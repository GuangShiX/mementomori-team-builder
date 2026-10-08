import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTeam, createMember, calculateTeam, validateTeam, getArcanaState, getBorrowableWeapons, selectEquipmentRarity, createExport, parseImport } from '../src/domain.mjs';
import { placeRosterCharacter } from '../src/team-interactions.mjs';
import { applyEquipmentPreset, changeMemberRarity } from '../src/equipment-presets.mjs';
import { calculateCharacterStats } from '../src/character-stats.mjs';

const [baseCatalog, policy, freeLibrary, arcana, equipmentBonuses, characterStats] = await Promise.all(
  ['catalog', 'pricing-policy', 'free-library', 'arcana-catalog', 'equipment-bonuses', 'character-stats'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))),
);
const catalog = { ...baseCatalog, arcana, equipmentBonuses, characterStats };
const lowCharacters = catalog.characters.filter(character => [1, 2].includes(character.baseRarity));
const select = (team, character, index) => placeRosterCharacter(team, character, index, { catalog, freeLibrary }).team;

test('all sixteen real R and N choices start at their configured rarity, have free bodies and use valid borrowed weapons', () => {
  assert.equal(lowCharacters.filter(character => character.baseRarity === 2).length, 12);
  assert.equal(lowCharacters.filter(character => character.baseRarity === 1).length, 4);
  for (const character of lowCharacters) {
    const team = select(createTeam(), character, 0);
    const member = team.members[0];
    assert.equal(member.rarity, character.baseRarity === 2 ? 'LR5' : 'N');
    assert.equal(createMember(character).rarity, member.rarity);
    assert.equal(member.equipment[0].rarity, 'UR');
    assert.notEqual(member.equipment[0].weaponOwnerCharacterId, character.id);
    const owner = catalog.characters.find(item => item.id === member.equipment[0].weaponOwnerCharacterId);
    assert.equal(owner.job, character.job);
    assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
    const cost = calculateTeam(team, catalog, policy, freeLibrary);
    assert.equal(cost.characterCosts.find(item => item.characterId === character.id).diamonds, 0);
    assert.equal(cost.teamDiamondAllowance, 100000);
    const stats = calculateCharacterStats(member, catalog, policy, getArcanaState(team, catalog, policy, freeLibrary));
    assert.equal(stats.valid, true, JSON.stringify(stats.errors));
  }
});

test('R and N never invent their own exclusive weapon and unavailable gifts remain empty without duplicate claims', () => {
  const actor = lowCharacters.find(character => character.job === 4 && character.baseRarity === 2);
  let team = createTeam();
  for (const weapon of freeLibrary.exclusiveWeapons.filter(weapon => weapon.rarity === 'UR' && catalog.characters.find(item => item.id === weapon.characterId).job === actor.job)) {
    team = select(team, catalog.characters.find(item => item.id === weapon.characterId), team.members.findIndex(member => !member));
  }
  const index = team.members.findIndex(member => !member);
  team = select(team, actor, index);
  assert.equal(getBorrowableWeapons(team, index, catalog, freeLibrary).length, 0);
  assert.equal(team.members[index].equipment[0].rarity, 'NONE');
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  assert.throws(() => applyEquipmentPreset(team.members[index], 'adaptive4', catalog, policy), /同职业可借用/);
  const forged = structuredClone(team);
  forged.members[index].equipment[0] = { ...selectEquipmentRarity(forged.members[index].equipment[0], 'UR'), weaponKind: 'exclusive', weaponOwnerCharacterId: actor.id, level: 240 };
  assert.ok(validateTeam(forged, catalog, policy, { freeLibrary }).errors.some(error => error.code === 'NO_EXCLUSIVE_WEAPON'));
});

test('replacing a geared SR with R retains a compatible gifted weapon, while returning from N never retains the N rarity', () => {
  const gift = freeLibrary.exclusiveWeapons.find(weapon => weapon.rarity === 'UR');
  const owner = catalog.characters.find(character => character.id === gift.characterId);
  const actor = lowCharacters.find(character => character.baseRarity === 2 && character.job === owner.job);
  let team = select(createTeam(), owner, 0);
  team.members[0] = applyEquipmentPreset(team.members[0], 'adaptive4', catalog, policy);
  team.members[0].equipment[0].legendSacredTreasureLevel = 10;
  const originalWeapon = team.members[0].equipment[0];
  team = select(team, actor, 0);
  assert.equal(team.members[0].rarity, 'LR5');
  assert.equal(team.members[0].equipment[0].weaponOwnerCharacterId, owner.id);
  assert.equal(team.members[0].equipment[0].level, originalWeapon.level);
  assert.equal(team.members[0].equipment[0].legendSacredTreasureLevel, 10);
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  team = select(team, lowCharacters.find(character => character.baseRarity === 1 && character.job === owner.job), 0);
  assert.equal(team.members[0].rarity, 'N');
  team = select(team, owner, 0);
  assert.equal(team.members[0].rarity, 'SR');
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
});

test('a five-member real build shares one universal allowance and roundtrips without trusting the exported quote', () => {
  const r = lowCharacters.find(character => character.baseRarity === 2);
  const n = lowCharacters.find(character => character.baseRarity === 1);
  const paid = catalog.characters.filter(character => character.baseRarity === 8 && !freeLibrary.characters.some(item => item.characterId === character.id)).slice(0, 3);
  let team = select(select(createTeam(), r, 0), n, 1);
  paid.forEach((character, i) => { team = select(team, character, i + 2); team.members[i + 2] = changeMemberRarity(team.members[i + 2], 'LR', catalog); });
  const plainPolicy = structuredClone(policy);
  delete plainPolicy.blessings.find(blessing => blessing.id === 'crystal-diamond-grace').teamDiamondAllowance;
  const before = calculateTeam(team, catalog, plainPolicy, freeLibrary);
  const after = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(after.teamDiamondAllowance, 100000);
  assert.equal(after.teamDiamondAllowanceCredit, 100000);
  assert.equal(after.totalDiamonds, before.totalDiamonds - 100000);
  assert.equal(after.memberCosts.reduce((sum, member) => sum + member.rawTotalDiamonds, 0) + after.rawOffTeamDiamonds, after.totalDiamonds);
  assert.equal(after.resources.reinforcementMedicine.consumed, before.resources.reinforcementMedicine.consumed);
  const exported = createExport(team, catalog, policy, freeLibrary);
  exported.costBreakdown.totalDiamonds = 0;
  exported.policySnapshot.blessings.find(blessing => blessing.id === 'crystal-diamond-grace').teamDiamondAllowance.amount = 9999999;
  const imported = parseImport(exported, catalog, policy, freeLibrary);
  assert.equal(imported.team.members[0].rarity, 'LR5');
  assert.equal(imported.team.members[1].rarity, 'N');
  assert.equal(imported.costBreakdown.totalDiamonds, after.totalDiamonds);
});

test('joining a borrowed weapon owner never equips a second copy, for both addition and replacement', () => {
  for (const baseRarity of [1, 2]) {
    const actor = lowCharacters.find(character => character.baseRarity === baseRarity);
    const start = select(createTeam(), actor, 0);
    const borrowedOwnerId = start.members[0].equipment[0].weaponOwnerCharacterId;
    const owner = catalog.characters.find(character => character.id === borrowedOwnerId);
    for (const library of [freeLibrary, { ...freeLibrary, exclusiveWeapons: freeLibrary.exclusiveWeapons.filter(weapon => weapon.characterId === owner.id) }]) {
      const added = placeRosterCharacter(start, owner, 1, { catalog, freeLibrary: library }).team;
      assert.equal(validateTeam(added, catalog, policy, { freeLibrary: library }).valid, true);
      assert.equal(added.members[0].equipment[0].weaponOwnerCharacterId, borrowedOwnerId);
      assert.notEqual(added.members[1].equipment[0].weaponOwnerCharacterId, borrowedOwnerId);
      calculateTeam(added, catalog, policy, library);
      const other = catalog.characters.find(character => character.baseRarity === 8 && character.job === owner.job && character.id !== owner.id && !freeLibrary.exclusiveWeapons.some(weapon => weapon.characterId === character.id));
      const beforeReplacement = placeRosterCharacter(start, other, 1, { catalog, freeLibrary: library }).team;
      const replaced = placeRosterCharacter(beforeReplacement, owner, 1, { catalog, freeLibrary: library }).team;
      assert.equal(validateTeam(replaced, catalog, policy, { freeLibrary: library }).valid, true);
      assert.notEqual(replaced.members[1].equipment[0].weaponOwnerCharacterId, borrowedOwnerId);
      assert.equal(beforeReplacement.members[1].equipment[0].weaponOwnerCharacterId, other.id);
      calculateTeam(replaced, catalog, policy, library);
    }
  }
});

test('only actual low-rarity team members promote their owned arcana tier and activate the universal allowance', () => {
  const empty = createTeam();
  const freeState = getArcanaState(empty, catalog, policy, freeLibrary);
  const support = arcana.supportCharacters[0];
  assert.equal(freeState.ledger.find(character => character.characterId === support.id).rarity, 'LR');
  assert.equal(calculateTeam(empty, catalog, policy, freeLibrary).teamDiamondAllowance, 0);
  const selected = select(empty, catalog.characters.find(character => character.id === support.id), 0);
  assert.equal(getArcanaState(selected, catalog, policy, freeLibrary).ledger.find(character => character.characterId === support.id).rarity, 'LR5');
  selected.members[0] = null;
  assert.equal(calculateTeam(selected, catalog, policy, freeLibrary).teamDiamondAllowance, 0);
});
