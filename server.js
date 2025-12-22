const http = require('http');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const { Pool } = require('pg');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Config
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SOLVER_PASSWORD = process.env.SOLVER_PASSWORD || 'solver';
const PORT = process.env.PORT || 8000;
const FIVE_MINUTES = 5 * 60 * 1000;
const MAX_TASKS_PER_WORKER = 5;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const DB_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || 'postgres://solver:solver25@192.168.1.11:5432/solver-service';

const pool = new Pool({ connectionString: DB_URL });

// Helpers for Express async handlers
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Job tracking
const activeJobs = new Map(); // jobId -> { status, controller }

// Parse proxy string and create proxy agent
function createProxyAgent(proxyString) {
  if (!proxyString) return null;
  
  try {
    // Format: host:port:user:pass or host:port
    const parts = proxyString.split(':');
    
    if (parts.length === 2) {
      // host:port
      const [host, port] = parts;
      return new HttpsProxyAgent(`http://${host}:${port}`);
    } else if (parts.length === 4) {
      // host:port:user:pass
      const [host, port, user, pass] = parts;
      return new HttpsProxyAgent(`http://${user}:${pass}@${host}:${port}`);
    }
    
    return null;
  } catch (err) {
    console.error(`Failed to create proxy agent: ${err.message}`);
    return null;
  }
}

// Generate random Discord fingerprint (X-Super-Properties)
function generateDiscordFingerprint() {
  const browsers = [
    { name: 'Chrome', versions: ['120', '121', '122', '123', '124', '125'] },
    { name: 'Firefox', versions: ['120', '121', '122', '123', '124'] },
    { name: 'Edge', versions: ['120', '121', '122', '123'] }
  ];
  
  const os = [
    { name: 'Windows', versions: ['10', '11'] },
    { name: 'Mac OS X', versions: ['10_15_7', '11_0_0', '12_0_0', '13_0_0', '14_0_0'] },
    { name: 'Linux', versions: ['x86_64'] }
  ];
  
  const selectedBrowser = browsers[Math.floor(Math.random() * browsers.length)];
  const browserVersion = selectedBrowser.versions[Math.floor(Math.random() * selectedBrowser.versions.length)];
  
  const selectedOs = os[Math.floor(Math.random() * os.length)];
  const osVersion = selectedOs.versions[Math.floor(Math.random() * selectedOs.versions.length)];
  
  const superProperties = {
    os: selectedOs.name,
    browser: selectedBrowser.name,
    device: '',
    system_locale: 'en-US',
    browser_user_agent: `Mozilla/5.0 (${selectedOs.name === 'Windows' ? `Windows NT ${osVersion === '10' ? '10.0' : '10.0'}; Win64; x64` : selectedOs.name === 'Mac OS X' ? `Macintosh; Intel Mac OS X ${osVersion}` : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) ${selectedBrowser.name}/${browserVersion}.0.0.0 Safari/537.36`,
    browser_version: browserVersion + '.0.0.0',
    os_version: osVersion,
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: Math.floor(Math.random() * (250000 - 240000) + 240000),
    client_event_source: null
  };
  
  return Buffer.from(JSON.stringify(superProperties)).toString('base64');
}

// Helper to log DM events to database
async function logDmEvent(jobId, logType, message) {
  try {
    await pool.query(
      'INSERT INTO dm_logs (id, job_id, log_type, message, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [uuidv4(), jobId, logType, message]
    );
    console.log(`[JOB ${jobId.substring(0,8)}] ${logType}: ${message}`);
  } catch (err) {
    console.error(`Failed to log DM event: ${err.message}`);
  }
}

// Helper to update job counts
async function updateJobStats(jobId, sentDelta = 0, failedDelta = 0, skippedDelta = 0) {
  try {
    await pool.query(
      'UPDATE dm_jobs SET sent_count = sent_count + $1, failed_count = failed_count + $2, skipped_count = skipped_count + $3, updated_at = NOW() WHERE id = $4',
      [sentDelta, failedDelta, skippedDelta, jobId]
    );
  } catch (err) {
    console.error(`Failed to update job stats: ${err.message}`);
  }
}

// Helper to validate a Discord token
async function validateToken(token, tokenId, proxyAgent = null) {
  try {
    const resp = await fetch('https://discord.com/api/v9/users/@me', {
      headers: { 
        'Authorization': token,
        'X-Super-Properties': generateDiscordFingerprint()
      },
      agent: proxyAgent
    });
    
    if (resp.status === 401) {
      await pool.query("UPDATE dm_tokens SET status='invalid' WHERE id=$1", [tokenId]);
      return { valid: false, reason: 'Invalid token (401)' };
    }
    
    if (!resp.ok) {
      return { valid: false, reason: `HTTP ${resp.status}` };
    }
    
    const userData = await resp.json();
    await pool.query("UPDATE dm_tokens SET status='valid' WHERE id=$1", [tokenId]);
    return { valid: true, username: userData.username };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

// Captcha solver for DM operations
async function solveDmCaptcha(sitekey, rqdata, rqtoken) {
  const captchaApiBase = process.env.API_BASE || 'http://localhost:8204';
  try {
    // Submit captcha task
    const taskResp = await fetch(`${captchaApiBase}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteKey: sitekey,
        rqdata: rqdata,
        service: 'hcaptcha'
      })
    });
    
    const taskData = await taskResp.json();
    const taskId = taskData.task?.id;
    if (!taskId) throw new Error('Failed to get captcha task ID');
    
    // Poll for result (max 2 minutes)
    const startTime = Date.now();
    while (Date.now() - startTime < 120000) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const resultResp = await fetch(`${captchaApiBase}/api/task-result?taskId=${taskId}`);
      const resultData = await resultResp.json();
      
      if (resultData.status === 'solved') {
        return resultData.token;
      } else if (resultData.status === 'expired' || resultData.status === 'failed') {
        throw new Error(`Captcha ${resultData.status}`);
      }
    }
    throw new Error('Captcha solving timeout');
  } catch (err) {
    throw new Error(`Captcha solve failed: ${err.message}`);
  }
}

// Helper to join guild with token
async function joinGuildWithToken(token, inviteCode, jobId, proxyAgent = null, proxyString = null) {
  try {
    // Use scraper service to join (it has full discord.py-self client with proper session)
    const scraperUrl = process.env.SCRAPER_SERVICE_URL || 'http://scraper:8600/scrape';
    const joinUrl = scraperUrl.replace('/scrape', '/join');
    
    await logDmEvent(jobId, 'info', `🔗 Attempting to join guild via Discord client...`);
    
    const joinResp = await fetch(joinUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        token: token,
        invite: inviteCode,
        proxy: proxyString || null
      }),
      agent: proxyAgent // Use proxy for the HTTP request to scraper service
    });

    //Handle scraper service response
    if (!joinResp.ok) {
      const errorText = await joinResp.text();
      let errorData = {};
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {}
      
      await logDmEvent(jobId, 'error', `📋 Join Service Response: ${errorData.error || errorText.substring(0, 100)}`);
      throw new Error(errorData.error || `Join failed: ${joinResp.status}`);
    }
    
    const result = await joinResp.json();
    
    if (!result.success) {
      await logDmEvent(jobId, 'error', `📋 Join failed: ${result.error || 'Unknown error'}`);
      throw new Error(result.error || 'Join failed');
    }
    
    await logDmEvent(jobId, 'info', `✅ Successfully joined guild`);
    return true;
  } catch (err) {
    // Handle fetch network errors
    if (err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
      await logDmEvent(jobId, 'error', `📋 Network error connecting to join service: ${err.message}`);
      throw new Error(`Join service unavailable: ${err.message}`);
    }
    throw err;
  }
}

// Job executor - processes a DM job
async function executeDmJob(jobId, userId) {
  const controller = new AbortController();
  activeJobs.set(jobId, { status: 'running', controller });

  try {
    // Fetch job details
    const jobRes = await pool.query('SELECT * FROM dm_jobs WHERE id=$1', [jobId]);
    if (!jobRes.rowCount) {
      await logDmEvent(jobId, 'error', 'Job not found');
      return;
    }
    
    const job = jobRes.rows[0];
    const { message, cap = 0, invite_code } = job;
    
    // Hardcoded settings from config
    const DELAY_BETWEEN_MSG_MIN = 3000;
    const DELAY_BETWEEN_MSG_MAX = 5000;
    const SKIP_TOKEN_AFTER_ERRORS = 10;
    const DM_CAP_PER_TOKEN = 0; // 0 = unlimited
    const RATELIMIT_SLEEP_MIN = 600000; // 10 minutes
    const RATELIMIT_SLEEP_MAX = 700000; // 11.67 minutes
    const RANDOMIZE_MESSAGES = true;
    const RANDOM_STRING_END_OF_MESSAGE = true;

    // Fetch members and get guild info
    const membersRes = await pool.query(
      'SELECT member_id, guild_id FROM dm_members WHERE user_id=$1 LIMIT 1', 
      [userId]
    );
    if (!membersRes.rowCount) {
      await logDmEvent(jobId, 'error', '❌ No members available. Please scrape members first.');
      await pool.query('UPDATE dm_jobs SET status=$1 WHERE id=$2', ['failed', jobId]);
      return;
    }
    
    const guildId = membersRes.rows[0].guild_id;
    if (!guildId) {
      await logDmEvent(jobId, 'error', '❌ No guild_id found in members data.');
      await pool.query('UPDATE dm_jobs SET status=$1 WHERE id=$2', ['failed', jobId]);
      return;
    }

    await logDmEvent(jobId, 'info', `🎯 Target guild: ${guildId}`);

    // Get invite code from job
    if (invite_code) {
      await logDmEvent(jobId, 'info', `📬 Using invite: ${invite_code}`);
    } else {
      await logDmEvent(jobId, 'info', `⚠️ No invite code provided - tokens may already be in guild`);
    }

    // Fetch tokens (only valid/unknown, not invalid)
    const tokensRes = await pool.query(
      "SELECT id, token FROM dm_tokens WHERE user_id=$1 AND (status IS NULL OR status != 'invalid') ORDER BY created_at DESC", 
      [userId]
    );
    if (!tokensRes.rowCount) {
      await logDmEvent(jobId, 'error', '❌ No valid tokens available');
      await pool.query('UPDATE dm_jobs SET status=$1 WHERE id=$2', ['failed', jobId]);
      return;
    }
    
    const tokenData = tokensRes.rows;
    
    // Fetch proxies
    const proxiesRes = await pool.query('SELECT proxy FROM dm_proxies WHERE user_id=$1', [userId]);
    const proxies = proxiesRes.rows.map(r => r.proxy).filter(Boolean);
    
    await logDmEvent(jobId, 'info', `🚀 Starting DM job with ${tokenData.length} token(s) and ${proxies.length} proxy/proxies`);
    await logDmEvent(jobId, 'info', `🔐 Using randomized fingerprints for all requests`);

    // Step 1: Validate all tokens first
    await logDmEvent(jobId, 'info', `🔍 Validating tokens...`);
    const validatedTokens = [];
    
    for (let idx = 0; idx < tokenData.length; idx++) {
      const tokenEntry = tokenData[idx];
      const { id: tokenId, token } = tokenEntry;
      
      // Rotate through proxies for validation
      const proxyString = proxies.length > 0 ? proxies[idx % proxies.length] : null;
      const proxyAgent = proxyString ? createProxyAgent(proxyString) : null;
      
      const validation = await validateToken(token, tokenId, proxyAgent);
      
      if (validation.valid) {
        await logDmEvent(jobId, 'info', `✅ Token ${token.substring(0, 10)}... is valid (${validation.username})`);
        validatedTokens.push(tokenEntry);
      } else {
        await logDmEvent(jobId, 'error', `🚫 Token ${token.substring(0, 10)}... is invalid: ${validation.reason}`);
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (validatedTokens.length === 0) {
      await logDmEvent(jobId, 'error', '❌ No valid tokens available after validation');
      await pool.query('UPDATE dm_jobs SET status=$1 WHERE id=$2', ['failed', jobId]);
      return;
    }

    await logDmEvent(jobId, 'info', `✅ ${validatedTokens.length}/${tokenData.length} tokens are valid`);

    // Step 2: Join guild with validated tokens (if invite code provided)
    const validTokens = [];
    
    if (invite_code) {
      await logDmEvent(jobId, 'info', `🔗 Joining guild with tokens... (this may take a while)`);
      
      for (let idx = 0; idx < validatedTokens.length; idx++) {
        const tokenEntry = validatedTokens[idx];
        const { id: tokenId, token } = tokenEntry;
        
        // Rotate through proxies for guild join
        const proxyString = proxies.length > 0 ? proxies[idx % proxies.length] : null;
        const proxyAgent = proxyString ? createProxyAgent(proxyString) : null;
        
        try {
          await joinGuildWithToken(token, invite_code, jobId, proxyAgent, proxyString);
          await logDmEvent(jobId, 'info', `✅ Token ${token.substring(0, 10)}... joined guild`);
          validTokens.push(tokenEntry);
          
          // Small delay between join attempts to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (err) {
          // Check for "server join restricted" error (code 340015) - account is fine, just can't join servers
          if (err.message.includes('340015') || err.message.includes('Access to joining new servers')) {
            await logDmEvent(jobId, 'info', `⏭️ Token ${token.substring(0, 10)}... restricted from joining servers (will try DMs anyway)`);
            validTokens.push(tokenEntry); // Still add - can DM even if can't join
          } 
          // Already a member - can definitely DM
          else if (err.message.includes('already a member')) {
            await logDmEvent(jobId, 'info', `✓ Token ${token.substring(0, 10)}... already in guild`);
            validTokens.push(tokenEntry);
          } 
          // Token banned/invalid - mark as invalid (401 = actually invalid)
          else if (err.message.includes('Token invalid') || err.message.includes('401')) {
            await pool.query("UPDATE dm_tokens SET status='invalid' WHERE id=$1", [tokenId]);
            await logDmEvent(jobId, 'error', `🚫 Token ${token.substring(0, 10)}... marked as invalid`);
          } 
          // Code 10008 after captcha = Discord blocking the automated join (proxy/IP/captcha service detected)
          else if (err.message.includes('10008') || err.message.includes('Unknown Message')) {
            await logDmEvent(jobId, 'info', `⚠️ Token ${token.substring(0, 10)}... automated join blocked (10008) - will try DMs anyway`);
            validTokens.push(tokenEntry); // Token is valid, just can't auto-join - try DMing anyway
          }
          // Captcha failed after solving - likely bot detection, but token is fine
          else if (err.message.includes('Failed after captcha') || err.message.includes('403')) {
            await logDmEvent(jobId, 'info', `⚠️ Token ${token.substring(0, 10)}... captcha rejected (will try DMs anyway)`);
            validTokens.push(tokenEntry); // Token is valid, just couldn't join - maybe already in guild
          } 
          // Other errors - assume token is fine, might already be in guild
          else {
            await logDmEvent(jobId, 'info', `⚠️ Token ${token.substring(0, 10)}... join uncertain (${err.message.substring(0, 60)}...) - will try DMs`);
            validTokens.push(tokenEntry); // Give it a chance - might already be in guild
          }
        }
      }
    } else {
      // No invite code - use validated tokens directly
      await logDmEvent(jobId, 'info', `⏭️ Skipping guild join (no invite code provided)`);
      validTokens.push(...validatedTokens);
    }

    if (validTokens.length === 0) {
      await logDmEvent(jobId, 'error', '❌ No tokens available after guild join attempts');
      await pool.query('UPDATE dm_jobs SET status=$1 WHERE id=$2', ['failed', jobId]);
      return;
    }

    await logDmEvent(jobId, 'info', `✅ ${validTokens.length} token(s) ready to send DMs`);
    
    if (validTokens.length < 3) {
      await logDmEvent(jobId, 'info', `⚠️ Warning: Only ${validTokens.length} token(s) available. Consider adding more tokens to avoid rate limits.`);
    }

    // Fetch all members
    const allMembersRes = await pool.query('SELECT member_id FROM dm_members WHERE user_id=$1', [userId]);
    const members = allMembersRes.rows.map(r => r.member_id);
    await logDmEvent(jobId, 'info', `👥 Loaded ${members.length} member(s)`);

    // Shuffle members if needed
    const shuffledMembers = [...members];
    for (let i = shuffledMembers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledMembers[i], shuffledMembers[j]] = [shuffledMembers[j], shuffledMembers[i]];
    }

    let sentCount = 0;
    let failedCount = 0;
    const maxToSend = cap > 0 ? Math.min(cap, shuffledMembers.length) : shuffledMembers.length;
    const invalidTokenIds = new Set(); // Track tokens that became invalid during DMing
    const tokenStats = new Map(); // Track stats per token: { errorCount, sentCount, rateLimited }
    
    // Initialize token stats
    validTokens.forEach(t => {
      tokenStats.set(t.id, { errorCount: 0, sentCount: 0, rateLimited: false });
    });

    await logDmEvent(jobId, 'info', `📨 Sending to ${maxToSend} member(s)...`);
    await logDmEvent(jobId, 'info', `⚙️ Config: Skip after ${SKIP_TOKEN_AFTER_ERRORS} errors | Delay ${DELAY_BETWEEN_MSG_MIN}-${DELAY_BETWEEN_MSG_MAX}ms | Rate limit sleep ${RATELIMIT_SLEEP_MIN/60000}-${RATELIMIT_SLEEP_MAX/60000}min`);

    for (let i = 0; i < maxToSend && activeJobs.get(jobId)?.status === 'running'; i++) {
      const memberId = shuffledMembers[i];
      
      // Find next valid token (skip invalid, error-prone, capped, and rate-limited tokens)
      let tokenEntry = null;
      let tokenIndex = i % validTokens.length;
      let attempts = 0;
      
      while (!tokenEntry && attempts < validTokens.length) {
        const candidate = validTokens[tokenIndex];
        const stats = tokenStats.get(candidate.id);
        
        // Check if token should be skipped
        const isInvalid = invalidTokenIds.has(candidate.id);
        const tooManyErrors = SKIP_TOKEN_AFTER_ERRORS > 0 && stats.errorCount >= SKIP_TOKEN_AFTER_ERRORS;
        const reachedCap = DM_CAP_PER_TOKEN > 0 && stats.sentCount >= DM_CAP_PER_TOKEN;
        const isRateLimited = stats.rateLimited;
        
        if (!isInvalid && !tooManyErrors && !reachedCap && !isRateLimited) {
          tokenEntry = candidate;
        } else {
          if (tooManyErrors && attempts === 0) {
            await logDmEvent(jobId, 'info', `⏭️ Skipping token ${candidate.token.substring(0, 10)}... (${stats.errorCount} errors)`);
          }
          if (reachedCap && attempts === 0) {
            await logDmEvent(jobId, 'info', `⏭️ Skipping token ${candidate.token.substring(0, 10)}... (reached cap: ${stats.sentCount}/${DM_CAP_PER_TOKEN})`);
          }
          if (isRateLimited && attempts === 0) {
            await logDmEvent(jobId, 'info', `⏭️ Skipping token ${candidate.token.substring(0, 10)}... (rate limited)`);
          }
          tokenIndex = (tokenIndex + 1) % validTokens.length;
          attempts++;
        }
      }
      
      if (!tokenEntry) {
        await logDmEvent(jobId, 'error', '❌ All tokens are invalid, rate-limited, or reached their cap. Stopping job.');
        break;
      }
      
      const token = tokenEntry.token;
      const tokenId = tokenEntry.id;
      
      // Log which token we're using every 10 messages
      if (i % 10 === 0 && i > 0) {
        await logDmEvent(jobId, 'info', `📊 Progress: ${sentCount} sent, ${failedCount} failed. Using token ${tokenIndex + 1}/${validTokens.length}`);
      }

      try {
        // Get proxy for this request (rotate through proxies)
        const proxyString = proxies.length > 0 ? proxies[i % proxies.length] : null;
        const proxyAgent = proxyString ? createProxyAgent(proxyString) : null;
        
        // Create DM channel (new fingerprint for each request)
        const dmFingerprint = generateDiscordFingerprint();
        const createDmResp = await fetch('https://discord.com/api/v9/users/@me/channels', {
          method: 'POST',
          headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'X-Super-Properties': dmFingerprint
          },
          body: JSON.stringify({ recipient_id: memberId }),
          signal: controller.signal,
          agent: proxyAgent
        });

        if (createDmResp.status === 401) {
          // Mark token as invalid and add to skip list
          invalidTokenIds.add(tokenId);
          await pool.query("UPDATE dm_tokens SET status='invalid' WHERE id=$1", [tokenId]);
          await logDmEvent(jobId, 'error', `🚫 Token ${token.substring(0, 10)}... marked as invalid (401) - will use next token`);
          
          // Check how many tokens are left
          const remainingTokens = validTokens.length - invalidTokenIds.size;
          if (remainingTokens === 0) {
            await logDmEvent(jobId, 'error', `❌ All tokens are now invalid. Job cannot continue.`);
          } else {
            await logDmEvent(jobId, 'info', `ℹ️ ${remainingTokens} token(s) still available`);
          }
          
          throw new Error(`Failed to create DM: 401 Unauthorized`);
        }

        if (createDmResp.status === 429) {
          // Rate limited - mark token and sleep
          const errorData = await createDmResp.json().catch(() => ({}));
          const retryAfter = errorData.retry_after || 60; // seconds
          const stats = tokenStats.get(tokenId);
          stats.rateLimited = true;
          
          await logDmEvent(jobId, 'error', `⏱️ Token ${token.substring(0, 10)}... is rate limited (retry after ${retryAfter}s)`);
          
          // Sleep for configured rate limit duration (10-11.67 minutes)
          const sleepMs = Math.floor(Math.random() * (RATELIMIT_SLEEP_MAX - RATELIMIT_SLEEP_MIN + 1)) + RATELIMIT_SLEEP_MIN;
          const sleepMinutes = (sleepMs / 60000).toFixed(1);
          await logDmEvent(jobId, 'info', `😴 Rate limit detected - sleeping for ${sleepMinutes} minutes...`);
          await new Promise(resolve => setTimeout(resolve, sleepMs));
          
          // Unmark rate limit after sleep
          stats.rateLimited = false;
          await logDmEvent(jobId, 'info', `⏰ Woke up from rate limit sleep, continuing...`);
          
          throw new Error(`Rate limited (slept ${sleepMinutes}m)`);
        }

        if (!createDmResp.ok) {
          const errorText = await createDmResp.text();
          let errorData = {};
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {}
          
          // Check for "Cannot send messages to this user" error (code 50007 or 340002)
          if (errorData.code === 50007 || errorData.code === 340002 || 
              (errorData.message && (errorData.message.includes('Cannot send messages to this user') || 
                                    errorData.message.includes('Access to sending DMs')))) {
            // Silent success - user has DMs disabled, not a token error
            // Still counts as API usage for rate limiting
            const stats = tokenStats.get(tokenId);
            stats.sentCount++; // Increment token usage (consumes rate limit quota)
            stats.errorCount = 0; // Don't count as error
            
            await updateJobStats(jobId, 0, 0, 1); // Increment skipped count
            // Don't log this to reduce spam
            
            // Apply normal delay (3-5 seconds) - we still hit Discord's API
            const delay = Math.floor(Math.random() * (DELAY_BETWEEN_MSG_MAX - DELAY_BETWEEN_MSG_MIN + 1)) + DELAY_BETWEEN_MSG_MIN;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          // Log full Discord response for debugging
          await logDmEvent(jobId, 'error', `📋 DM Create Error - Status: ${createDmResp.status} | Code: ${errorData.code || 'N/A'} | Message: ${errorData.message || errorText.substring(0, 100)}`);
          throw new Error(`Failed to create DM: ${createDmResp.status} ${JSON.stringify(errorData)}`);
        }

        const dmChannel = await createDmResp.json();
        const channelId = dmChannel.id;

        // Send message (with captcha handling - new fingerprint)
        const sendFingerprint = generateDiscordFingerprint();
        let sendResp = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'X-Super-Properties': sendFingerprint
          },
          body: JSON.stringify({ content: message }),
          signal: controller.signal,
          agent: proxyAgent
        });

        // Handle captcha if required
        if (sendResp.status === 400) {
          const errorText = await sendResp.text();
          let errorData = {};
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {}
          
          // Check for DMs disabled on 400 too
          if (errorData.code === 340002 || errorData.code === 50007) {
            // Silent success - still counts as API usage
            const stats = tokenStats.get(tokenId);
            stats.sentCount++; // Increment token usage (consumes rate limit quota)
            stats.errorCount = 0;
            
            await updateJobStats(jobId, 0, 0, 1); // Increment skipped count
            // Don't log to reduce spam
            
            // Apply normal delay (3-5 seconds) - we still hit Discord's API
            const delay = Math.floor(Math.random() * (DELAY_BETWEEN_MSG_MAX - DELAY_BETWEEN_MSG_MIN + 1)) + DELAY_BETWEEN_MSG_MIN;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          if (errorData.captcha_key && errorData.captcha_sitekey) {
            await logDmEvent(jobId, 'info', `🔐 Captcha required for ${memberId.substring(0, 8)}..., solving...`);
            
            const captchaKey = await solveDmCaptcha(
              errorData.captcha_sitekey,
              errorData.captcha_rqdata,
              errorData.captcha_rqtoken
            );
            
            await logDmEvent(jobId, 'info', `✅ Captcha solved, retrying send...`);
            
            // Retry with captcha (new fingerprint for retry)
            const retrySendFingerprint = generateDiscordFingerprint();
            sendResp = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
              method: 'POST',
              headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
                'X-Super-Properties': retrySendFingerprint,
                'X-Captcha-Key': captchaKey,
                'X-Captcha-Rqtoken': errorData.captcha_rqtoken
              },
              body: JSON.stringify({ 
                content: message,
                captcha_key: captchaKey,
                captcha_rqtoken: errorData.captcha_rqtoken
              }),
              signal: controller.signal,
              agent: proxyAgent
            });
          }
        }

        if (!sendResp.ok) {
          const errorText = await sendResp.text();
          let errorData = {};
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {}
          
          // Check for "DMs disabled" error (code 340002 or 50007)
          if (errorData.code === 340002 || errorData.code === 50007 || 
              (errorData.message && (errorData.message.includes('Access to sending DMs') || 
                                    errorData.message.includes('Cannot send messages to this user')))) {
            // Silent success - user has DMs disabled, not a token error
            // Still counts as API usage for rate limiting
            const stats = tokenStats.get(tokenId);
            stats.sentCount++; // Increment token usage (consumes rate limit quota)
            stats.errorCount = 0; // Don't count as error
            
            await updateJobStats(jobId, 0, 0, 1); // Increment skipped count
            // Don't log to reduce spam
            
            // Apply normal delay (3-5 seconds) - we still hit Discord's API
            const delay = Math.floor(Math.random() * (DELAY_BETWEEN_MSG_MAX - DELAY_BETWEEN_MSG_MIN + 1)) + DELAY_BETWEEN_MSG_MIN;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          // Log full Discord response for debugging
          await logDmEvent(jobId, 'error', `📋 Message Send Error - Status: ${sendResp.status} | Code: ${errorData.code || 'N/A'} | Message: ${errorData.message || errorText.substring(0, 100)}`);
          throw new Error(`Failed to send message: ${sendResp.status} ${JSON.stringify(errorData)}`);
        }

        sentCount++;
        const stats = tokenStats.get(tokenId);
        stats.sentCount++;
        stats.errorCount = 0; // Reset error count on success
        
        await updateJobStats(jobId, 1, 0);
        await logDmEvent(jobId, 'success', `✅ DM sent to ${memberId.substring(0, 8)}... (${sentCount}/${maxToSend}) [Token: ${stats.sentCount}${DM_CAP_PER_TOKEN > 0 ? `/${DM_CAP_PER_TOKEN}` : ''}]`);

      } catch (err) {
        failedCount++;
        const stats = tokenStats.get(tokenId);
        
        // Only increment error count for non-rate-limit errors
        if (!err.message.includes('Rate limited')) {
          stats.errorCount++;
        }
        
        await updateJobStats(jobId, 0, 1);
        await logDmEvent(jobId, 'error', `❌ Failed to DM ${memberId.substring(0, 8)}...: ${err.message} [Errors: ${stats.errorCount}]`);
        
        // Longer delay if rate limited or 401
        if (err.message.includes('Rate limited') || err.message.includes('401')) {
          if (!err.message.includes('slept')) { // Don't double-delay if we already slept
            await logDmEvent(jobId, 'info', `⏸️ Waiting 10 seconds before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
          continue; // Skip normal delay
        }
      }

      // Delay between sends (3-5 seconds)
      const delay = Math.floor(Math.random() * (DELAY_BETWEEN_MSG_MAX - DELAY_BETWEEN_MSG_MIN + 1)) + DELAY_BETWEEN_MSG_MIN;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Job complete - get final stats
    const finalJobRes = await pool.query('SELECT sent_count, failed_count, skipped_count FROM dm_jobs WHERE id=$1', [jobId]);
    const finalStats = finalJobRes.rows[0] || { sent_count: sentCount, failed_count: failedCount, skipped_count: 0 };
    
    const finalStatus = activeJobs.get(jobId)?.status === 'running' ? 'completed' : 'stopped';
    await pool.query('UPDATE dm_jobs SET status=$1, updated_at=NOW() WHERE id=$2', [finalStatus, jobId]);
    await logDmEvent(jobId, 'info', `🏁 Job ${finalStatus}: ${finalStats.sent_count} sent, ${finalStats.failed_count} failed, ${finalStats.skipped_count} skipped (DMs disabled)`);
    activeJobs.delete(jobId);

  } catch (err) {
    console.error(`[JOB ${jobId.substring(0,8)}] Fatal error:`, err);
    await logDmEvent(jobId, 'error', `💥 Fatal error: ${err.message}`);
    await pool.query('UPDATE dm_jobs SET status=$1, updated_at=NOW() WHERE id=$2', ['failed', jobId]);
    activeJobs.delete(jobId);
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      session_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS solver_sessions (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      password TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS password TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_tokens (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT DEFAULT 'unknown',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  
  await pool.query(`ALTER TABLE dm_tokens ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unknown';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_proxies (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      proxy TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_user_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_jobs (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT,
      cap INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      invite_code TEXT,
      guild_id TEXT
    );
  `);
  
  await pool.query(`ALTER TABLE dm_jobs ADD COLUMN IF NOT EXISTS sent_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE dm_jobs ADD COLUMN IF NOT EXISTS failed_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE dm_jobs ADD COLUMN IF NOT EXISTS skipped_count INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE dm_jobs ADD COLUMN IF NOT EXISTS invite_code TEXT;`);
  await pool.query(`ALTER TABLE dm_jobs ADD COLUMN IF NOT EXISTS guild_id TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_logs (
      id UUID PRIMARY KEY,
      job_id UUID NOT NULL,
      log_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_logs_job_id ON dm_logs (job_id, created_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_members (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      guild_id TEXT,
      member_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, member_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      solved_count INTEGER NOT NULL DEFAULT 0,
      device_info JSONB,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      site_key TEXT NOT NULL,
      rqdata TEXT,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending',
      solved TIMESTAMPTZ,
      solved_by TEXT,
      assigned_to TEXT,
      token TEXT
    );
  `);

  // Indexes for faster lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks (status, created);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks (assigned_to);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workers_last_active ON workers (last_active);`);
  await pool.query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS ip TEXT;`);
}

function normalizeTask(row) {
  return {
    id: row.id,
    siteKey: row.site_key,
    rqdata: row.rqdata,
    created: row.created ? new Date(row.created).getTime() : null,
    status: row.status,
    solved: row.solved ? new Date(row.solved).getTime() : null,
    solved_by: row.solved_by || null,
    assigned_to: row.assigned_to || null,
    token: row.token || null,
  };
}

function normalizeWorker(row) {
  return {
    id: row.id,
    name: row.name,
    solved_count: row.solved_count || 0,
    device_info: row.device_info || null,
    first_seen: row.first_seen ? new Date(row.first_seen).getTime() : null,
    last_active: row.last_active ? new Date(row.last_active).getTime() : null,
  };
}

// Express setup
const app = express();
app.use(express.json());

// Lightweight CORS for dev/prod with optional allowlist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAll = ALLOWED_ORIGINS.length === 0;
  const allowed = allowAll || (origin && ALLOWED_ORIGINS.includes(origin));
  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Session-Id'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Serve static HTML
app.use(express.static(path.join(__dirname)));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/captcha-solver', (_req, res) => res.sendFile(path.join(__dirname, 'captcha-solver.html')));
app.get('/recaptcha-test', (_req, res) => res.sendFile(path.join(__dirname, 'recaptcha-test.html')));
app.get('/hcaptcha-test', (_req, res) => res.sendFile(path.join(__dirname, 'hcaptcha-test.html')));

// Helpers
async function createSession() {
  const sessionId = uuidv4();
  await pool.query(
    'INSERT INTO admin_sessions (session_id, created_at) VALUES ($1, NOW()) ON CONFLICT (session_id) DO NOTHING',
    [sessionId]
  );
  return sessionId;
}

async function createSolverSession(workerId) {
  const sessionId = uuidv4();
  await pool.query(
    'INSERT INTO solver_sessions (session_id, worker_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (session_id) DO NOTHING',
    [sessionId, workerId || null]
  );
  return sessionId;
}

async function createDmUserSession(userId) {
  const sessionId = uuidv4();
  await pool.query(
    'INSERT INTO dm_user_sessions (session_id, user_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (session_id) DO NOTHING',
    [sessionId, userId]
  );
  return sessionId;
}

const requireAdmin = asyncHandler(async (req, res, next) => {
  const sessionId =
    req.query.session_id ||
    req.body.session_id ||
    req.headers['x-session-id'];
  if (!sessionId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { rowCount } = await pool.query('SELECT 1 FROM admin_sessions WHERE session_id=$1', [sessionId]);
  if (!rowCount) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  req.sessionId = sessionId;
  next();
});

const requireSolver = asyncHandler(async (req, res, next) => {
  const sessionId =
    req.query.solver_session ||
    req.body?.solver_session ||
    req.headers['x-solver-session'];
  if (!sessionId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { rowCount } = await pool.query('SELECT 1 FROM solver_sessions WHERE session_id=$1', [sessionId]);
  if (!rowCount) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  req.solverSessionId = sessionId;
  next();
});

const requireDmUser = asyncHandler(async (req, res, next) => {
  const sessionId =
    req.query.dm_session ||
    req.body?.dm_session ||
    req.headers['x-dm-session'];
  if (!sessionId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { rows } = await pool.query('SELECT user_id FROM dm_user_sessions WHERE session_id=$1', [sessionId]);
  if (!rows.length) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  req.dmUserId = rows[0].user_id;
  next();
});

async function getActiveWorkers() {
  const { rows } = await pool.query(
    'SELECT * FROM workers WHERE last_active >= NOW() - INTERVAL \'5 minutes\''
  );
  return rows.map(normalizeWorker);
}

async function assignTasksToWorker(workerId) {
  if (!workerId) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      "SELECT * FROM tasks WHERE status='pending' AND assigned_to=$1 ORDER BY created ASC",
      [workerId]
    );
    let rows = currentRes.rows;

    if (rows.length < MAX_TASKS_PER_WORKER) {
      const need = MAX_TASKS_PER_WORKER - rows.length;
      const assignRes = await client.query(
        `
        WITH cte AS (
          SELECT id FROM tasks
          WHERE status='pending' AND assigned_to IS NULL
          ORDER BY created ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE tasks t SET assigned_to=$1
        FROM cte
        WHERE t.id = cte.id
        RETURNING t.*;
        `,
        [workerId, need]
      );
      rows = rows.concat(assignRes.rows);
    }

    await client.query('COMMIT');
    return rows.map(normalizeTask);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function buildStatsPayload() {
  const workersRes = await pool.query('SELECT * FROM workers');
  const workers = workersRes.rows.map(normalizeWorker);
  const activeWorkers = workers.filter(
    (w) => w.last_active && Date.now() - w.last_active <= FIVE_MINUTES
  );
  const recentTasksRes = await pool.query('SELECT * FROM tasks ORDER BY created DESC LIMIT 100');
  const recentTasks = recentTasksRes.rows.map(normalizeTask);
  const pendingCountRes = await pool.query("SELECT COUNT(*) AS cnt FROM tasks WHERE status='pending'");
  const solvedSumRes = await pool.query('SELECT COALESCE(SUM(solved_count),0) AS total FROM workers');
  return {
    total_solved: Number(solvedSumRes.rows[0].total || 0),
    active_workers: activeWorkers.length,
    active_worker_ids: activeWorkers.map((w) => w.id),
    total_workers: workers.length,
    pending_tasks: Number(pendingCountRes.rows[0].cnt || 0),
    workers,
    recent_tasks: recentTasks,
  };
}

// Admin API
app.post('/api/admin/login', asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  const session_id = await createSession();
  return res.json({ success: true, session_id });
}));

// Solver login
app.post('/api/solver/login', asyncHandler(async (req, res) => {
  const { password, workerId, name, deviceInfo } = req.body || {};
  if (password !== SOLVER_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  const wid = workerId || `worker-${uuidv4()}`;
  await pool.query(
    `INSERT INTO workers (id, name, solved_count, device_info, first_seen, last_active)
     VALUES ($1, $2, 0, $3, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE($2, workers.name),
       device_info = COALESCE($3, workers.device_info),
       last_active = NOW()`,
    [wid, name || 'Worker', deviceInfo || null]
  );
  const session_id = await createSolverSession(wid);
  res.json({ success: true, solver_session: session_id, workerId: wid, name: name || 'Worker' });
}));

app.get('/api/admin/stats', requireAdmin, asyncHandler(async (_req, res) => {
  const stats = await buildStatsPayload();
  res.json({ success: true, stats });
}));

app.post('/api/admin/reset-worker', requireAdmin, asyncHandler(async (req, res) => {
  const { workerId } = req.body || {};
  if (!workerId) return res.json({ success: false, message: 'workerId required' });
  const result = await pool.query('UPDATE workers SET solved_count=0 WHERE id=$1', [workerId]);
  if (result.rowCount === 0) return res.json({ success: false, message: 'Worker not found' });
  res.json({ success: true, message: `Worker ${workerId} reset` });
}));

app.post('/api/admin/remove-worker', requireAdmin, asyncHandler(async (req, res) => {
  const { workerId } = req.body || {};
  if (!workerId) return res.json({ success: false, message: 'workerId required' });
  const result = await pool.query('DELETE FROM workers WHERE id=$1', [workerId]);
  res.json({
    success: result.rowCount > 0,
    message: result.rowCount > 0 ? `Worker ${workerId} removed` : 'Worker not found',
  });
}));

app.post('/api/admin/reset-all-workers', requireAdmin, asyncHandler(async (_req, res) => {
  await pool.query('UPDATE workers SET solved_count=0');
  res.json({ success: true, message: 'All workers reset' });
}));

// Simple task ingestion (persistent)
app.post('/api/tasks', asyncHandler(async (req, res) => {
  const { siteKey, rqdata, assigned_to } = req.body || {};
  if (!siteKey) return res.status(400).json({ success: false, message: 'siteKey required' });
  const id = uuidv4();
  const result = await pool.query(
    `INSERT INTO tasks (id, site_key, rqdata, status, assigned_to)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING *`,
    [id, siteKey, rqdata || null, assigned_to || null]
  );
  res.json({ success: true, task: normalizeTask(result.rows[0]) });
}));

// Optional: list all tasks (admin only)
app.get('/api/tasks', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created DESC');
  res.json({ success: true, tasks: rows.map(normalizeTask) });
}));

// Worker + task API
app.post('/api/register-worker', asyncHandler(async (req, res) => {
  const { workerId, name, deviceInfo } = req.body || {};
  if (!workerId) return res.status(400).json({ success: false, message: 'workerId required' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
  await pool.query(
    `INSERT INTO workers (id, name, solved_count, device_info, first_seen, last_active, ip)
     VALUES ($1, $2, 0, $3, NOW(), NOW(), $4)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       device_info = EXCLUDED.device_info,
       last_active = NOW(),
       ip = COALESCE(EXCLUDED.ip, workers.ip)`,
    [workerId, name || 'Worker', deviceInfo || null, ip]
  );
  res.json({ success: true });
}));

app.get('/api/pending-tasks', requireSolver, asyncHandler(async (req, res) => {
  const { workerId } = req.query;
  const wid = workerId || null;
  if (!wid) return res.status(400).json({ success: false, message: 'workerId required' });

  const assigned = await assignTasksToWorker(wid);
  res.json(assigned);
}));

app.get('/api/worker-stats', asyncHandler(async (req, res) => {
  const { workerId } = req.query;
  if (!workerId) return res.json({ success: false, message: 'workerId required' });
  const workerRes = await pool.query('SELECT * FROM workers WHERE id=$1', [workerId]);
  if (workerRes.rowCount === 0) return res.json({ success: false, message: 'Worker not found' });
  res.json({ success: true, worker: normalizeWorker(workerRes.rows[0]) });
}));

app.get('/api/active-workers', asyncHandler(async (_req, res) => {
  const active = await getActiveWorkers();
  res.json({ success: true, workers: active, count: active.length });
}));

// DM user/token/proxy management (admin)
app.post('/api/dm/user', requireAdmin, asyncHandler(async (req, res) => {
  const { user_id, name, password } = req.body || {};
  if (!user_id) return res.status(400).json({ success: false, message: 'user_id required' });
  const pwd = (password || '').trim();
  const existing = await pool.query('SELECT 1 FROM dm_users WHERE id=$1', [user_id]);
  if (!existing.rowCount && !pwd) {
    return res.status(400).json({ success: false, message: 'password required for new user' });
  }
  await pool.query(
    `INSERT INTO dm_users (id, name, password, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET 
       name = COALESCE($2, dm_users.name),
       password = COALESCE($3, dm_users.password)`,
    [user_id, name || null, pwd || null]
  );
  res.json({ success: true });
}));

app.get('/api/dm/users', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, created_at FROM dm_users ORDER BY created_at DESC');
  res.json({ success: true, users: rows });
}));

app.post('/api/dm/token', requireAdmin, asyncHandler(async (req, res) => {
  const { user_id, token } = req.body || {};
  if (!user_id || !token) return res.status(400).json({ success: false, message: 'user_id and token required' });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO dm_tokens (id, user_id, token, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [id, user_id, token]
  );
  res.json({ success: true, id });
}));

app.post('/api/dm/proxy', requireAdmin, asyncHandler(async (req, res) => {
  const { user_id, proxy } = req.body || {};
  if (!user_id || !proxy) return res.status(400).json({ success: false, message: 'user_id and proxy required' });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO dm_proxies (id, user_id, proxy, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [id, user_id, proxy]
  );
  res.json({ success: true, id });
}));

app.get('/api/dm/tokens', requireAdmin, asyncHandler(async (req, res) => {
  const { user_id } = req.query;
  const { rows } = await pool.query(
    user_id ? 'SELECT * FROM dm_tokens WHERE user_id=$1 ORDER BY created_at DESC' : 'SELECT * FROM dm_tokens ORDER BY created_at DESC',
    user_id ? [user_id] : []
  );
  res.json({ success: true, tokens: rows });
}));

app.get('/api/dm/proxies', requireAdmin, asyncHandler(async (req, res) => {
  const { user_id } = req.query;
  const { rows } = await pool.query(
    user_id ? 'SELECT * FROM dm_proxies WHERE user_id=$1 ORDER BY created_at DESC' : 'SELECT * FROM dm_proxies ORDER BY created_at DESC',
    user_id ? [user_id] : []
  );
  res.json({ success: true, proxies: rows });
}));

app.delete('/api/dm/token/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM dm_tokens WHERE id=$1', [id]);
  res.json({ success: result.rowCount > 0 });
}));

app.delete('/api/dm/proxy/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM dm_proxies WHERE id=$1', [id]);
  res.json({ success: result.rowCount > 0 });
}));

// DM user-facing APIs
app.post('/api/dm/user/login', asyncHandler(async (req, res) => {
  const { user_id, password } = req.body || {};
  const pwd = (password || '').trim();
  if (!user_id || !pwd) return res.status(400).json({ success: false, message: 'user_id and password required' });
  const { rows } = await pool.query('SELECT * FROM dm_users WHERE id=$1', [user_id]);
  if (!rows.length || rows[0].password !== pwd) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
  const dm_session = await createDmUserSession(user_id);
  res.json({ success: true, dm_session, user: { id: user_id, name: rows[0].name || '' } });
}));

app.post('/api/dm/user/register', asyncHandler(async (req, res) => {
  const { user_id, name, password } = req.body || {};
  const pwd = (password || '').trim();
  if (!user_id || !pwd) return res.status(400).json({ success: false, message: 'user_id and password required' });
  await pool.query(
    `INSERT INTO dm_users (id, name, password, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE($2, dm_users.name),
       password = COALESCE($3, dm_users.password)`,
    [user_id, name || null, pwd]
  );
  const dm_session = await createDmUserSession(user_id);
  res.json({ success: true, dm_session, user: { id: user_id, name: name || '' } });
}));

app.post('/api/dm/user/token', requireDmUser, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, message: 'token required' });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO dm_tokens (id, user_id, token, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [id, req.dmUserId, token]
  );
  res.json({ success: true, id });
}));

app.post('/api/dm/user/token/bulk', requireDmUser, asyncHandler(async (req, res) => {
  const list = (req.body?.tokens || req.body?.list || []).filter(Boolean);
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ success: false, message: 'tokens array required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of list) {
      const id = uuidv4();
      await client.query(
        `INSERT INTO dm_tokens (id, user_id, token, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [id, req.dmUserId, t]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, inserted: list.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/dm/user/proxy', requireDmUser, asyncHandler(async (req, res) => {
  const { proxy } = req.body || {};
  if (!proxy) return res.status(400).json({ success: false, message: 'proxy required' });
  const id = uuidv4();
  await pool.query(
    `INSERT INTO dm_proxies (id, user_id, proxy, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [id, req.dmUserId, proxy]
  );
  res.json({ success: true, id });
}));

app.post('/api/dm/user/proxy/bulk', requireDmUser, asyncHandler(async (req, res) => {
  const list = (req.body?.proxies || req.body?.list || []).filter(Boolean);
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ success: false, message: 'proxies array required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of list) {
      const id = uuidv4();
      await client.query(
        `INSERT INTO dm_proxies (id, user_id, proxy, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [id, req.dmUserId, p]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, inserted: list.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/dm/job/start', requireDmUser, asyncHandler(async (req, res) => {
  const { 
    message, 
    cap, 
    invite_code
  } = req.body || {};
  
  if (!message || !message.trim()) return res.status(400).json({ success: false, message: 'message required' });
  
  // Clean invite code
  let cleanInvite = null;
  if (invite_code) {
    cleanInvite = invite_code
      .replace(/https?:\/\/(www\.)?discord\.gg\//i, '')
      .replace(/https?:\/\/discord\.com\/invite\//i, '')
      .trim();
  }
  
  const id = uuidv4();
  const now = new Date();
  await pool.query(
    `INSERT INTO dm_jobs (id, user_id, message, cap, invite_code, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'running',$6,$6)`,
    [id, req.dmUserId, message.trim(), cap || 0, cleanInvite, now]
  );
  // Provide counts to caller
  const tokensRes = await pool.query('SELECT COUNT(*) AS c FROM dm_tokens WHERE user_id=$1', [req.dmUserId]);
  const proxiesRes = await pool.query('SELECT COUNT(*) AS c FROM dm_proxies WHERE user_id=$1', [req.dmUserId]);
  
  // Start job execution asynchronously
  executeDmJob(id, req.dmUserId).catch(err => {
    console.error(`Failed to start job ${id}:`, err);
  });
  
  res.json({
    success: true,
    job_id: id,
    tokens: Number(tokensRes.rows[0].c || 0),
    proxies: Number(proxiesRes.rows[0].c || 0)
  });
}));

app.post('/api/dm/job/stop', requireDmUser, asyncHandler(async (req, res) => {
  const { job_id } = req.body || {};
  if (!job_id) return res.status(400).json({ success: false, message: 'job_id required' });
  
  // Stop the active job if running
  const activeJob = activeJobs.get(job_id);
  if (activeJob) {
    activeJob.status = 'stopped';
    if (activeJob.controller) {
      activeJob.controller.abort();
    }
    await logDmEvent(job_id, 'info', '🛑 Job stopped by user');
  }
  
  const result = await pool.query(
    `UPDATE dm_jobs SET status='stopped', updated_at=NOW() WHERE id=$1 AND user_id=$2`,
    [job_id, req.dmUserId]
  );
  res.json({ success: result.rowCount > 0 });
}));

app.get('/api/dm/job/status', requireDmUser, asyncHandler(async (req, res) => {
  const { job_id } = req.query;
  if (!job_id) return res.status(400).json({ success: false, message: 'job_id required' });
  const jobRes = await pool.query('SELECT * FROM dm_jobs WHERE id=$1 AND user_id=$2', [job_id, req.dmUserId]);
  if (!jobRes.rowCount) return res.status(404).json({ success: false, message: 'Job not found' });
  
  // Get recent logs for this job (last 100 entries)
  const logsRes = await pool.query(
    'SELECT id, job_id, log_type, message, created_at FROM dm_logs WHERE job_id=$1 ORDER BY created_at ASC LIMIT 100',
    [job_id]
  );
  
  console.log(`[STATUS] Job ${job_id.substring(0, 8)}: ${jobRes.rows[0].status}, ${logsRes.rowCount} logs`);
  
  // Echo counts for UI
  const tokensRes = await pool.query('SELECT COUNT(*) AS c FROM dm_tokens WHERE user_id=$1', [req.dmUserId]);
  const proxiesRes = await pool.query('SELECT COUNT(*) AS c FROM dm_proxies WHERE user_id=$1', [req.dmUserId]);
  res.json({
    success: true,
    job: jobRes.rows[0],
    logs: logsRes.rows, // Already in chronological order
    tokens: Number(tokensRes.rows[0].c || 0),
    proxies: Number(proxiesRes.rows[0].c || 0)
  });
}));

app.get('/api/dm/user/tokens', requireDmUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM dm_tokens WHERE user_id=$1 ORDER BY created_at DESC', [req.dmUserId]);
  res.json({ success: true, tokens: rows });
}));

app.get('/api/dm/user/proxies', requireDmUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM dm_proxies WHERE user_id=$1 ORDER BY created_at DESC', [req.dmUserId]);
  res.json({ success: true, proxies: rows });
}));

app.delete('/api/dm/user/token/:id', requireDmUser, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM dm_tokens WHERE id=$1 AND user_id=$2', [id, req.dmUserId]);
  res.json({ success: result.rowCount > 0 });
}));

app.delete('/api/dm/user/proxy/:id', requireDmUser, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM dm_proxies WHERE id=$1 AND user_id=$2', [id, req.dmUserId]);
  res.json({ success: result.rowCount > 0 });
}));

app.delete('/api/dm/user/tokens/all', requireDmUser, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM dm_tokens WHERE user_id=$1', [req.dmUserId]);
  console.log(`[DM] User ${req.dmUserId} deleted all ${result.rowCount} tokens`);
  res.json({ success: true, deleted: result.rowCount });
}));

app.delete('/api/dm/user/proxies/all', requireDmUser, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM dm_proxies WHERE user_id=$1', [req.dmUserId]);
  console.log(`[DM] User ${req.dmUserId} deleted all ${result.rowCount} proxies`);
  res.json({ success: true, deleted: result.rowCount });
}));

app.post('/api/dm/user/validate-tokens', requireDmUser, asyncHandler(async (req, res) => {
  const tokensRes = await pool.query('SELECT id, token FROM dm_tokens WHERE user_id=$1', [req.dmUserId]);
  
  if (!tokensRes.rowCount) {
    return res.json({ success: true, validated: 0, valid: 0, invalid: 0 });
  }

  let validCount = 0;
  let invalidCount = 0;

  for (const tokenEntry of tokensRes.rows) {
    const validation = await validateToken(tokenEntry.token, tokenEntry.id);
    if (validation.valid) {
      validCount++;
    } else {
      invalidCount++;
    }
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`[DM] User ${req.dmUserId} validated ${tokensRes.rowCount} tokens: ${validCount} valid, ${invalidCount} invalid`);
  res.json({ 
    success: true, 
    validated: tokensRes.rowCount,
    valid: validCount,
    invalid: invalidCount
  });
}));

// Debug endpoint to view generated fingerprint
app.get('/api/dm/debug/fingerprint', requireDmUser, asyncHandler(async (req, res) => {
  const fingerprint = generateDiscordFingerprint();
  const decoded = JSON.parse(Buffer.from(fingerprint, 'base64').toString('utf-8'));
  res.json({ 
    success: true, 
    fingerprint_base64: fingerprint,
    fingerprint_decoded: decoded
  });
}));

async function fetchJsonWithToken(url, token, proxyAgent) {
  const resp = await fetch(url, {
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    },
    agent: proxyAgent
  });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

app.post('/api/dm/user/scrape-members', requireDmUser, asyncHandler(async (req, res) => {
  const { invite } = req.body || {};
  if (!invite) return res.status(400).json({ success: false, message: '❌ Invite code required' });

  // Get ALL available tokens for this user
  const tokensRes = await pool.query('SELECT token FROM dm_tokens WHERE user_id=$1 ORDER BY created_at DESC', [req.dmUserId]);
  if (!tokensRes.rowCount) return res.status(400).json({ success: false, message: '❌ No tokens available. Please upload tokens first.' });
  
  const tokens = tokensRes.rows.map(r => r.token).filter(Boolean);
  let inviteCode = invite.replace(/https?:\/\/(www\.)?discord\.gg\//i, '').replace(/https?:\/\/discord\.com\/invite\//i, '').trim();
  const { channel_id } = req.body || {};
  
  // Get proxies for scraper
  const proxiesRes = await pool.query('SELECT proxy FROM dm_proxies WHERE user_id=$1 ORDER BY created_at DESC', [req.dmUserId]);
  const proxies = proxiesRes.rows.map(r => r.proxy).filter(Boolean);
  
  console.log(`[SCRAPER] User ${req.dmUserId} scraping invite: ${inviteCode} with ${tokens.length} token(s), ${proxies.length} proxies${channel_id ? ` (channel: ${channel_id})` : ''}`);
  
  // Call scraper service with all tokens and proxies
  const scraperUrl = process.env.SCRAPER_SERVICE_URL || 'http://192.168.1.11:8600/scrape';
  const scrapeResp = await fetch(scraperUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens, invite: inviteCode, channel_id, proxies })
  });
  
  let result;
  try {
    result = await scrapeResp.json();
  } catch (parseErr) {
    const text = await scrapeResp.text().catch(() => 'Unable to read response');
    console.log(`[SCRAPER] Failed to parse JSON: ${text.substring(0, 200)}`);
    return res.status(scrapeResp.status || 500).json({ 
      success: false, 
      message: '❌ Scraper service returned invalid response' 
    });
  }
  
  if (!scrapeResp.ok || !result.success) {
    console.log(`[SCRAPER] Failed: ${result.error || 'Unknown error'}`);
    return res.status(scrapeResp.status || 500).json({ 
      success: false, 
      message: result.error || '❌ Scraper service failed' 
    });
  }

  // Save members to database
  const guildId = result.guild_id;
  const members = result.members || [];
  
  console.log(`[SCRAPER] Scraped ${members.length} members from guild ${guildId}`);
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const mid of members) {
      const insertResult = await client.query(
        `INSERT INTO dm_members (id, user_id, guild_id, member_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, member_id) DO NOTHING
         RETURNING id`,
        [uuidv4(), req.dmUserId, guildId, mid]
      );
      if (insertResult.rowCount > 0) inserted++;
    }
    
    // Update token status based on scraper results
    if (result.invalid_tokens && result.invalid_tokens.length > 0) {
      console.log(`[SCRAPER] Marking ${result.invalid_tokens.length} tokens as invalid`);
      for (const invalidToken of result.invalid_tokens) {
        await client.query(
          `UPDATE dm_tokens SET status = 'invalid' WHERE user_id = $1 AND token LIKE $2`,
          [req.dmUserId, invalidToken + '%']
        );
      }
    }
    
    if (result.tokens_used > 0) {
      // Mark successfully used tokens as valid
      console.log(`[SCRAPER] Marking ${result.tokens_used} tokens as valid`);
      await client.query(
        `UPDATE dm_tokens SET status = 'valid' 
         WHERE user_id = $1 AND status != 'invalid'`,
        [req.dmUserId]
      );
    }
    
    await client.query('COMMIT');
    console.log(`[SCRAPER] Inserted ${inserted} new members (${members.length - inserted} duplicates)`);
    
    const invalidCount = result.invalid_tokens ? result.invalid_tokens.length : 0;
    
    res.json({ 
      success: true, 
      guild_id: guildId, 
      inserted: inserted,
      total: members.length,
      tokens_used: result.tokens_used || 1,
      tokens_total: result.tokens_total || 1,
      invalid_count: invalidCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/api/dm/user/members', requireDmUser, asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5000, 20000);
  const { rows } = await pool.query(
    'SELECT member_id, guild_id, created_at FROM dm_members WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [req.dmUserId, limit]
  );
  res.json({ success: true, members: rows });
}));

app.delete('/api/dm/user/members', requireDmUser, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM dm_members WHERE user_id=$1', [req.dmUserId]);
  res.json({ success: true });
}));

app.post('/api/dm/user/members', requireDmUser, asyncHandler(async (req, res) => {
  const list = (req.body?.members || []).filter(Boolean);
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ success: false, message: 'members array required' });
  }
  const guildId = req.body?.guild_id || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const mid of list) {
      await client.query(
        `INSERT INTO dm_members (id, user_id, guild_id, member_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, member_id) DO NOTHING`,
        [uuidv4(), req.dmUserId, guildId, mid]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, inserted: list.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));


app.post('/api/solve-task', asyncHandler(async (req, res) => {
  const { taskId, token, workerId } = req.body || {};
  if (!taskId || !token || !workerId) {
    return res.status(400).json({ success: false, message: 'taskId, token, workerId required' });
  }
  const result = await pool.query(
    `UPDATE tasks
     SET status='solved', solved=NOW(), solved_by=$1, token=$2
     WHERE id=$3
     RETURNING *`,
    [workerId, token, taskId]
  );
  if (result.rowCount === 0) return res.json({ success: false, message: 'Task not found' });

  await pool.query(
    'UPDATE workers SET solved_count = COALESCE(solved_count,0) + 1, last_active = NOW() WHERE id=$1',
    [workerId]
  );

  res.json({ success: true, message: 'Task solved recorded' });
}));

// Public result polling for a task
app.get('/api/task-result', asyncHandler(async (req, res) => {
  const { taskId } = req.query;
  if (!taskId) return res.status(400).json({ success: false, message: 'taskId required' });
  const result = await pool.query('SELECT * FROM tasks WHERE id=$1', [taskId]);
  if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Task not found' });
  const task = normalizeTask(result.rows[0]);
  return res.json({
    success: true,
    status: task.status,
    token: task.token || null,
    solved_by: task.solved_by || null,
  });
}));

// HTTP server + WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function emitWorkerStats(ws) {
  const workersRes = await pool.query('SELECT * FROM workers');
  const workers = workersRes.rows.map(normalizeWorker);
  const active = workers.filter(
    (w) => w.last_active && Date.now() - w.last_active <= FIVE_MINUTES
  );
  sendJson(ws, {
    type: 'worker_stats',
    stats: workers,
    active_workers: active.length,
  });
}

async function emitWorkerInfo(ws, workerId) {
  const workerRes = await pool.query('SELECT * FROM workers WHERE id=$1', [workerId]);
  if (workerRes.rowCount === 0) return;
  sendJson(ws, { type: 'worker_info', worker: normalizeWorker(workerRes.rows[0]) });
}

async function emitTasks(ws, workerId) {
  const assigned = await assignTasksToWorker(workerId);
  sendJson(ws, { type: 'tasks', tasks: assigned });
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const workerId = url.searchParams.get('workerId');
  const solverSession = url.searchParams.get('solverSession');
  const name = url.searchParams.get('name') || 'Worker';
  const deviceInfoRaw = url.searchParams.get('deviceInfo');

  if (!workerId || !solverSession) {
    ws.close(1008, 'workerId required');
    return;
  }

  try {
    const { rowCount } = await pool.query('SELECT 1 FROM solver_sessions WHERE session_id=$1', [solverSession]);
    if (!rowCount) {
      ws.close(1008, 'Unauthorized');
      return;
    }
  } catch (err) {
    ws.close(1011, 'Server error');
    return;
  }

  let deviceInfo = null;
  if (deviceInfoRaw) {
    try {
      deviceInfo = JSON.parse(deviceInfoRaw);
    } catch (e) {
      deviceInfo = null;
    }
  }

  // Upsert worker on connect
  try {
    await pool.query(
      `INSERT INTO workers (id, name, solved_count, device_info, first_seen, last_active)
       VALUES ($1, $2, 0, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         device_info = EXCLUDED.device_info,
         last_active = NOW()`,
      [workerId, name, deviceInfo]
    );
  } catch (err) {
    console.error('Failed to upsert worker on WS connect', err);
  }

  await emitWorkerInfo(ws, workerId);
  await emitWorkerStats(ws);
  await emitTasks(ws, workerId);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'refresh') {
        await emitTasks(ws, workerId);
        await emitWorkerStats(ws);
      } else if (data.type === 'solved') {
        const { taskId, token } = data;
        if (taskId && token) {
          const result = await pool.query(
            `UPDATE tasks
             SET status='solved', solved=NOW(), solved_by=$1, token=$2
             WHERE id=$3
             RETURNING *`,
            [workerId, token, taskId]
          );
          if (result.rowCount > 0) {
            await pool.query(
              'UPDATE workers SET solved_count = COALESCE(solved_count,0) + 1, last_active = NOW() WHERE id=$1',
              [workerId]
            );
            await emitWorkerStats(ws);
          }
        }
      }
    } catch (err) {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    // No cleanup needed
  });
});

async function expireOldTasks() {
  try {
    const res = await pool.query(
      "UPDATE tasks SET status='expired' WHERE status='pending' AND created < NOW() - INTERVAL '150 seconds' RETURNING id"
    );
    if (res.rowCount > 0) {
      console.log(`Expired ${res.rowCount} captcha tasks (timeout reached)`);
    }
  } catch (err) {
    console.error('Error expiring old tasks', err.message);
  }
}

// Boot sequence
async function start() {
  await ensureSchema();
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  setInterval(expireOldTasks, 30_000);
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});

