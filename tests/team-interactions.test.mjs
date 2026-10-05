import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember, createTeam, calculateTeam } from '../src/domain.mjs';
import { addRosterCharacter, equipReserveWeapon, placeRosterCharacter, rosterDoubleClick, swapTeamPositions } from '../src/team-interactions.mjs';

test('dragging a team position carries its complete gear and keeps selection on the moved character', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[1] = createMember(2);
  team.members[0].equipment[0].runes[0] = { categoryId: 5, level: 13 };
  const result = swapTeamPositions(team, 0, 1, 0);
  assert.equal(result.team.members[1], team.members[0]);
  assert.equal(result.team.members[0], team.members[1]);
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.team.members[1].equipment[0].runes[0].level, 13);
  assert.equal(team.members[0].characterId, 1);
});

test('moving a selected destination keeps its identity and moving into an empty slot preserves it', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[1] = createMember(2);
  assert.equal(swapTeamPositions(team, 0, 1, 1).selectedIndex, 0);
  const result = swapTeamPositions(team, 1, 4, 1);
  assert.equal(result.team.members[1], null);
  assert.equal(result.team.members[4], team.members[1]);
  assert.equal(result.selectedIndex, 4);
  assert.equal(swapTeamPositions(team, 1, 5, 1).changed, false);
});

test('dropping a new roster character replaces only its identity and keeps the destination build', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[1] = createMember(2);
  team.members[0].equipment[0].weaponKind = 'exclusive';
  team.members[0].rarity = 'LR5';
  team.members[0].equipment[1].runes[0] = { categoryId: 5, level: 12 };
  const result = placeRosterCharacter(team, { id: 3 }, 0);
  assert.equal(result.team.members[0].characterId, 3);
  assert.equal(result.team.members[0].rarity, 'LR5');
  assert.equal(result.team.members[0].equipment, team.members[0].equipment);
  assert.equal(result.team.members[0].equipment[0].weaponKind, 'exclusive');
  assert.deepEqual(result.team.members[0].equipment[1].runes[0], { categoryId: 5, level: 12 });
  assert.equal(result.team.members[1], team.members[1]);
});

test('dropping an already chosen character swaps it instead of creating a duplicate', () => {
  const team = createTeam();
  team.members[0] = createMember(1);
  team.members[1] = createMember(2);
  const result = placeRosterCharacter(team, { id: 1 }, 1);
  assert.deepEqual(result.team.members.slice(0, 2).map(member => member.characterId), [2, 1]);
  assert.equal(result.team.members[1], team.members[0]);
  assert.equal(result.selectedIndex, 1);
});

test('doubleclick replaces the original selected position without retaining the preceding singleclick add', () => {
  const beforeClick = createTeam();
  beforeClick.members[1] = createMember(1);
  const single = addRosterCharacter(beforeClick, { id: 2 });
  assert.equal(single.team.members.filter(Boolean).length, 2);
  const result = rosterDoubleClick(beforeClick, { id: 2 }, 1);
  assert.equal(result.team.members.filter(Boolean).length, 1);
  assert.equal(result.team.members[1].characterId, 2);
  assert.equal(result.team.members[0], null);
});

test('full-team doubleclick remains usable while singleclick still reports capacity', () => {
  const team = createTeam();
  team.members = [1, 2, 3, 4, 5].map(createMember);
  assert.equal(addRosterCharacter(team, { id: 6 }).full, true);
  assert.equal(rosterDoubleClick(team, { id: 6 }, 2).team.members[2].characterId, 6);
  assert.equal(rosterDoubleClick(createTeam(), { id: 1 }, -1).team.members[0].characterId, 1);
});

test('replacement keeps the equipped exclusive weapon but recalculates the new character free entitlement', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url)));
  const policy = JSON.parse(await readFile(new URL('../public/data/pricing-policy.json', import.meta.url)));
  const freeLibrary = JSON.parse(await readFile(new URL('../public/data/free-library.json', import.meta.url)));
  const team = createTeam();
  team.members[0] = createMember(124);
  const weapon = team.members[0].equipment[0];
  Object.assign(weapon, { rarity: 'SSR', seriesId: 12, weaponKind: 'exclusive', level: 240 });
  const before = calculateTeam(team, catalog, policy, freeLibrary);
  assert.equal(before.exclusiveWeaponCosts[0].diamonds, 0);
  const candidate = catalog.characters.find(character => !freeLibrary.characters.some(entry => entry.characterId === character.id));
  const replaced = placeRosterCharacter(team, candidate, 0);
  const after = calculateTeam(replaced.team, catalog, policy, freeLibrary);
  assert.equal(replaced.team.members[0].equipment[0], weapon);
  assert.equal(after.exclusiveWeaponCosts[0].characterId, candidate.id);
  assert.ok(after.exclusiveWeaponCosts[0].diamonds > 0);
  assert.ok(after.totalDiamonds > before.totalDiamonds);
});

test('explicitly equipping a conflicting reserve weapon preserves runes and sacred upgrades and removes only that reserve', () => {
  const team = createTeam();
  team.members[2] = createMember(27);
  Object.assign(team.members[2].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', weaponOwnerCharacterId: 27, level: 300, reinforcementLevel: 400, syncSlot: 1, legendSacredTreasureLevel: 20, matchlessSacredTreasureLevel: 17 });
  const runes = team.members[2].equipment[0].runes;
  team.weaponSources = [{ characterId: 27, characterRarity: 'LR5', rarity: 'UR', level: 320 }, { characterId: 8, characterRarity: 'LR5', rarity: 'UR', level: 300 }];
  const result = equipReserveWeapon(team, 0);
  const weapon = result.members[2].equipment[0];
  assert.equal(result.members[2].rarity, 'LR5');
  assert.equal(weapon.rarity, 'UR');
  assert.equal(weapon.weaponKind, 'exclusive');
  assert.equal(weapon.level, 320);
  assert.equal(weapon.reinforcementLevel, 320);
  assert.equal(weapon.syncSlot, 0);
  assert.equal(weapon.legendSacredTreasureLevel, 20);
  assert.equal(weapon.matchlessSacredTreasureLevel, 17);
  assert.equal(weapon.runes, runes);
  assert.deepEqual(result.weaponSources, [team.weaponSources[1]]);
  assert.equal(team.weaponSources.length, 2);
  assert.equal(equipReserveWeapon(team, 1), team, 'a reserve whose character is not in the team remains untouched');
});

test('new UI members first equip their own free weapon, including the promised SSR 180 gifts', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url)));
  const freeLibrary = JSON.parse(await readFile(new URL('../public/data/free-library.json', import.meta.url)));
  const character = catalog.characters.find(character => character.id === 85);
  const added = addRosterCharacter(createTeam(), character, { catalog, freeLibrary });
  const weapon = added.team.members[0].equipment[0];
  assert.equal(weapon.weaponKind, 'exclusive');
  assert.equal(weapon.weaponOwnerCharacterId, 85);
  assert.equal(weapon.rarity, 'SSR');
  assert.equal(weapon.level, 180);
  assert.equal(weapon.matchlessSacredTreasureLevel, 40);
  assert.deepEqual(added.team.members[0].equipment.slice(1).map(gear => gear.matchlessSacredTreasureLevel), [0, 0, 0, 0, 0]);
});

test('a member without its own free weapon borrows the highest available compatible UR without duplicate claims', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url)));
  const freeLibrary = JSON.parse(await readFile(new URL('../public/data/free-library.json', import.meta.url)));
  const candidates = catalog.characters.filter(character => character.job === 1 && !freeLibrary.exclusiveWeapons.some(gift => gift.characterId === character.id));
  const first = addRosterCharacter(createTeam(), candidates[0], { catalog, freeLibrary });
  const second = addRosterCharacter(first.team, candidates[1], { catalog, freeLibrary });
  const firstWeapon = second.team.members[0].equipment[0];
  const secondWeapon = second.team.members[1].equipment[0];
  assert.equal(firstWeapon.rarity, 'UR');
  assert.equal(firstWeapon.level, 300);
  assert.equal(firstWeapon.matchlessSacredTreasureLevel, 40);
  assert.equal(secondWeapon.rarity, 'UR');
  assert.equal(secondWeapon.level, 240);
  assert.equal(secondWeapon.matchlessSacredTreasureLevel, 40);
  assert.notEqual(firstWeapon.weaponOwnerCharacterId, secondWeapon.weaponOwnerCharacterId);
  assert.equal(catalog.characters.find(character => character.id === firstWeapon.weaponOwnerCharacterId).job, candidates[0].job);
});

test('replacement retains compatible borrowed gear but switches an incompatible owner back to the new actor', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url)));
  const freeLibrary = JSON.parse(await readFile(new URL('../public/data/free-library.json', import.meta.url)));
  const noGifts = catalog.characters.filter(character => !freeLibrary.exclusiveWeapons.some(gift => gift.characterId === character.id));
  const firstActor = noGifts.find(character => character.job === 1);
  const sameJobActor = noGifts.find(character => character.job === 1 && character.id !== firstActor.id);
  const otherJobActor = noGifts.find(character => character.job !== 1);
  const added = addRosterCharacter(createTeam(), firstActor, { catalog, freeLibrary });
  const originalWeapon = added.team.members[0].equipment[0];
  originalWeapon.matchlessSacredTreasureLevel = 17;
  const same = placeRosterCharacter(added.team, sameJobActor, 0, { catalog, freeLibrary });
  assert.equal(same.team.members[0].equipment[0].weaponOwnerCharacterId, originalWeapon.weaponOwnerCharacterId);
  assert.equal(same.team.members[0].equipment[0].matchlessSacredTreasureLevel, 17);
  const different = placeRosterCharacter(same.team, otherJobActor, 0, { catalog, freeLibrary });
  assert.equal(different.team.members[0].equipment[0].weaponOwnerCharacterId, otherJobActor.id);
  assert.equal(different.team.members[0].equipment[0].level, originalWeapon.level);
  assert.equal(different.team.members[0].equipment[0].rarity, originalWeapon.rarity);
  assert.equal(different.team.members[0].equipment[0].matchlessSacredTreasureLevel, 17);
});

test('new members without an available free weapon initialize only their paid weapon at magic armor forty', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url)));
  const character = catalog.characters[0];
  const added = addRosterCharacter(createTeam(), character, { catalog, freeLibrary: { characters: [], exclusiveWeapons: [] } });
  const weapon = added.team.members[0].equipment[0];
  assert.equal(weapon.rarity, 'SSR');
  assert.equal(weapon.weaponOwnerCharacterId, character.id);
  assert.equal(weapon.level, 180);
  assert.equal(weapon.matchlessSacredTreasureLevel, 40);
  assert.deepEqual(added.team.members[0].equipment.slice(1).map(gear => gear.matchlessSacredTreasureLevel), [0, 0, 0, 0, 0]);
  weapon.matchlessSacredTreasureLevel = 0;
  const replacement = catalog.characters.find(candidate => candidate.id !== character.id);
  const replaced = placeRosterCharacter(added.team, replacement, 0, { catalog, freeLibrary: { characters: [], exclusiveWeapons: [] } });
  assert.equal(replaced.team.members[0].equipment[0].matchlessSacredTreasureLevel, 0);
});
