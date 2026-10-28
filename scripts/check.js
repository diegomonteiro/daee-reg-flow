'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Script } = require('node:vm');
const ejs = require('ejs');
const root = path.join(__dirname, '..');
function check(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
check(path.join(root, 'app.js')); check(path.join(root, 'bin/www'));
for (const directory of ['routes', 'models', 'services', 'scripts', 'test', 'public/javascripts']) {
  for (const name of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    if (name.endsWith('.js')) check(path.join(root, directory, name));
  }
}
for (const name of ['index', 'api-docs']) {
  const html = ejs.render(fs.readFileSync(path.join(root, `views/${name}.ejs`), 'utf8'), { basePath: '', title: '' });
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    new Script(match[1], { filename: `views/${name}.ejs (inline)` });
  }
}
console.log('JavaScript and rendered inline scripts: syntax OK');
