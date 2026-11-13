#!/usr/bin/env node
/**
 * 抓取 RN 应用 JS 侧日志（console.* 与未捕获异常）。
 *
 * 为什么需要它：RN 0.84 起 JS 日志不再打印到 Metro 终端（终端只留一句
 * "JavaScript logs have moved"，提示用 React Native DevTools 看），
 * 通过 `npm run ios` 启动时终端里几乎看不到任何运行日志。
 *
 * 实现方式：连 Metro 暴露的 Hermes inspector（就是 DevTools 用的那套 CDP 协议），
 * 订阅 Runtime.consoleAPICalled / Runtime.exceptionThrown，把日志同时写到终端和文件。
 *
 * 用法：
 *   node scripts/capture-js-logs.js              # 持续监听，Ctrl+C 退出
 *   node scripts/capture-js-logs.js --reload      # 先触发一次整包重载（能抓到启动期日志）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const METRO_HOST = '127.0.0.1';
const METRO_PORT = Number(process.env.RN_METRO_PORT || 8081);
const APP_ID = 'com.example.rnofflinepush';
const LOG_DIR = path.resolve(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'js-console.log');

// ws 由 react-native 的依赖提供，不需要额外安装
const WebSocket = require('ws');

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// DevTools 的日志里会带终端颜色控制字符，写文件前去掉，方便直接阅读
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function write(level, text) {
  const line = `[${stamp()}] [${level}] ${String(text).replace(ANSI_PATTERN, '')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

/** 从 Metro 取当前已连接的调试目标（应用每次重连都会变，所以要轮询） */
function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: METRO_HOST, port: METRO_PORT, path: '/json/list' }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

/** 把 CDP 的 console 参数值拼成一行，尽量还原 console.log 的观感 */
function formatArgs(args = []) {
  return args
    .map((arg) => {
      if (arg.type === 'string') return arg.value;
      if (arg.type === 'number' || arg.type === 'boolean' || arg.type === 'undefined') return String(arg.value);
      if (arg.type === 'object' || arg.type === 'function') {
        return arg.description || JSON.stringify(arg.preview?.properties ?? arg.value ?? {});
      }
      return arg.value !== undefined ? String(arg.value) : arg.description || arg.type;
    })
    .join(' ');
}

/** 触发一次整包重载：模块级日志（如注入代码里的 console.log）只会在启动时打印一次 */
function requestReload() {
  const req = http.request(
    { host: METRO_HOST, port: METRO_PORT, path: '/reload', method: 'POST' },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.end();
}

async function attach(reloadFirst) {
  const targets = await getTargets();
  const target = targets.find((item) => item.appId === APP_ID) || targets[0];
  if (!target) return false;

  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  write('system', `已连接 ${target.title || target.appId}（${target.description || ''}）`);

  ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.method === 'Runtime.consoleAPICalled') {
      const level = (msg.params.type || 'log').toUpperCase();
      write(level, formatArgs(msg.params.args));
      return;
    }

    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails || {};
      const text = details.exception?.description || details.text || '未知异常';
      write('EXCEPTION', text.split('\n')[0]);
      return;
    }

    if (msg.method === 'Log.entryAdded') {
      const entry = msg.params.entry || {};
      write(entry.level ? entry.level.toUpperCase() : 'LOG', entry.text || '');
    }
  });

  ws.on('close', () => {
    write('system', '调试连接断开（应用可能已重启），10 秒后尝试重连');
    setTimeout(() => start(reloadFirst), 10000);
  });

  if (reloadFirst) {
    setTimeout(requestReload, 500);
  }

  return true;
}

async function start(reloadFirst) {
  while (true) {
    try {
      const attached = await attach(reloadFirst);
      if (attached) return; // 交给 ws 的 close 事件继续驱动重连
    } catch (error) {
      write('system', `连接失败：${error.message}，3 秒后重试`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

fs.mkdirSync(LOG_DIR, { recursive: true });
write('system', `日志写入 ${LOG_FILE}`);
start(process.argv.includes('--reload'));
