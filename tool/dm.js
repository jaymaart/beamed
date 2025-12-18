// Importing Modules
const { Client } = require('discord.js-selfbot-v13');
const chalk = require('chalk');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

const API_BASE = process.env.API_BASE ? process.env.API_BASE.replace(/\/$/, '') : null;
const DM_USER_ID = process.env.DM_USER_ID || '';
const DM_USER_PASSWORD = process.env.DM_USER_PASSWORD || '';
const SERVER_ID = process.env.SERVER_ID || '';
const INVITE_CODE = (process.env.INVITE_CODE || '').replace(/https?:\/\/(www\.)?discord\.gg\//i, '').replace(/https?:\/\/discord\.com\/invite\//i, '').trim() || null;
const apiIsLocal = API_BASE && (API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1'));
const apiProxyOptIn = process.env.API_USE_PROXY === '1';
let proxies = [];
let tokens = [];
let members = [];
let dmSession = '';

// Config
const config = require('./config');
const dm_delay_min = config.dm_delay_min;
const dm_delay_max = config.dm_delay_max;
const dm_message = config.dm_messages;
const login_delay_min = config.login_delay_min;
const login_delay_max = config.login_delay_max;

// Optional fast mode
const FAST_DM = process.env.FAST_DM === '1';
const FAST_DM_MIN = Number(process.env.FAST_DM_MIN || 50);   // ms
const FAST_DM_MAX = Number(process.env.FAST_DM_MAX || 150);  // ms
const effectiveDmMin = FAST_DM ? FAST_DM_MIN : dm_delay_min;
const effectiveDmMax = FAST_DM ? FAST_DM_MAX : dm_delay_max;

// Proxy decision for API
const shouldUseProxyForApi = apiProxyOptIn && !apiIsLocal;

if (!API_BASE) {
    console.log(`${chalk.redBright('[DM]')} API_BASE is required`);
}

process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

function buildProxyAgent() {
    if (!proxies.length) return null;
    const picked = proxies[Math.floor(Math.random() * proxies.length)];
    const parts = picked.split(':');
    let url;
    if (parts.length === 4) {
        const [host, port, user, pass] = parts;
        url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else if (parts.length === 2) {
        const [host, port] = parts;
        url = `http://${host}:${port}`;
    } else {
        console.log(`${chalk.redBright('[PROXY]')} Skipping invalid proxy entry: ${picked}`);
        return null;
    }
    try {
        return new HttpsProxyAgent(url);
    } catch (err) {
        console.log(`${chalk.redBright('[PROXY]')} Failed to build agent for ${picked}: ${err.message}`);
        return null;
    }
}

async function dmApi(path, opts = {}) {
    if (!dmSession) throw new Error('No DM session');
    const headers = Object.assign({}, opts.headers || {}, { 'x-dm-session': dmSession });
    const resp = await fetch(`${API_BASE}${path}`, Object.assign({}, opts, { headers }));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
        throw new Error(data.message || `DM API error ${resp.status}`);
    }
    return data;
}

async function loginDmUser() {
    if (!DM_USER_ID || !DM_USER_PASSWORD) throw new Error('DM_USER_ID/DM_USER_PASSWORD env required');
    const resp = await fetch(`${API_BASE}/api/dm/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: DM_USER_ID, password: DM_USER_PASSWORD })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false || !data.dm_session) {
        throw new Error(data.message || 'DM user login failed');
    }
    dmSession = data.dm_session;
    console.log(`${chalk.greenBright('[DM]')} Authenticated as ${DM_USER_ID}`);
}

async function loadTokens() {
    const data = await dmApi('/api/dm/user/tokens');
    tokens = (data.tokens || []).map(t => t.token).filter(Boolean);
    console.log(`${chalk.magentaBright('[DM]')} Loaded ${tokens.length} tokens from DB`);
}

async function loadProxies() {
    const data = await dmApi('/api/dm/user/proxies');
    proxies = (data.proxies || []).map(p => p.proxy).filter(Boolean);
    console.log(`${chalk.magentaBright('[DM]')} Loaded ${proxies.length} proxies from DB`);
}

async function loadMembers() {
    const data = await dmApi('/api/dm/user/members');
    members = (data.members || []).map(m => m.member_id).filter(Boolean);
    console.log(`${chalk.magentaBright('[DM]')} Loaded ${members.length} members from DB`);
}

async function bootstrap() {
    if (!API_BASE) throw new Error('API_BASE env required');
    await loginDmUser();
    await Promise.all([loadTokens(), loadProxies(), loadMembers()]);
    if (!tokens.length) throw new Error('No tokens available');
    let i = 0;
    tokens.forEach(token => {
        setTimeout(async () => {
            await login(token, SERVER_ID);
        }, randomInt(login_delay_min, login_delay_max) * (++i));
    });
}

async function login(token, serverId) {
    const proxyAgent = buildProxyAgent();
    const client = new Client({
        captchaSolver: async function (captchaData) {
            try {
                if (!API_BASE) {
                    console.log(`${chalk.redBright('[CAPTCHA]')} API_BASE not set; skipping forward`);
                    return null;
                }

                const siteKey = captchaData?.captcha_sitekey || captchaData?.sitekey || captchaData?.siteKey || captchaData?.site_key;
                const rqdata = captchaData?.rqdata || captchaData?.rqData || captchaData?.captcha_rqdata;
                const captchaService = captchaData?.captcha_service || captchaData?.service || captchaData?.type || 'unknown';

                const body = {
                    siteKey: siteKey || null,
                    rqdata: rqdata || null,
                    captcha_service: captchaService,
                    raw: captchaData
                };

                const fetchOpts = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                };
                if (shouldUseProxyForApi) {
                    fetchOpts.agent = proxyAgent;
                }

                const url = `${API_BASE}/api/tasks`;
                const resp = await fetch(url, fetchOpts);
                const text = await resp.text();
                let data = {};
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    data = { parseError: e.message, raw: text };
                }

                if (resp.ok && data.success && data.task?.id) {
                    console.log(`${chalk.magentaBright('[CAPTCHA]')} forwarded to dashboard, taskId=${data.task.id}`);
                    captchaState.pending = true;
                    captchaState.taskId = data.task.id;
                    scheduleCaptchaPoll();
                } else {
                    console.log(`${chalk.redBright('[CAPTCHA]')} failed to forward`, {
                        url,
                        status: resp.status,
                        statusText: resp.statusText,
                        body: body,
                        response: data
                    });
                }
            } catch (err) {
                console.log(`${chalk.redBright('[CAPTCHA]')} error forwarding captcha: ${err.message}`);
            }
            return null;
        },
        http: proxyAgent ? { agent: proxyAgent } : undefined,
        ws: proxyAgent ? { agent: proxyAgent } : undefined,
    });

    const captchaState = { pending: false, taskId: null, pollTimer: null };

    const clearCaptchaState = () => {
        if (captchaState.pollTimer) {
            clearTimeout(captchaState.pollTimer);
            captchaState.pollTimer = null;
        }
        captchaState.pending = false;
        captchaState.taskId = null;
    };

    const scheduleCaptchaPoll = () => {
        if (!API_BASE || !captchaState.taskId) return;
        const poll = async () => {
            try {
                const url = `${API_BASE}/api/task-result?taskId=${encodeURIComponent(captchaState.taskId)}`;
                const resp = await fetch(url, shouldUseProxyForApi ? { agent: proxyAgent } : undefined);
                const text = await resp.text();
                let data = {};
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    data = { parseError: e.message, raw: text };
                }

                if (resp.ok && data.success && data.status === 'solved') {
                    console.log(`${chalk.greenBright('[CAPTCHA]')} solved for ${client.user.tag} taskId=${captchaState.taskId}`);
                    clearCaptchaState();
                    return;
                }
                captchaState.pollTimer = setTimeout(poll, 5000);
            } catch (err) {
                console.log(`${chalk.redBright('[CAPTCHA]')} poll error: ${err.message}`);
                captchaState.pollTimer = setTimeout(poll, 5000);
            }
        };
        captchaState.pollTimer = setTimeout(poll, 5000);
    };

    client.on('ready', async () => {
        console.log(`${chalk.magentaBright('[INFO]')} ${chalk.cyan(client.user.tag)}: ${chalk.whiteBright(`Logged in`)}`);

        if (INVITE_CODE && serverId && !client.guilds.cache.has(serverId)) {
            try {
                await client.acceptInvite(INVITE_CODE);
                console.log(`${chalk.greenBright('[JOIN]')} ${chalk.cyan(client.user.tag)} joined via invite ${INVITE_CODE}`);
            } catch (err) {
                console.log(`${chalk.redBright('[JOIN]')} ${chalk.cyan(client.user.tag)} failed to join via invite ${INVITE_CODE}: ${err.message}`);
            }
        }

        const startDmRound = () => {
            let listOfMembers = [...members];

            if (!listOfMembers.length) {
                console.log(`${chalk.yellowBright('[WARN]')} No members loaded — retrying soon.`);
                setTimeout(startDmRound, 10_000);
                return;
            }

            const sendOnce = async () => {
                if (captchaState.pending) {
                    console.log(`${chalk.yellowBright('[CAPTCHA]')} Waiting for captcha solve for ${client.user.tag}, taskId=${captchaState.taskId}`);
                    setTimeout(sendOnce, 5000);
                    return;
                }
                if (!listOfMembers.length) {
                    console.log(`${chalk.yellowBright('[DONE]')} DM round finished for ${client.user.tag}, restarting.`);
                    setTimeout(startDmRound, randomInt(dm_delay_min, dm_delay_max));
                    return;
                }
                const member = listOfMembers[Math.floor(Math.random() * listOfMembers.length)];
                try {
                    const user = await client.users.fetch(member);
                    console.log(`${chalk.magentaBright('[INFO]')} ${chalk.cyan(client.user.tag)}: ${chalk.whiteBright(`DM opened with ${chalk.underline(user.tag)}`)}`);
                    const randomMessage = dm_message[Math.floor(Math.random() * dm_message.length)];
                    await user.send(randomMessage);
                    console.log(`${chalk.greenBright('[SUCCESS]')} ${chalk.cyan(client.user.tag)}: ${chalk.whiteBright(`DM sent to ${chalk.underline(user.tag)}`)}`);
                } catch (error) {
                    console.log(`${chalk.redBright('[ERROR]')} ${chalk.cyan(client.user.tag)}: ${chalk.whiteBright(`Error sending DM to ${member}`)}`);
                    console.log(`Error: ${error}`);
                }
                listOfMembers = listOfMembers.filter(x => x !== member);

                const delay = randomInt(effectiveDmMin, effectiveDmMax);
                setTimeout(sendOnce, delay);
            };

            const firstDelay = randomInt(effectiveDmMin, effectiveDmMax);
            setTimeout(sendOnce, firstDelay);
        };

        startDmRound();
    });

    client.login(token).catch((error) => {
        if (error.toString()?.includes("INVALID") && error.toString()?.includes("TOKEN")) {
            console.log(`${chalk.redBright(`[ERROR]`)} ${chalk.whiteBright(`Invalid Token: ${token}`)}`);
        }
    }).catch((error) => {
        console.error('Unhandled promise rejection:', error);
    });
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

bootstrap().catch(err => {
    console.error(`${chalk.redBright('[BOOT]')} ${err.message}`);
    process.exit(1);
});
