'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, maxConfidence, capConfidence } = require('../src/main/safety');

const w = (p) => classify(p, 'win32');
const m = (p) => classify(p, 'darwin');

test('windows classification', () => {
  assert.equal(w('C:\\Windows\\Temp\\x.tmp').tier, 'sistema');
  assert.equal(w('C:\\Program Files (x86)\\Android\\android-sdk\\system-images\\a\\system.img').tier, 'sistema');
  assert.equal(w('C:\\ProgramData\\Microsoft\\Windows\\WER\\x.dmp').tier, 'sistema');
  assert.deepEqual([w('C:\\ProgramData\\NVIDIA Corporation\\x').tier, w('C:\\ProgramData\\NVIDIA Corporation\\x').owner], ['aplicacion', 'NVIDIA']);
  const rg = w('C:\\Riot Games\\League of Legends\\Plugins\\rcp-be-lol-game-data\\default-assets.wad');
  assert.equal(rg.tier, 'aplicacion');
  assert.match(rg.owner, /League of Legends/);
  const and = w('C:\\Users\\msc_c\\AppData\\Local\\Android\\Sdk\\system-images\\android-31\\x86_64\\system.img');
  assert.equal(and.tier, 'aplicacion');
  assert.match(and.owner, /Android/);
  assert.equal(w('C:\\Users\\msc_c\\.android\\avd\\pixel.avd\\snapshots\\default_boot\\ram.img').tier, 'aplicacion');
  assert.equal(w('C:\\Users\\msc_c\\AppData\\Local\\NVIDIA\\DXCache\\x.nvph').tier, 'cache');
  assert.equal(w('C:\\Users\\msc_c\\AppData\\Local\\Temp\\foo.tmp').tier, 'cache');
  assert.equal(w('C:\\Users\\msc_c\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_0001').tier, 'cache');
  assert.equal(w('C:\\Users\\msc_c\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History').tier, 'aplicacion');
  assert.equal(w('C:\\Users\\msc_c\\AppData\\Roaming\\Claude\\vm_bundles\\rootfs.vhdx').tier, 'aplicacion');
  assert.equal(w('C:\\Users\\msc_c\\AppData\\Local\\wsl\\{guid}\\ext4.vhdx').owner, 'wsl');
  assert.equal(w('C:\\Users\\msc_c\\Downloads\\setup (1).exe').tier, 'usuario');
  assert.equal(w('C:\\Users\\msc_c\\Documents\\tesis.docx').tier, 'usuario');
  assert.equal(w('C:\\Users\\msc_c\\src\\proyecto\\node_modules\\x').tier, 'usuario'); // inside a user folder, project protection handled elsewhere
  assert.equal(w('C:\\Users\\msc_c\\.ssh\\id_rsa').tier, 'sistema');
  assert.equal(w('C:\\XboxGames\\Among Us\\Content\\x').tier, 'aplicacion');
  const msfs = w('D:\\Otros\\xbox\\Microsoft Flight Simulator 2024\\Content\\x');
  assert.equal(msfs.tier, 'aplicacion');
  assert.match(msfs.owner, /Flight Simulator.*Xbox/);
  assert.equal(w('D:\\WindowsApps\\Microsoft.Game_1.0\\x').tier, 'sistema');
  assert.equal(w('D:\\Juegos\\Microsoft Flight Simulator 2024\\x').tier, 'aplicacion');
  assert.equal(w('C:\\VulkanSDK\\1.3\\x').tier, 'aplicacion');
  assert.equal(w('D:\\Backups\\foto.jpg').tier, 'otro');
  assert.equal(w('D:\\cache\\x').tier, 'cache');
  assert.equal(w('C:\\hiberfil.sys').tier, 'sistema');
});

test('macOS classification', () => {
  assert.equal(m('/System/Library/x').tier, 'sistema');
  assert.equal(m('/Applications/Xcode.app/Contents').owner, 'Xcode');
  assert.equal(m('/Users/m/Library/Caches/com.apple.dt.Xcode/x').tier, 'cache');
  assert.equal(m('/Users/m/Library/Developer/Xcode/DerivedData/x').tier, 'cache');
  assert.equal(m('/Users/m/Library/Developer/CoreSimulator/Devices/x').tier, 'aplicacion');
  assert.equal(m('/Users/m/Library/Application Support/Slack/x').tier, 'aplicacion');
  assert.equal(m('/Users/m/Library/Application Support/Slack/Cache/x').tier, 'cache');
  assert.equal(m('/Users/m/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw').tier, 'aplicacion');
  assert.equal(m('/Users/m/Library/Mail/V10/x').tier, 'aplicacion');
  assert.equal(m('/Users/m/Library/Keychains/login.keychain-db').tier, 'sistema');
  assert.equal(m('/Users/m/Pictures/Fototeca.photoslibrary/x').tier, 'aplicacion');
  assert.equal(m('/Users/m/Downloads/x.dmg').tier, 'usuario');
  assert.equal(m('/Users/m/.docker/x').tier, 'aplicacion');
  assert.equal(m('/Users/m/.ssh/x').tier, 'sistema');
  assert.equal(m('/Volumes/Externo/pelis/x.mkv').tier, 'otro');
});

test('maxConfidence caps by tier and personal media', () => {
  assert.equal(maxConfidence({ tier: 'sistema', category: 'Otros' }), null);
  assert.equal(maxConfidence({ tier: 'aplicacion', category: 'Otros' }), 'baja');
  assert.equal(maxConfidence({ tier: 'usuario', category: 'Imágenes' }), 'media');
  assert.equal(maxConfidence({ tier: 'usuario', category: 'Imágenes', isDuplicate: true }), 'alta');
  assert.equal(maxConfidence({ tier: 'usuario', category: 'Instaladores' }), 'alta');
  assert.equal(maxConfidence({ tier: 'cache', category: 'Otros' }), 'alta');
  assert.equal(capConfidence('alta', 'baja'), 'baja');
  assert.equal(capConfidence('baja', 'alta'), 'baja');
  assert.equal(capConfidence('alta', null), null);
});
