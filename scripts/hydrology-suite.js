'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });
const localPython = path.join(root, '.venv-hydrology/bin/python');
const python = process.env.DEM_PYTHON || (fs.existsSync(localPython) ? localPython : 'python3');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'scripts/hydrology', '-p', 'test_*.py'], { cwd: root, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
