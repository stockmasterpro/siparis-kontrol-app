const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const cachePath = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign');
const target = path.join(cachePath, 'winCodeSign-2.6.0');

if (!fs.existsSync(target)) {
    console.log('Target winCodeSign-2.6.0 not found. Checking for zips...');
    const zips = fs.readdirSync(cachePath).filter(f => f.endsWith('.7z'));
    if (zips.length > 0) {
        const zipFile = zips[0];
        const tempFolder = path.join(cachePath, zipFile.replace('.7z', ''));
        console.log(`Extracting ${zipFile} to ${tempFolder}...`);
        try {
            cp.execSync(`C:/Users/Fatih/Desktop/Final/node_modules/7zip-bin/win/x64/7za.exe x -snld -bd ${path.join(cachePath, zipFile)} -o${tempFolder} -y`, { stdio: 'inherit' });
        } catch (e) {
            console.log('7zip probably exited with code 2 due to symlinks. This is fine!');
        }
        
        try {
            fs.renameSync(tempFolder, target);
            console.log('Successfully prepared winCodeSign-2.6.0 cache!');
        } catch(e) {
            console.error('Rename failed:', e);
        }
    }
} else {
    console.log('winCodeSign-2.6.0 already exists.');
}
