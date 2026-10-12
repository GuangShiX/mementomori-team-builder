import { createMember, createEquipment, isWeaponOwnerClaimed, selectEquipmentRarity, getArcanaRequiredRarity, getBorrowableWeapons } from './domain.mjs';

const validPosition = (team, index) => Number.isInteger(index) && index >= 0 && index < team.members.length;

// Standings move the complete member, including all gear and runes.
export function swapTeamPositions(team, from, to, selectedIndex) {
  if (!validPosition(team, from) || !validPosition(team, to) || from === to || !team.members[from]) {
    return { team, selectedIndex, changed: false };
  }
  const members = [...team.members];
  [members[from], members[to]] = [members[to], members[from]];
  const selected = selectedIndex === from ? to : selectedIndex === to ? from : selectedIndex;
  return { team: { ...team, members }, selectedIndex: selected, changed: true };
}

export function placeRosterCharacter(team, character, targetIndex, { catalog, freeLibrary, policy } = {}) {
  if (!validPosition(team, targetIndex)) return { team, selectedIndex: targetIndex, changed: false };
  const existing = team.members.findIndex(member => member?.characterId === character.id);
  if (existing === targetIndex) return { team, selectedIndex: targetIndex, changed: false };
  if (existing !== -1) {
    const moved = swapTeamPositions(team, existing, targetIndex, existing);
    return { ...moved, selectedIndex: targetIndex };
  }
  const members = [...team.members];
  const previous = members[targetIndex];
  const free = policy?.mode === 'free' || catalog?.mode === 'free';
  members[targetIndex] = previous ? { ...previous, characterId: character.id } : createMember(character, free ? { level: team.level } : {});
  const hasOwnWeapon = character.hasExclusiveWeapon !== false && ![1, 2].includes(character.baseRarity);
  if (!hasOwnWeapon) members[targetIndex].rarity = character.defaultRarity ?? (character.baseRarity === 2 ? 'LR5' : 'N');
  else if (previous && !(character.allowedRarities ?? ['SR', 'LR', 'LR5']).includes(previous.rarity)) members[targetIndex].rarity = character.defaultRarity ?? 'SR';
  if (catalog && members[targetIndex].rarity === 'SR' && getArcanaRequiredRarity(team, character.id, catalog)) members[targetIndex].rarity = 'LR';
  if (catalog) {
    if (free) return placeFreeWeapon(team, members, character, targetIndex, previous, catalog, hasOwnWeapon);
    if (previous) {
      const weapon = previous.equipment[0];
      const ownerId = weapon.weaponOwnerCharacterId ?? previous.characterId;
      const owner = catalog.characters.find(item => item.id === ownerId);
      const ownerGift = freeLibrary?.exclusiveWeapons?.find(item => item.characterId === ownerId && item.rarity === 'UR');
      const keepBorrow = (hasOwnWeapon ? ownerId !== previous.characterId : Boolean(ownerGift) && ['UR', 'LR'].includes(weapon.rarity)) && owner?.job === character.job;
      const nextOwner = keepBorrow ? ownerId : character.id;
      members[targetIndex].equipment = previous.equipment.map(gear => gear.slot === 1 ? { ...gear, weaponOwnerCharacterId: nextOwner } : gear);
      if (weapon.rarity !== 'NONE' && weapon.weaponKind === 'exclusive' && ((!hasOwnWeapon && !keepBorrow) || isWeaponOwnerClaimed(team, targetIndex, nextOwner))) {
        const borrow = getBorrowableWeapons({ ...team, members }, targetIndex, catalog, freeLibrary)[0];
        members[targetIndex].equipment[0] = borrow ? {
          ...selectEquipmentRarity(weapon, members[targetIndex].rarity === 'LR5' && weapon.rarity === 'LR' ? 'LR' : 'UR'),
          weaponKind: 'exclusive', weaponOwnerCharacterId: borrow.characterId,
          level: Math.max(240, weapon.level), reinforcementLevel: Math.min(weapon.reinforcementLevel, Math.max(240, weapon.level)),
        } : selectEquipmentRarity(weapon, 'NONE');
      }
      if (members[targetIndex].rarity !== 'LR5') members[targetIndex].equipment = members[targetIndex].equipment.map(gear => gear.rarity === 'LR' ? { ...gear, rarity: 'UR', seriesId: 13 } : gear);
    } else {
      if (!hasOwnWeapon) {
        const borrow = getBorrowableWeapons({ ...team, members }, targetIndex, catalog, freeLibrary)[0];
        if (borrow) members[targetIndex].equipment[0] = {
          ...selectEquipmentRarity(members[targetIndex].equipment[0], 'UR'),
          weaponKind: 'exclusive', weaponOwnerCharacterId: borrow.characterId, level: borrow.level,
        };
        return { team: { ...team, members }, selectedIndex: targetIndex, changed: true };
      }
      if (isWeaponOwnerClaimed(team, targetIndex, character.id)) {
        const borrow = getBorrowableWeapons({ ...team, members }, targetIndex, catalog, freeLibrary)[0];
        if (borrow) members[targetIndex].equipment[0] = {
          ...selectEquipmentRarity(members[targetIndex].equipment[0], 'UR'),
          weaponKind: 'exclusive', weaponOwnerCharacterId: borrow.characterId, level: borrow.level,
        };
        return { team: { ...team, members }, selectedIndex: targetIndex, changed: true };
      }
      const ownGift = freeLibrary?.exclusiveWeapons?.find(weapon => weapon.characterId === character.id);
      const rarity = ownGift?.rarity ?? 'SSR';
      if (rarity === 'LR') members[targetIndex].rarity = 'LR5';
      members[targetIndex].equipment[0] = {
        ...selectEquipmentRarity(members[targetIndex].equipment[0], rarity),
        weaponKind: 'exclusive', weaponOwnerCharacterId: character.id, level: ownGift?.level ?? 180,
      };
    }
  }
  return { team: { ...team, members }, selectedIndex: targetIndex, changed: true };
}

// Free builds purchase a compatible weapon rather than claiming gifted inventory.
function placeFreeWeapon(team, members, character, index, previous, catalog, hasOwnWeapon) {
  const member = members[index];
  member.equipment = member.equipment.map(gear => ({ ...gear, runes: gear.runes.map(rune => ({ ...rune })) }));
  let weapon = member.equipment[0];
  const empty = () => createEquipment(1, { level: team.level });
  const freeCatalog = catalog.mode === 'free' ? catalog : { ...catalog, mode: 'free' };
  const candidates = () => getBorrowableWeapons({ ...team, members }, index, freeCatalog);
  const validLevels = (rarity, kind) => {
    const key = kind === 'exclusive' ? 'exclusive' + rarity : rarity;
    const table = catalog.equipmentCosts?.fragments?.[key];
    return (catalog.equipmentCosts?.allowedLevels?.[key] ?? Object.keys(table ?? {}).map(Number))
      .filter(level => Number.isSafeInteger(level) && level > 0 && level <= team.level && Number.isFinite(table?.[level]));
  };
  const equip = (base, rarity, kind, ownerId, desiredLevel) => {
    const levels = validLevels(rarity, kind).filter(level => level <= desiredLevel);
    if (!levels.length) return empty();
    const level = Math.max(...levels);
    return { ...selectEquipmentRarity(base, rarity), weaponKind: kind,
      weaponOwnerCharacterId: kind === 'exclusive' ? ownerId : null, level, syncSlot: 0,
      reinforcementLevel: Math.min(base.reinforcementLevel, level) };
  };
  const chooseDefault = base => {
    if (hasOwnWeapon && !isWeaponOwnerClaimed({ ...team, members }, index, character.id)) {
      return equip(base, 'SSR', 'exclusive', character.id, 180);
    }
    const borrow = candidates()[0];
    if (borrow) return equip(base, 'UR', 'exclusive', borrow.characterId, borrow.level);
    const levels = validLevels('SSR', 'normal');
    return levels.length ? equip(base, 'SSR', 'normal', null, Math.min(...levels)) : empty();
  };
  if (!previous || weapon.rarity === 'NONE') weapon = chooseDefault(weapon);
  else if (weapon.weaponKind === 'exclusive') {
    const ownerId = weapon.weaponOwnerCharacterId ?? previous.characterId;
    const owner = catalog.characters.find(item => item.id === ownerId);
    const canKeepBorrow = owner?.baseRarity === 8 && owner.hasExclusiveWeapon !== false && owner.job === character.job
      && ['UR', 'LR'].includes(weapon.rarity) && !isWeaponOwnerClaimed({ ...team, members }, index, ownerId)
      && (!hasOwnWeapon || ownerId !== previous.characterId);
    if (canKeepBorrow) weapon = equip(weapon, member.rarity === 'LR5' ? weapon.rarity : 'UR', 'exclusive', ownerId, weapon.level);
    else if (hasOwnWeapon && !isWeaponOwnerClaimed({ ...team, members }, index, character.id)) {
      weapon = equip(weapon, member.rarity !== 'LR5' && weapon.rarity === 'LR' ? 'UR' : weapon.rarity, 'exclusive', character.id, weapon.level);
    } else weapon = chooseDefault(weapon);
  }
  member.equipment[0] = weapon;
  if (member.rarity !== 'LR5') member.equipment = member.equipment.map(gear => gear.rarity === 'LR' ? { ...gear, rarity: 'UR', seriesId: 13 } : gear);
  return { team: { ...team, members }, selectedIndex: index, changed: true };
}

export function addRosterCharacter(team, character, options) {
  const existing = team.members.findIndex(member => member?.characterId === character.id);
  if (existing !== -1) return { team, selectedIndex: existing, changed: false };
  const empty = team.members.findIndex(member => member === null);
  if (empty === -1) return { team, selectedIndex: -1, changed: false, full: true };
  return placeRosterCharacter(team, character, empty, options);
}

export function rosterDoubleClick(teamBeforeClick, character, selectedBeforeClick, options) {
  return validPosition(teamBeforeClick, selectedBeforeClick) && teamBeforeClick.members[selectedBeforeClick]
    ? placeRosterCharacter(teamBeforeClick, character, selectedBeforeClick, options)
    : addRosterCharacter(teamBeforeClick, character, options);
}

export function equipReserveWeapon(team, sourceIndex) {
  const source = team.weaponSources?.[sourceIndex];
  const claimsSource = member => member?.equipment[0]?.weaponKind === 'exclusive' && member.equipment[0].rarity !== 'NONE'
    && (member.equipment[0].weaponOwnerCharacterId ?? member.characterId) === source?.characterId;
  if (!source || !team.members.some(claimsSource)) return team;
  const rarityOrder = ['SR', 'LR', 'LR5'];
  const series = { UR: 13, LR: 14 };
  return {
    ...team,
    weaponSources: team.weaponSources.filter((_, index) => index !== sourceIndex),
    members: team.members.map(member => {
      if (!claimsSource(member)) return member;
      const rarity = rarityOrder[Math.max(rarityOrder.indexOf(member.rarity), member.characterId === source.characterId ? rarityOrder.indexOf(source.characterRarity) : 0, source.rarity === 'LR' ? 2 : 0)];
      return { ...member, rarity, equipment: member.equipment.map(gear => gear.slot === 1 ? {
        ...gear, rarity: source.rarity, seriesId: series[source.rarity], weaponKind: 'exclusive', weaponOwnerCharacterId: source.characterId, level: source.level, syncSlot: 0,
        reinforcementLevel: Math.min(Number(gear.reinforcementLevel) || 0, source.level),
      } : gear) };
    }),
  };
}
