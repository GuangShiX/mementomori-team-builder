import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember, createTeam } from '../src/domain.mjs';
import { fillColumnEmptyRunes } from '../src/rune-interactions.mjs';
const [catalog, policy] = await Promise.all(['catalog', 'pricing-policy'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
function equipped() {
  const team = createTeam(); team.members[0] = createMember(8);
  for (const gear of team.members[0].equipment) gear.rarity = 'SSR';
  return team;
}

test('first rune installation copies its category and level to matching empty holes in its column without mutating the original', () => {
  const team = equipped();
  const result = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: 3, level: 11 }, catalog, policy);
  assert.deepEqual(result.members[0].equipment.map(gear => gear.runes[0].level), [11, 11, 11, 0, 0, 0]);
  assert.deepEqual(result.members[0].equipment.slice(0, 3).map(gear => gear.runes[0].categoryId), [3, 3, 3]);
  assert.ok(team.members[0].equipment.every(gear => gear.runes[0].level === 0));
  const defense = catalog.runeCategories.find(category => category.slots.includes(4));
  const right = fillColumnEmptyRunes(team, 0, 5, 2, { categoryId: defense.id, level: 10 }, catalog, policy);
  assert.deepEqual(right.members[0].equipment.map(gear => gear.runes[2].level), [0, 0, 0, 10, 10, 10]);
});

test('occupied holes, duplicate categories and unequipped slots are never replaced or invisibly equipped', () => {
  const team = equipped();
  team.members[0].equipment[1].runes[0] = { categoryId: 1, level: 11 };
  team.members[0].equipment[2].runes[1] = { categoryId: 3, level: 10 };
  const result = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: 3, level: 11 }, catalog, policy);
  assert.deepEqual(result.members[0].equipment[1].runes[0], { categoryId: 1, level: 11 });
  assert.equal(result.members[0].equipment[2].runes[0].level, 0);
  team.members[0].equipment[1].rarity = 'NONE';
  assert.equal(fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: 2, level: 11 }, catalog, policy).members[0].equipment[1].runes[0].categoryId, 1);
});

test('automatic copies obey the shared stock of their exact level and do not borrow the other tier', () => {
  const team = equipped();
  team.members[1] = createMember(27); team.members[1].equipment[0].rarity = 'SSR';
  team.members[1].equipment[0].runes[0] = { categoryId: 3, level: 11 };
  const result = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: 3, level: 11 }, catalog, policy);
  assert.deepEqual(result.members[0].equipment.slice(0, 3).map(gear => gear.runes[0].level), [11, 11, 0]);
  const otherTier = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: 3, level: 10 }, catalog, policy);
  assert.deepEqual(otherTier.members[0].equipment.slice(0, 3).map(gear => gear.runes[0].level), [10, 10, 10]);
});

test('later per-hole adjustments and clearing stay independent, while ticket runes copy their initial freely chosen level', () => {
  const team = equipped();
  const first = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: 3, level: 11 }, catalog, policy);
  const tuned = fillColumnEmptyRunes(first, 0, 2, 0, { level: 10 }, catalog, policy);
  assert.deepEqual(tuned.members[0].equipment.slice(0, 3).map(gear => gear.runes[0].level), [11, 10, 11]);
  const cleared = fillColumnEmptyRunes(tuned, 0, 1, 0, { level: 0 }, catalog, policy);
  assert.deepEqual(cleared.members[0].equipment.slice(0, 3).map(gear => gear.runes[0].level), [0, 10, 11]);
  const tickets = fillColumnEmptyRunes(team, 0, 1, 3, { categoryId: 5, level: 13 }, catalog, policy);
  assert.deepEqual(tickets.members[0].equipment.slice(0, 3).map(gear => gear.runes[3].level), [13, 13, 13]);
});
