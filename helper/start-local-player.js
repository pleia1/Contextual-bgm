import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY } from './src/history.js';
import { injectHelperToken } from './src/plugin-token.js';

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(HELPER_DIR);
const CONFIG_PATH = join(HELPER_DIR, 'config.local.json');
const SERVER_PATH = join(HELPER_DIR, 'server.js');
const PLUGIN_SOURCE_FILENAME = 'contextual-youtube-bgm-v0.4.3.plugin.js';
const PLUGIN_INSTALL_FILENAME = 'contextual-youtube-bgm-v0.4.3.local.plugin.js';
const PLUGIN_SOURCE_PATH = join(PROJECT_DIR, 'risu-plugin', PLUGIN_SOURCE_FILENAME);
const PLUGIN_INSTALL_PATH = join(PROJECT_DIR, 'risu-plugin', 'local', PLUGIN_INSTALL_FILENAME);
const STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_WINDOW = { width: 980, height: 824 };

function newConfig() {
  return {
    port: 43127,
    authToken: randomBytes(24).toString('base64url'),
    youtubeApiKey: '',
    regionCode: 'KR',
    relevanceLanguage: 'ko',
    browserWindowWidth: DEFAULT_BROWSER_WINDOW.width,
    browserWindowHeight: DEFAULT_BROWSER_WINDOW.height,
    defaultVolume: 35,
    recordAfterSeconds: 10,
    playbackStartTimeoutSeconds: 15,
    policy: { ...DEFAULT_POLICY },
  };
}

function isBoolean(value) {
  return value === true || value === false;
}

function windowDimension(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(640, Math.min(3840, number))) : fallback;
}

async function askYesNo(prompt, question) {
  while (true) {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log('Y 또는 N을 입력해 주세요.');
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readConfigDocument() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read helper/config.local.json: ${error.message}`);
  }
}

async function saveConfig(config) {
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, CONFIG_PATH);
}

async function syncPluginToken(authToken) {
  if (!existsSync(PLUGIN_SOURCE_PATH)) {
    throw new Error(`Cannot find risu-plugin/${PLUGIN_SOURCE_FILENAME}.`);
  }
  const source = await readFile(PLUGIN_SOURCE_PATH, 'utf8');
  const updated = injectHelperToken(source, authToken);
  await mkdir(dirname(PLUGIN_INSTALL_PATH), { recursive: true });
  await writeFile(PLUGIN_INSTALL_PATH, updated, 'utf8');
  console.log('Created a Git-ignored RisuAI plugin copy with the local helper token.');
  console.log(`Import or hot-reload risu-plugin/local/${PLUGIN_INSTALL_FILENAME} in RisuAI.`);
}

async function prepareConfig() {
  const config = (await readConfigDocument()) ?? newConfig();
  config.port = Number(config.port || 43127);
  config.authToken = String(config.authToken || randomBytes(24).toString('base64url'));
  config.youtubeApiKey = String(config.youtubeApiKey || '').trim();
  config.browserWindowWidth = windowDimension(config.browserWindowWidth, DEFAULT_BROWSER_WINDOW.width);
  config.browserWindowHeight = windowDimension(config.browserWindowHeight, DEFAULT_BROWSER_WINDOW.height);

  const environmentKey = String(process.env.RISU_BGM_YOUTUBE_API_KEY || '').trim();
  const needsApiKey = !config.youtubeApiKey && !environmentKey;
  const needsBrowserChoice = !isBoolean(config.browserAutoplayBypass);
  if (needsApiKey || needsBrowserChoice) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (needsApiKey) {
        while (!config.youtubeApiKey) {
          const answer = await prompt.question('YouTube Data API v3 key: ');
          config.youtubeApiKey = answer.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
          if (!config.youtubeApiKey) console.log('An API key is required to search YouTube.');
        }
      }
      if (needsBrowserChoice) {
        console.log('Y를 선택하면 자동재생 제한을 해제한 전용 브라우저 프로필로 플레이어를 엽니다.');
        config.browserAutoplayBypass = await askYesNo(prompt, '전용 자동재생 브라우저 옵션을 사용할까요? (Y/N): ');
      }
    } finally {
      prompt.close();
    }
    await saveConfig(config);
    console.log('로컬 플레이어 설정을 helper/config.local.json에 저장했습니다.');
  } else if (!existsSync(CONFIG_PATH)) {
    await saveConfig(config);
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error('helper/config.local.json contains an invalid port.');
  }
  return {
    port: config.port,
    authToken: config.authToken,
    browserAutoplayBypass: config.browserAutoplayBypass === true,
    browserWindowWidth: config.browserWindowWidth,
    browserWindowHeight: config.browserWindowHeight,
  };
}

async function getHelperStatus(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.authToken}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function playerUrl(config) {
  return `http://127.0.0.1:${config.port}/player?token=${encodeURIComponent(config.authToken)}`;
}

function openDefaultBrowser(url) {
  return new Promise((resolve, reject) => {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function chromiumCandidates() {
  const paths = [
    [process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ];
  return paths
    .filter(([base]) => typeof base === 'string' && base.length > 0)
    .map((parts) => join(...parts));
}

async function openAutoplayBrowser(url, windowWidth, windowHeight) {
  const executable = chromiumCandidates().find((candidate) => existsSync(candidate));
  if (!executable) {
    console.warn('Edge 또는 Chrome을 찾지 못해 기본 브라우저로 엽니다. 소리 허용 클릭이 필요할 수 있습니다.');
    await openDefaultBrowser(url);
    return;
  }
  const localBase = process.env.LOCALAPPDATA || process.env.TEMP;
  if (!localBase) throw new Error('Cannot locate a directory for the dedicated browser profile.');
  // Avoid reusing an older browser process that may have started without the autoplay flag.
  const profileDirectory = join(localBase, 'RisuContextualYouTubeBGM', 'browser-profile-autoplay-v1');
  await mkdir(profileDirectory, { recursive: true });
  await new Promise((resolve, reject) => {
    const browser = spawn(executable, [
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      `--window-size=${windowWidth},${windowHeight}`,
      `--app=${url}`,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    browser.once('error', reject);
    browser.once('spawn', () => {
      browser.unref();
      resolve();
    });
  });
}

async function openBrowser(url, config) {
  if (config.browserAutoplayBypass) {
    await openAutoplayBrowser(url, config.browserWindowWidth, config.browserWindowHeight);
  }
  else await openDefaultBrowser(url);
}

async function waitUntilReady(child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Helper exited before it became ready (exit code ${child.exitCode}).`);
    }
    const config = await prepareConfig();
    if (config && (await getHelperStatus(config))) return config;
    await sleep(250);
  }
  throw new Error('Timed out while waiting for the helper to start.');
}

async function main() {
  const existingConfig = await prepareConfig();
  await syncPluginToken(existingConfig.authToken);
  const existingStatus = await getHelperStatus(existingConfig);
  if (existingStatus) {
    if (!existingStatus.youtubeConfigured) {
      throw new Error('The running helper has no YouTube API key. Close its terminal and run this BAT again.');
    }
    await openBrowser(playerUrl(existingConfig), existingConfig);
    console.log('The helper is already running. Opened the player in your browser.');
    return;
  }

  console.log('Starting the Risu BGM helper...');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
  });

  try {
    const config = await waitUntilReady(child);
    await openBrowser(playerUrl(config), config);
    console.log('Opened the local player. Keep this window open while using BGM.');
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }

  await new Promise((resolve) => child.once('exit', resolve));
}

main().catch((error) => {
  console.error(`Launcher error: ${error.message}`);
  process.exitCode = 1;
});
