import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember, createTeam } from '../src/domain.mjs';
import { fillColumnEmptyRunes, updateColumnRune } from '../src/rune-interactions.mjs';
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

const levels = (team, runeIndex = 0) => team.members[0].equipment.map(gear => gear.runes[runeIndex].level);
const choose = (team, slot = 1, categoryId = 9, level = 1, runeIndex = 0) => updateColumnRune(team, 0, slot, runeIndex, { categoryId, level }, catalog, policy, { kind: 'category' });
const tune = (current, slot, level, runeIndex = 0) => updateColumnRune(current.team, 0, slot, runeIndex, { level }, catalog, policy, { batch: current.batch });

test('a newly selected speed rune follows its source level without mutating the team or previous batch', () => {
  const team = equipped();
  const original = JSON.stringify(team);
  const chosen = choose(team);
  assert.deepEqual(levels(chosen.team), [1, 1, 1, 0, 0, 0]);
  assert.deepEqual(chosen.batch, { memberIndex: 0, characterId: 8, slot: 1, runeIndex: 0, categoryId: 9, targets: [{ slot: 2, runeIndex: 0, level: 1 }, { slot: 3, runeIndex: 0, level: 1 }] });
  const snapshot = JSON.stringify(chosen);
  const adjusted = tune(chosen, 1, 10);
  assert.deepEqual(levels(adjusted.team), [10, 10, 10, 0, 0, 0]);
  assert.deepEqual(adjusted.batch.targets.map(target => target.level), [10, 10]);
  assert.equal(JSON.stringify(team), original);
  assert.equal(JSON.stringify(chosen), snapshot);
});

test('pre-existing holes never join the cohort and manually edited targets detach even when given the same value', () => {
  const existing = equipped();
  existing.members[0].equipment[1].runes[0] = { categoryId: 9, level: 7 };
  const chosen = choose(existing);
  assert.deepEqual(chosen.batch.targets.map(target => target.slot), [3]);
  assert.deepEqual(levels(tune(chosen, 1, 10).team), [10, 7, 10, 0, 0, 0]);
  for (const manualLevel of [1, 7]) {
    const started = choose(equipped());
    const edited = tune(started, 2, manualLevel);
    assert.deepEqual(edited.batch.targets.map(target => target.slot), [3]);
    assert.deepEqual(levels(tune(edited, 1, 10).team), [10, manualLevel, 10, 0, 0, 0]);
  }
});

test('temporarily clearing the source number preserves the cohort until a valid complete level is entered', () => {
  const chosen = choose(equipped());
  const empty = tune(chosen, 1, 0);
  assert.deepEqual(levels(empty.team), [0, 1, 1, 0, 0, 0]);
  assert.deepEqual(empty.batch, chosen.batch);
  const partial = tune(empty, 1, 1);
  assert.deepEqual(levels(partial.team), [1, 1, 1, 0, 0, 0]);
  const completed = tune(partial, 1, 10);
  assert.deepEqual(levels(completed.team), [10, 10, 10, 0, 0, 0]);
  const independent = updateColumnRune(completed.team, 0, 1, 0, { level: 12 }, catalog, policy);
  assert.equal(independent.batch, null);
  assert.deepEqual(levels(independent.team), [12, 10, 10, 0, 0, 0]);
  const cleared = updateColumnRune(completed.team, 0, 1, 0, { level: 0 }, catalog, policy, { batch: completed.batch, kind: 'category' });
  assert.equal(cleared.batch, null);
  assert.deepEqual(levels(cleared.team), [0, 10, 10, 0, 0, 0]);
  const changed = updateColumnRune(completed.team, 0, 1, 0, { categoryId: 5 }, catalog, policy, { batch: completed.batch, kind: 'category' });
  assert.equal(changed.batch, null);
  assert.equal(changed.team.members[0].equipment[1].runes[0].categoryId, 9);
});

test('following ordinary runes uses only the exact destination tier stock and leaves unavailable targets unchanged', () => {
  const team = equipped();
  team.members[1] = createMember(27);
  team.members[1].equipment[0].rarity = 'SSR';
  team.members[1].equipment[0].runes[0] = { categoryId: 3, level: 10 };
  const chosen = choose(team, 1, 3, 11);
  const changed = tune(chosen, 1, 10);
  assert.deepEqual(levels(changed.team), [10, 10, 11, 0, 0, 0]);
  assert.deepEqual(changed.batch.targets.map(target => target.level), [10, 11]);
  assert.equal(changed.team.members[1].equipment[0].runes[0].level, 10);
  const returned = tune(changed, 1, 11);
  assert.deepEqual(levels(returned.team), [11, 11, 11, 0, 0, 0]);
});

test('right-column batches follow only their actual generated holes and discard stale or incompatible targets', () => {
  const defense = catalog.runeCategories.find(category => category.slots.includes(4));
  const chosen = choose(equipped(), 5, defense.id, 11, 2);
  assert.deepEqual(chosen.batch.targets.map(target => target.slot), [4, 6]);
  const changed = tune(chosen, 5, 10, 2);
  assert.deepEqual(levels(changed.team, 2), [0, 0, 0, 10, 10, 10]);
  const stale = choose(equipped());
  stale.team.members[0].characterId = 27;
  const mismatched = tune(stale, 1, 10);
  assert.equal(mismatched.batch, null);
  assert.deepEqual(levels(mismatched.team), [10, 1, 1, 0, 0, 0]);
  const constrained = choose(equipped());
  constrained.team.members[0].equipment[1].rarity = 'NONE';
  constrained.team.members[0].equipment[2].runes[1] = { categoryId: 9, level: 8 };
  const skipped = tune(constrained, 1, 10);
  assert.equal(skipped.batch, null);
  assert.deepEqual(levels(skipped.team), [10, 1, 1, 0, 0, 0]);
});
