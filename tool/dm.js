//Importing Modules .....
const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const chalk = require('chalk');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

const API_BASE = process.env.API_BASE ? process.env.API_BASE.replace(/\/$/, '') : null;
const apiIsLocal = API_BASE && (API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1'));
const apiProxyOptIn = process.env.API_USE_PROXY === '1';
const proxiesPath = 'proxies.txt';
let proxies = [];
if (fs.existsSync(proxiesPath)) {
    proxies = fs.readFileSync(proxiesPath, 'utf8')
        .replace(/\r/g, '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
}

function buildProxyAgent() {
    if (!proxies.length) return null;
    const picked = proxies[Math.floor(Math.random() * proxies.length)];
    // supports host:port:user:pass
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
// Config
const config = require('./config');
const dm_delay_min = config.dm_delay_min;
const dm_delay_max = config.dm_delay_max;
const dm_message = config.dm_messages;
const login_delay_min = config.login_delay_min;
const login_delay_max = config.login_delay_max;

// Optional fast mode (to intentionally spam and trigger captcha)
const FAST_DM = process.env.FAST_DM === '1';
const FAST_DM_MIN = Number(process.env.FAST_DM_MIN || 50);   // ms
const FAST_DM_MAX = Number(process.env.FAST_DM_MAX || 150);  // ms
const effectiveDmMin = FAST_DM ? FAST_DM_MIN : dm_delay_min;
const effectiveDmMax = FAST_DM ? FAST_DM_MAX : dm_delay_max;

// Proxy decision for API (only if opt-in and not local)
const shouldUseProxyForApi = apiProxyOptIn && !apiIsLocal;
// .
if (!API_BASE) {
    console.log(`${chalk.yellowBright('[CAPTCHA]')} API_BASE not set; captcha forwarding will be skipped.`);
} else {
    console.log(`${chalk.magentaBright('[CAPTCHA]')} Forward target: ${API_BASE}/api/tasks` + (shouldUseProxyForApi ? ' via proxy' : ' (direct)'));
}

//Error Handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
})
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
})
//Initializing Variables
let tokens = fs.readFileSync('tokens.txt', 'utf8').replace(/\r/g, '').split('\n').filter(x => x);
let i = 0;
let serverId = fs.readFileSync('serverId.txt', 'utf8').replace(/\r/g, '');
const membersPath = 'members.txt';
const invitePath = 'invite.txt';
const inviteCode = fs.existsSync(invitePath) ? fs.readFileSync(invitePath, 'utf8').trim() : null;
const loadMembers = () => fs.readFileSync(membersPath, 'utf8').replace(/\r/g, '').split('\n').filter(x => x);

tokens.forEach(token => {
    setTimeout(async () => {
        await login(token, serverId);
    }, randomInt(login_delay_min, login_delay_max) * (++i));
});


async function login(token, serverId) {
    const proxyAgent = buildProxyAgent();
    const client = new Client({
        // Captcha handler: forward to API and pause DM loop until solved
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
            // Return null to indicate we didn't solve locally
            return null;
        },
        http: proxyAgent ? { agent: proxyAgent } : undefined,
        ws: proxyAgent ? { agent: proxyAgent } : undefined,
    });

    const captchaState = {
        pending: false,
        taskId: null,
        pollTimer: null,
    };

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
                // keep polling
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

        // If invite code is provided, make sure the token is in the target server
        if (inviteCode && serverId && !client.guilds.cache.has(serverId)) {
            try {
                await client.acceptInvite(inviteCode);
                console.log(`${chalk.greenBright('[JOIN]')} ${chalk.cyan(client.user.tag)} joined via invite ${inviteCode}`);
            } catch (err) {
                console.log(`${chalk.redBright('[JOIN]')} ${chalk.cyan(client.user.tag)} failed to join via invite ${inviteCode}: ${err.message}`);
            }
        }

        const startDmRound = () => {
            let listOfMembers = loadMembers();

            if (!listOfMembers.length) {
                console.log(`${chalk.yellowBright('[WARN]')} No members in members.txt — retrying soon.`);
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
                // remove from current round memory to avoid repeat within this pass
                listOfMembers = listOfMembers.filter(x => x !== member);

                const delay = randomInt(effectiveDmMin, effectiveDmMax);
                setTimeout(sendOnce, delay);
            };

            // initial kick for this round
            const firstDelay = randomInt(effectiveDmMin, effectiveDmMax);
            setTimeout(sendOnce, firstDelay);
        };

        startDmRound();
    });

    client.login(token).catch((error) => {
        if (error.toString()?.includes("INVALID") && error.toString()?.includes("TOKEN")) {
            console.log(`${chalk.redBright(`[ERROR]`)} ${chalk.whiteBright(`Invalid Token: ${token}`)}`);
            //removing invalid token from tokens.txt
            fs.writeFileSync('tokens.txt', fs.readFileSync('tokens.txt', 'utf8').replace(token, ''));
            console.log(`Removed Invalid Token: ${token}`);
        }
    }).catch((error) => {
        console.error('Unhandled promise rejection:', error);
    });
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
