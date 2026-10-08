import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('equipment rune mini icons preserve every public category and original locked 19px PNG',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
  const lock=JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
  const categories=Array.from({length:16},(_,index)=>index+1);
  assert.deepEqual(catalog.runeCategories.map(category=>category.id),categories);
  assert.deepEqual(Object.keys(catalog.runeIcons),categories.map(String));
  assert.deepEqual(lock.runeIcons.map(asset=>asset.categoryId),categories);
  assert.match(lock.sphereAssetRef,/^[a-f0-9]{40}$/);
  assert.equal(new Set(lock.runeIcons.map(asset=>asset.path)).size,16);
  for (const asset of lock.runeIcons) {
    const name=`SPH_${String(asset.categoryId).padStart(2,'0')}00.png`;
    assert.equal(asset.sourceRef,lock.sphereAssetRef);
    assert.equal(asset.path,`assets/spheres/${name}`);
    assert.equal(asset.sourcePath,asset.path);
    assert.ok(asset.sourceResourceKey.endsWith(`/Icon/Sphere/${name}`));
    assert.equal(catalog.runeIcons[asset.categoryId],`./${asset.path}`);
    assert.equal(asset.width,19);
    assert.equal(asset.height,19);
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
    assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(bytes.readUInt32BE(16),19);
    assert.equal(bytes.readUInt32BE(20),19);
  }
});

test('rune-only maintenance rejects mutable refs before changing the public catalog',async()=>{
  const catalogPath=new URL('../public/data/catalog.json',import.meta.url);
  const lockPath=new URL('../public/data/asset-lock.json',import.meta.url);
  const before=await Promise.all([readFile(catalogPath),readFile(lockPath)]);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/sync-public-catalog.mjs',import.meta.url)),'--runes-only'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{...process.env,SPHERE_ASSET_REF:'main'},
    encoding:'utf8',
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Rune synchronization requires an exact published commit SHA/);
  const after=await Promise.all([readFile(catalogPath),readFile(lockPath)]);
  assert.deepEqual(after,before);
});
