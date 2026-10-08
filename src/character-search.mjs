export function filterRosterCharacters(characters, aliases, search = '', element = 'all') {
  const query = search.trim().toLocaleLowerCase();
  return characters.filter(character =>
    (character.baseRarity == null || character.baseRarity === 8)
    && (element === 'all' || character.element === element)
    && `${character.name} ${character.subtitle ?? ''} ${character.variant ?? ''} ${character.aliases?.join?.(' ') ?? ''} ${aliases.get(character.id) ?? ''} ${character.id}`.toLocaleLowerCase().includes(query));
}
