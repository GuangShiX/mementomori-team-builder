// A new rune fills matching empty holes in the same three-slot column.
// Existing and subsequently edited holes are independent.
export function fillColumnEmptyRunes(team, memberIndex, slot, runeIndex, patch, catalog, policy) {
  const member = team.members?.[memberIndex];
  const source = member?.equipment?.[slot - 1];
  if (!source || source.slot !== slot || !Number.isSafeInteger(runeIndex) || runeIndex < 0 || runeIndex >= source.runes.length) throw new RangeError('符石槽位无效。');
  const previous = source.runes[runeIndex];
  const next = { ...previous, ...patch };
  const equipment = member.equipment.map(gear => ({ ...gear, runes: gear.runes.map(rune => ({ ...rune })) }));
  equipment[slot - 1].runes[runeIndex] = next;
  const result = { ...team, members: team.members.map((entry, index) => index === memberIndex ? { ...member, equipment } : entry) };
  const category = catalog.runeCategories?.find(item => item.id === next.categoryId);
  const maximum = policy.limits?.runeLevel ?? 15;
  if (previous.level !== 0 || source.rarity === 'NONE' || !category || !Number.isSafeInteger(next.level) || next.level < 1 || next.level > maximum) return result;
  const allowedSlots = category.allowedSlots ?? category.slots;
  if (!allowedSlots?.includes(slot) || source.runes.some((rune, index) => index !== runeIndex && rune.level > 0 && rune.categoryId === next.categoryId)) return result;
  const stock = policy.runes?.fixedStock;
  const restricted = stock && !stock.excludedCategoryIds.includes(next.categoryId);
  let remaining = Infinity;
  if (restricted) {
    const tiers = stock.tiers ?? [{ level: stock.level, perCategory: stock.perCategory }];
    const tier = tiers.find(item => item.level === next.level);
    if (!tier || !Number.isSafeInteger(tier.perCategory) || tier.perCategory < 0) return result;
    const used = result.members.filter(Boolean).reduce((sum, entry) => sum + entry.equipment.filter(gear => gear.rarity !== 'NONE').reduce((total, gear) => total + gear.runes.filter(rune => rune.categoryId === next.categoryId && rune.level === next.level).length, 0), 0);
    remaining = Math.max(0, tier.perCategory - used);
  }
  const slots = slot <= 3 ? [1, 2, 3] : [4, 5, 6];
  for (const targetSlot of slots) {
    const target = equipment[targetSlot - 1];
    if (targetSlot === slot || target.rarity === 'NONE' || !allowedSlots.includes(targetSlot) || target.runes[runeIndex]?.level !== 0 || remaining <= 0) continue;
    if (target.runes.some(rune => rune.level > 0 && rune.categoryId === next.categoryId)) continue;
    target.runes[runeIndex] = { ...next };
    remaining--;
  }
  return result;
}

// Only this newly filled cohort follows its source until the UI finishes editing.
// The record stays outside the saved team; manual edits detach individual targets.
export function updateColumnRune(team, memberIndex, slot, runeIndex, patch, catalog, policy, { batch = null, kind = 'level' } = {}) {
  const member = team.members?.[memberIndex];
  const source = member?.equipment?.[slot - 1];
  if (!source || source.slot !== slot || !Number.isSafeInteger(runeIndex) || runeIndex < 0 || runeIndex >= source.runes.length) throw new RangeError('符石槽位无效。');
  const previous = source.runes[runeIndex];
  const next = { ...previous, ...patch };
  const column = slot <= 3 ? [1, 2, 3] : [4, 5, 6];
  if (kind === 'category' && previous.level === 0 && next.level > 0) {
    const filled = fillColumnEmptyRunes(team, memberIndex, slot, runeIndex, patch, catalog, policy);
    const targets = column.filter(targetSlot => targetSlot !== slot).flatMap(targetSlot => {
      const before = member.equipment[targetSlot - 1].runes[runeIndex];
      const after = filled.members[memberIndex].equipment[targetSlot - 1].runes[runeIndex];
      return before.level === 0 && after.level === next.level && after.categoryId === next.categoryId
        ? [{ slot: targetSlot, runeIndex, level: after.level }] : [];
    });
    return { team: filled, batch: targets.length ? { memberIndex, characterId: member.characterId, slot, runeIndex, categoryId: next.categoryId, targets } : null };
  }
  const equipment = member.equipment.map(gear => ({ ...gear, runes: gear.runes.map(rune => ({ ...rune })) }));
  equipment[slot - 1].runes[runeIndex] = next;
  const result = { ...team, members: team.members.map((entry, index) => index === memberIndex ? { ...member, equipment } : entry) };
  if (!batch || batch.memberIndex !== memberIndex || batch.characterId !== member.characterId) return { team: result, batch: null };
  const batchSource = member.equipment[batch.slot - 1];
  if (batchSource?.rarity === 'NONE' || batchSource?.runes[batch.runeIndex]?.categoryId !== batch.categoryId) return { team: result, batch: null };
  const isSource = batch.slot === slot && batch.runeIndex === runeIndex;
  if (isSource && (kind === 'category' || next.categoryId !== batch.categoryId)) return { team: result, batch: null };
  const category = catalog.runeCategories.find(item => item.id === batch.categoryId);
  const allowedSlots = category?.allowedSlots ?? category?.slots ?? [];
  const batchColumn = batch.slot <= 3 ? [1, 2, 3] : [4, 5, 6];
  const targets = batch.targets.filter(target => {
    const gear = equipment[target.slot - 1];
    const rune = gear?.runes[target.runeIndex];
    return !(target.slot === slot && target.runeIndex === runeIndex)
      && target.slot !== batch.slot && target.runeIndex === batch.runeIndex && batchColumn.includes(target.slot)
      && gear?.rarity !== 'NONE' && allowedSlots.includes(target.slot)
      && rune?.categoryId === batch.categoryId && rune.level === target.level
      && !gear.runes.some((other, index) => index !== target.runeIndex && other.level > 0 && other.categoryId === batch.categoryId);
  }).map(target => ({ ...target }));
  if (!targets.length) return { team: result, batch: null };
  const nextBatch = { ...batch, targets };
  const validLevel = Number.isSafeInteger(next.level) && next.level > 0 && next.level <= (policy.limits?.runeLevel ?? 15);
  if (!isSource || !validLevel || !allowedSlots.includes(slot)
    || source.runes.some((other, index) => index !== runeIndex && other.level > 0 && other.categoryId === next.categoryId)) return { team: result, batch: nextBatch };
  const stock = policy.runes?.fixedStock;
  const restricted = stock && !stock.excludedCategoryIds.includes(next.categoryId);
  const tier = restricted ? (stock.tiers ?? [{ level: stock.level, perCategory: stock.perCategory }]).find(item => item.level === next.level) : null;
  if (restricted && (!tier || !Number.isSafeInteger(tier.perCategory) || tier.perCategory < 0)) return { team: result, batch: nextBatch };
  for (const target of targets) {
    const rune = equipment[target.slot - 1].runes[target.runeIndex];
    if (rune.level === next.level) continue;
    const used = restricted ? result.members.filter(Boolean).reduce((sum, entry) => sum + entry.equipment.filter(gear => gear.rarity !== 'NONE').reduce((total, gear) => total + gear.runes.filter(item => item.categoryId === next.categoryId && item.level === next.level).length, 0), 0) : 0;
    if (restricted && used >= tier.perCategory) continue;
    rune.level = next.level;
    target.level = next.level;
  }
  return { team: result, batch: nextBatch };
}
