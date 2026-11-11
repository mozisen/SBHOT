const fs = require('node:fs');
for (const name of ['shaobing-hot', 'shaobing-assistant-pro', 'shaobing-reply-reminder']) {
  if (!fs.existsSync(name + '.user.js') && name === 'shaobing-assistant-pro') continue;
  let source = fs.readFileSync(name + '.user.js', 'utf8');
  if (name !== 'shaobing-assistant-pro') {
    const module = fs.readFileSync('scripts/reply-guard.js', 'utf8').trimEnd();
    source = source.replace(/\/\/ BEGIN SHARED REPLY GUARD[\s\S]*?\/\/ END SHARED REPLY GUARD/,
      () => '// BEGIN SHARED REPLY GUARD\n' + module + '\n// END SHARED REPLY GUARD');
    fs.writeFileSync(name + '.user.js', source);
  }
  const header = source.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
  if (!header) throw new Error('Missing userscript metadata in ' + name);
  fs.writeFileSync(name + '.meta.js', header[0] + '\n');
}
