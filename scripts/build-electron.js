import { build } from 'vite';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildElectron() {
  console.log('Building Vite app...');

  // Build Vite app
  await build();

  console.log('Copying Electron files...');

  // Create dist-electron directory
  const distElectronDir = join(__dirname, '../dist-electron');
  if (!existsSync(distElectronDir)) {
    mkdirSync(distElectronDir, { recursive: true });
  }

  // Copy electron files
  const electronMain = join(__dirname, '../electron/main.js');
  const electronPreload = join(__dirname, '../electron/preload.js');
  const distMain = join(distElectronDir, 'main.js');
  const distPreload = join(distElectronDir, 'preload.js');

  if (existsSync(electronMain)) {
    copyFileSync(electronMain, distMain);
    console.log('Copied main.js');
  }

  if (existsSync(electronPreload)) {
    copyFileSync(electronPreload, distPreload);
    console.log('Copied preload.js');
  }

  // Copy assets folder
  const assetsDir = join(__dirname, '../assets');
  const distAssetsDir = join(distElectronDir, 'assets');
  if (existsSync(assetsDir)) {
    if (!existsSync(distAssetsDir)) {
      mkdirSync(distAssetsDir, { recursive: true });
    }
    const notificationWav = join(assetsDir, 'notification.wav');
    if (existsSync(notificationWav)) {
      copyFileSync(notificationWav, join(distAssetsDir, 'notification.wav'));
      console.log('Copied notification.wav');
    }
  }

  console.log('Build complete!');
}

buildElectron().catch(console.error);

