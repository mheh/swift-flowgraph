// Opens a page in headless Chrome and prints its console lines until one matches the stop pattern.
// Usage: node cdp.mjs <url> <stop pattern> [seconds] [screenshot.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';

const [url, stop, seconds = "60", shot] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--window-size=1500,950', '--allow-file-access-from-files',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync('/tmp/chr.')}`, 'about:blank',
], { stdio: 'ignore' });
const finish = code => { chrome.kill(); process.exit(code); };
let shooting = false;
setTimeout(() => { console.log(`no line matched ${stop} in ${seconds} s`); finish(1); }, seconds * 1000);

let target;
for (let i = 0; i < 50 && !target; i++) {
  await new Promise(r => setTimeout(r, 200));
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++id, method, params }));
socket.onopen = () => { send('Runtime.enable'); send('Page.enable'); send('Page.navigate', { url }); };
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (shooting && message.result?.data) { writeFileSync(shot, Buffer.from(message.result.data, "base64")); finish(0); }
  let line;
  if (message.method === 'Runtime.consoleAPICalled') line = message.params.args.map(a => a.value ?? a.description ?? '').join(' ');
  if (message.method === 'Runtime.exceptionThrown') line = 'PAGEERR ' + (message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (line === undefined) return;
  console.log(line);
  if (new RegExp(stop).test(line)) {
    if (!shot) finish(0);
    shooting = true;
    setTimeout(() => send("Page.captureScreenshot", { format: "png" }), 700);
  }
};
