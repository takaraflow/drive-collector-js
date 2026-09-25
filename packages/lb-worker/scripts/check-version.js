// 验证版本号是否正确同步
import fs from 'fs';
import path from 'path';

// 1. 读取 package.json
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
console.log('package.json version:', packageJson.version);

// 2. 读取 manifest.json
if (fs.existsSync('manifest.json')) {
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    console.log('manifest.json version:', manifest.version);
    
    if (manifest.version === packageJson.version) {
        console.log('✅ manifest.json 版本匹配 (manifest.json version matches)');
    } else {
        console.error('❌ manifest.json 版本不匹配 (manifest.json version mismatch!)');
    }
} else {
    console.warn('⚠️ 未找到 manifest.json (manifest.json not found)');
}

// 3. 读取 package-lock.json
if (fs.existsSync('package-lock.json')) {
    const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    console.log('package-lock.json version:', packageLock.version);
    
    if (packageLock.version === packageJson.version) {
        console.log('✅ package-lock.json 版本匹配 (package-lock.json version matches)');
    } else {
        console.error('❌ package-lock.json 版本不匹配 (package-lock.json version mismatch!)');
    }
} else {
    console.warn('⚠️ 未找到 package-lock.json (package-lock.json not found)');
}
