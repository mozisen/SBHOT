const fs = require('node:fs');
const source = fs.readFileSync('shaobing-hot.user.js', 'utf8');
const header = source.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
if (!header) throw new Error('Missing userscript metadata');
fs.writeFileSync('shaobing-hot.meta.js', header[0] + '\n');
