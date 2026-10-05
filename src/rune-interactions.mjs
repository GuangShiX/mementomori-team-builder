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
