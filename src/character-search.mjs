export function filterRosterCharacters(characters, aliases, search = '', element = 'all') {
  const query = search.trim().toLocaleLowerCase();
  return characters.filter(character =>
    (character.baseRarity == null || [1, 2, 8].includes(character.baseRarity))
    && (element === 'all' || character.element === element)
    && `${character.name} ${character.subtitle ?? ''} ${character.variant ?? ''} ${character.aliases?.join?.(' ') ?? ''} ${aliases.get(character.id) ?? ''} ${character.id}`.toLocaleLowerCase().includes(query));
}

export function characterSourceLabel(character) {
  return ({ 1: 'N卡', 2: 'R卡' })[character?.baseRarity] ?? '';
}
