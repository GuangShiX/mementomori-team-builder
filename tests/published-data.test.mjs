import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTeam,createMember,calculateTeam,createExport,parseImport,validateTeam} from '../src/domain.mjs';
const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
const policy = JSON.parse(await readFile(new URL('../public/data/pricing-policy.json',import.meta.url)));
const lock = JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
const five = () => {const team=createTeam();team.members=catalog.characters.slice(0,5).map(createMember);return team;};

test('all shipped portraits match the canonical public asset manifest',async()=>{
  assert.equal(catalog.characters.length,lock.portraits.length);
  for(const asset of lock.portraits){
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  }
});
test('actual policy handles complete all-SR teams and untrusted fee import',()=>{
  const team=five();
  assert.equal(calculateTeam(team,catalog,policy).totalDiamonds,85000);
  const exported=createExport(team,catalog,policy);
  exported.costBreakdown.totalDiamonds=0;
  exported.policySnapshot.unitPrices.characterCopy=0;
  assert.equal(parseImport(JSON.stringify(exported),catalog,policy).costBreakdown.totalDiamonds,85000);
});
test('actual gear data computes full reinforcement investment and team-wide free allowance',()=>{
  const team=five();
  for(const member of team.members) for(const gear of member.equipment){Object.assign(gear,{rarity:'SSR',seriesId:12,level:450,reinforcementLevel:450});}
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.reinforcementMedicine.consumed,147315);
  assert.equal(result.resources.reinforcementMedicine.charged,47315);
  assert.equal(result.resources.reinforcementMedicine.diamonds,473150);
  const next=structuredClone(policy);next.allowances.reinforcementMedicine=147315;
  assert.equal(calculateTeam(team,catalog,next).resources.reinforcementMedicine.diamonds,0);
});
test('actual catalog rejects SSR exclusive450 and permits exclusive240',()=>{
  const team=five(); const gear=team.members[0].equipment[0];
  Object.assign(gear,{rarity:'SSR',seriesId:12,weaponKind:'exclusive',level:450});
  assert.equal(validateTeam(team,catalog,policy).valid,false);
  gear.level=240;
  assert.equal(validateTeam(team,catalog,policy).valid,true);
  assert.equal(calculateTeam(team,catalog,policy).resources.exclusiveFragments.consumed,275);
});
test('published LR normal and exclusive costs include the distinct leaf evolution chains',()=>{
  const team=five();const member=team.members[0];member.rarity='LR5';
  Object.assign(member.equipment[0],{rarity:'LR',seriesId:14,weaponKind:'exclusive',level:450});
  Object.assign(member.equipment[1],{rarity:'LR',seriesId:14,level:450});
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.lifeTreeDew.consumed,115);
  assert.equal(result.resources.lifeTreeDew.diamonds,46000);
});
test('sacred experience is cumulative and overage charges rather than blocking export',()=>{
  const team=five();
  for(const member of team.members){const gear=member.equipment[0];Object.assign(gear,{rarity:'UR',seriesId:13,level:450,legendSacredTreasureLevel:40});}
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.holySteel.consumed,3905);
  assert.equal(result.resources.holySteel.charged,405);
  assert.equal(result.resources.holySteel.diamonds,40500);
  assert.doesNotThrow(()=>createExport(team,catalog,policy));
});
test('ordinary rune stock permits three level11 runes per category across the whole team',()=>{
  const team=five();
  for(const member of team.members) Object.assign(member.equipment[0],{rarity:'SSR',seriesId:12,level:450});
  for(const member of team.members.slice(0,3)) member.equipment[0].runes[0]={categoryId:4,level:11};
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.unidentifiedRune7.consumed,0);
  assert.equal(result.fixedRuneInventory.find(item=>item.categoryId===4).remaining,0);
  team.members[3].equipment[0].runes[0]={categoryId:4,level:11};
  assert.equal(validateTeam(team,catalog,policy).valid,false);
  team.members[3].equipment[0].runes[0]={categoryId:6,level:11};
  assert.equal(validateTeam(team,catalog,policy).valid,true);
  team.members[3].equipment[0].runes[0].level=10;
  assert.equal(validateTeam(team,catalog,policy).valid,false);
});
