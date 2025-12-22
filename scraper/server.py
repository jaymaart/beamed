import os
import sys
import json
import asyncio
import time
import requests
from flask import Flask, request, jsonify
from threading import Thread
import discord
import aiohttp

# Ensure unbuffered output
sys.stdout.reconfigure(encoding='utf-8')

app = Flask(__name__)

# Captcha solving configuration
CAPTCHA_API_BASE = os.environ.get('API_BASE', 'http://192.168.1.11:8204')
CAPTCHA_TIMEOUT = 150  # 2.5 minutes

def solve_captcha(site_key, rqdata=None):
    """Submit captcha to solving service and wait for solution"""
    try:
        # Submit the captcha task
        task_resp = requests.post(
            f"{CAPTCHA_API_BASE}/api/tasks",
            json={"siteKey": site_key, "rqdata": rqdata},
            timeout=10
        )
        
        if not task_resp.ok:
            print(f"Failed to submit captcha task: {task_resp.status_code}")
            return None
            
        task_data = task_resp.json()
        if not task_data.get("success"):
            print(f"Captcha task submission failed: {task_data}")
            return None
            
        task_id = task_data["task"]["id"]
        print(f"Captcha task submitted: {task_id}")
        
        # Poll for solution
        start_time = time.time()
        while time.time() - start_time < CAPTCHA_TIMEOUT:
            time.sleep(3)
            
            result_resp = requests.get(
                f"{CAPTCHA_API_BASE}/api/task-result",
                params={"taskId": task_id},
                timeout=10
            )
            
            if not result_resp.ok:
                continue
                
            result_data = result_resp.json()
            if result_data.get("status") == "solved":
                token = result_data.get("token")
                print(f"Captcha solved: {token[:20]}...")
                return token
                
        print("Captcha solving timed out")
        return None
        
    except Exception as e:
        print(f"Captcha solving error: {e}")
        return None

class ScraperClient(discord.Client):
    def __init__(self, invite_code, result_dict, channel_id=None, proxy=None, *args, **kwargs):
        # Create proxy connector if proxy is provided
        if proxy:
            connector = aiohttp.TCPConnector()
            kwargs['connector'] = connector
            kwargs['proxy'] = proxy
        
        super().__init__(*args, **kwargs)
        self.invite_code = invite_code
        self.result = result_dict
        self.target_channel_id = channel_id
        self.proxy = proxy

    async def setup_hook(self):
        # This runs when the client is setting up, after the loop is created
        asyncio.create_task(self.scrape_logic())

    async def scrape_logic(self):
        await self.wait_until_ready()
        
        try:
            invite = await self.fetch_invite(self.invite_code)
        except discord.NotFound:
            self.result["error"] = "Invite not found"
            await self.close()
            return

        guild_id = invite.guild.id if invite.guild else None
        if not guild_id:
            self.result["error"] = "Invite does not contain guild information"
            await self.close()
            return

        # Try to get the guild from cache first
        guild = self.get_guild(guild_id)
        
        # If not in cache, we need to join via the invite
        if not guild:
            try:
                await invite.accept()
                await asyncio.sleep(3)
                guild = self.get_guild(guild_id)
            except discord.HTTPException as e:
                # Check if it's a captcha error
                if e.status == 400 and "captcha" in str(e).lower():
                    print("Captcha required, solving...")
                    
                    # Extract captcha details from the error response
                    error_json = None
                    
                    # The exception has a .json attribute!
                    if hasattr(e, 'json') and e.json:
                        error_json = e.json
                        print(f"Error JSON: {error_json}")
                    else:
                        print(f"No JSON data in exception")
                        self.result["error"] = "Failed to extract captcha challenge data"
                        await self.close()
                        return
                    
                    # Extract all required captcha data from Discord's response
                    rqdata = error_json.get("captcha_rqdata")
                    rqtoken = error_json.get("captcha_rqtoken")
                    site_key = error_json.get("captcha_sitekey")
                    session_id = error_json.get("captcha_session_id")
                    
                    if not site_key or not rqtoken:
                        print(f"❌ Missing required captcha data")
                        self.result["error"] = "Incomplete captcha challenge data from Discord"
                        await self.close()
                        return
                    
                    print(f"📋 Extracted rqdata: {rqdata[:50] if rqdata else None}...")
                    print(f"📋 Extracted rqtoken: {rqtoken[:50] if rqtoken else None}...")
                    print(f"📋 Extracted session_id: {session_id}")
                    print(f"🔑 Using site_key: {site_key}")
                    print("⏳ Sending to captcha solver...")
                    
                    import time
                    solve_start = time.time()
                    
                    # Solve the captcha using our service (blocking call)
                    captcha_token = await asyncio.to_thread(solve_captcha, site_key, rqdata)
                    
                    solve_duration = time.time() - solve_start
                    print(f"⏱️ Captcha solved in {solve_duration:.1f}s")
                    
                    if not captcha_token:
                        print("❌ CAPTCHA SOLVING FAILED")
                        print("="*60 + "\n")
                        self.result["error"] = "Failed to solve captcha"
                        await self.close()
                        return
                    
                    # Check if solve took too long (captchas may expire)
                    if solve_duration > 120:
                        print("⚠️ WARNING: Captcha took over 2 minutes to solve - may be expired")
                    
                    print("✅ CAPTCHA SOLVED!")
                    print("="*60 + "\n")
                    
                    # Retry with captcha token - Discord expects captcha ONLY in headers
                    try:
                        from discord.http import Route
                        
                        # Discord API expects captcha data in custom headers
                        headers = {
                            "X-Captcha-Key": captcha_token,
                            "X-Captcha-Rqtoken": rqtoken
                        }
                        if session_id:
                            headers["X-Captcha-Session-Id"] = session_id
                        
                        # Empty body for invite acceptance
                        payload = {}
                        
                        print(f"Submitting captcha with headers: {list(headers.keys())}")
                        route = Route("POST", f"/invites/{self.invite_code}")
                        await self.http.request(route, json=payload, headers=headers)
                        
                        print("Successfully joined with captcha!")
                        await asyncio.sleep(3)
                        guild = self.get_guild(guild_id)
                    except discord.HTTPException as retry_e:
                        error_msg = retry_e.text if hasattr(retry_e, 'text') else str(retry_e)
                        print(f"Join attempt failed: {retry_e.status} - {error_msg}")
                        
                        # According to Discord docs:
                        # - 400 = Captcha rejected, need to solve again
                        # - 403 = Account banned/restricted or server blocks self-bots
                        # - 404 = Invite invalid/expired
                        
                        if retry_e.status == 400:
                            # Check if it's another captcha challenge
                            if hasattr(retry_e, 'json') and retry_e.json and 'captcha_key' in retry_e.json:
                                self.result["error"] = "Captcha solution rejected - server requires re-verification"
                            else:
                                self.result["error"] = f"Invalid request after captcha: {error_msg}"
                        elif retry_e.status == 403:
                            self.result["error"] = "Account restricted/banned or server blocks automated joins (403 Forbidden)"
                        elif retry_e.status == 404:
                            self.result["error"] = "Invite not found or expired"
                        else:
                            self.result["error"] = f"Join failed: {error_msg}"
                        await self.close()
                        return
                    except Exception as retry_e:
                        print(f"Captcha retry exception: {type(retry_e).__name__} - {str(retry_e)}")
                        self.result["error"] = f"Failed to join after captcha: {str(retry_e)}"
                        await self.close()
                        return
                else:
                    self.result["error"] = f"Failed to join guild: {str(e)}"
                    await self.close()
                    return
            except Exception as e:
                self.result["error"] = f"Failed to join guild: {str(e)}"
                await self.close()
                return
        
        if not guild:
            self.result["error"] = f"Could not access guild {guild_id} after join"
            await self.close()
            return

        members_data = []
        try:
            print(f"Guild has {len(guild.members)} initially cached members")
            
            # For self-bots, query members through the search endpoint
            try:
                print("Querying members from guild (this may take a while)...")
                
                # If specific channel ID provided, scrape from that channel
                if self.target_channel_id:
                    print(f"Using specific channel: {self.target_channel_id}")
                    channel = guild.get_channel(int(self.target_channel_id))
                    if channel:
                        # Scrape members from the channel's member list
                        seen_ids = set()
                        async for message in channel.history(limit=1000):
                            if message.author.id not in seen_ids and not message.author.bot:
                                members_data.append(str(message.author.id))
                                seen_ids.add(message.author.id)
                        print(f"Scraped {len(members_data)} unique members from channel")
                    else:
                        print(f"Channel {self.target_channel_id} not found")
                
                # If no channel specified or not enough members, query the whole guild
                if len(members_data) < 100:
                    print("Querying all guild members...")
                    # query_members needs a query string - use common letter to match many users
                    members = await guild.query_members(query='a', limit=1000)
                    print(f"Queried {len(members)} members with 'a'")
                    
                    seen = set(members_data)
                    for member in members:
                        if not member.bot and str(member.id) not in seen:
                            members_data.append(str(member.id))
                            seen.add(str(member.id))
                    
                    # Try other common letters to get more members
                    for letter in ['e', 's', 't', 'o', 'n']:
                        try:
                            more_members = await guild.query_members(query=letter, limit=1000)
                            for member in more_members:
                                if not member.bot and str(member.id) not in seen:
                                    members_data.append(str(member.id))
                                    seen.add(str(member.id))
                        except:
                            break
                    
                    print(f"Total queried: {len(members_data)} members")
                        
            except (AttributeError, Exception) as query_err:
                print(f"Member querying failed: {query_err}")
                # Fall back to fetching through channels if available
                try:
                    print("Trying alternative method: fetching through text channels...")
                    seen_ids = set(members_data) if members_data else set()
                    for channel in guild.text_channels[:5]:  # Limit to first 5 channels
                        try:
                            async for message in channel.history(limit=200):
                                if str(message.author.id) not in seen_ids and not message.author.bot:
                                    members_data.append(str(message.author.id))
                                    seen_ids.add(str(message.author.id))
                        except:
                            continue
                    print(f"Found {len(members_data)} unique members from messages")
                except Exception as fallback_err:
                    print(f"Fallback method failed: {fallback_err}")
                    print("Using cached members only")
                    for member in guild.members:
                        if not member.bot:
                            members_data.append(str(member.id))
            
            self.result["success"] = True
            self.result["guild_id"] = str(guild.id)
            self.result["members"] = members_data
            self.result["count"] = len(members_data)
            
        except Exception as e:
            self.result["error"] = f"Member scrape failed: {str(e)}"
        
        await self.close()

async def run_scrape(token, invite_code, channel_id=None, proxy=None):
    result = {"success": False}
    
    try:
        client = ScraperClient(invite_code, result, channel_id, proxy=proxy)
        await client.start(token)
    except Exception as e:
        if not result.get("error"):
            result["error"] = f"Client exception: {str(e)}"
            
    return result

async def run_scrape_multi(tokens, invite_code, channel_id=None, proxies=None):
    """Scrape using multiple tokens to gather more members"""
    all_members = set()
    guild_id = None
    successful_scrapes = 0
    failed_tokens = []
    proxies = proxies or []
    
    print(f"Starting multi-token scrape with {len(tokens)} tokens and {len(proxies)} proxies...")
    
    for idx, token in enumerate(tokens, 1):
        # Rotate through proxies (if available)
        proxy = None
        if proxies:
            proxy_str = proxies[(idx - 1) % len(proxies)]
            # Format proxy for aiohttp: convert host:port:user:pass to http://user:pass@host:port
            if not proxy_str.startswith('http'):
                parts = proxy_str.split(':')
                if len(parts) == 4:
                    # host:port:user:pass
                    host, port, user, password = parts
                    proxy = f"http://{user}:{password}@{host}:{port}"
                elif len(parts) == 2:
                    # host:port (no auth)
                    host, port = parts
                    proxy = f"http://{host}:{port}"
                else:
                    print(f"⚠️ Invalid proxy format: {proxy_str}")
                    proxy = None
            else:
                proxy = proxy_str
            
            if proxy:
                # Show proxy without password
                proxy_display = proxy.split('@')[-1] if '@' in proxy else proxy
                print(f"[Token {idx}/{len(tokens)}] Using proxy: {proxy_display}")
        
        print(f"\n{'='*60}")
        print(f"[Token {idx}/{len(tokens)}] 🔑 Attempting scrape with {token[:10]}...")
        print(f"{'='*60}")
        
        result = await run_scrape(token, invite_code, channel_id, proxy=proxy)
        
        if result.get("success"):
            successful_scrapes += 1
            guild_id = result.get("guild_id")
            members = result.get("members", [])
            new_members = len(members) - len(all_members & set(members))
            all_members.update(members)
            print(f"{'='*60}")
            print(f"[Token {idx}/{len(tokens)}] ✅ SUCCESS!")
            print(f"  └─ Added {new_members} new members (total: {len(all_members)})")
            print(f"{'='*60}")
        else:
            error = result.get("error", "Unknown error")
            
            # Determine error type for better logging
            error_type = "❌"
            if "Captcha" in error or "captcha" in error:
                error_type = "🔐 CAPTCHA FAILED"
            elif "Improper token" in error or "Unauthorized" in error:
                error_type = "🚫 INVALID TOKEN"
                failed_tokens.append(token[:15])
            elif "restricted" in error.lower() or "banned" in error.lower():
                error_type = "⛔ ACCOUNT BANNED"
                failed_tokens.append(token[:15])
            
            print(f"{'='*60}")
            print(f"[Token {idx}/{len(tokens)}] {error_type}")
            print(f"  └─ {error}")
            print(f"{'='*60}")
            
            # Continue with next token even if this one fails
        
        # Delay between tokens to avoid rate limits (longer after captcha)
        if idx < len(tokens):
            # Longer delay if we just solved a captcha
            delay = 10 if "Captcha" in str(result.get("error", "")) or "captcha" in str(result.get("error", "")).lower() else 3
            print(f"⏸️ Waiting {delay}s before next token...")
            await asyncio.sleep(delay)
    
    # Final summary
    print(f"\n{'='*60}")
    print(f"📊 SCRAPE SUMMARY")
    print(f"{'='*60}")
    print(f"  ✅ Successful tokens: {successful_scrapes}/{len(tokens)}")
    print(f"  ❌ Failed tokens: {len(tokens) - successful_scrapes}/{len(tokens)}")
    if failed_tokens:
        print(f"  🚫 Invalid/banned tokens: {len(failed_tokens)}")
    print(f"  👥 Total unique members: {len(all_members)}")
    print(f"{'='*60}\n")
    
    if len(all_members) == 0:
        return {"success": False, "error": "All tokens failed to scrape members"}
    
    return {
        "success": True,
        "guild_id": guild_id,
        "members": list(all_members),
        "count": len(all_members),
        "tokens_used": successful_scrapes,
        "tokens_total": len(tokens),
        "invalid_tokens": failed_tokens
    }

async def join_guild(token, invite_code, proxy=None):
    """Join a guild using discord.py-self with proper client session"""
    result = {"success": False}
    
    try:
        print(f"[JOIN] Logging in with token {token[:10]}...")
        
        # Create client with proxy if provided
        kwargs = {}
        if proxy:
            connector = aiohttp.TCPConnector()
            kwargs['connector'] = connector
            kwargs['proxy'] = proxy
        
        client = discord.Client(**kwargs)
        
        @client.event
        async def on_ready():
            try:
                print(f"[JOIN] Client ready as {client.user}")
                
                # Fetch and accept invite
                invite = await client.fetch_invite(invite_code)
                print(f"[JOIN] Found invite for {invite.guild.name if invite.guild else 'Unknown'}")
                
                # Accept the invite
                await invite.accept()
                print(f"[JOIN] Successfully joined guild!")
                
                result["success"] = True
                result["guild_id"] = str(invite.guild.id) if invite.guild else None
                
            except discord.errors.HTTPException as e:
                if "already a member" in str(e).lower():
                    print(f"[JOIN] Already a member")
                    result["success"] = True
                    result["already_member"] = True
                else:
                    print(f"[JOIN] HTTP Error: {e}")
                    result["error"] = str(e)
            except Exception as e:
                print(f"[JOIN] Error: {e}")
                result["error"] = str(e)
            finally:
                await client.close()
        
        # Start client (will trigger on_ready)
        await client.start(token)
        
    except discord.errors.LoginFailure:
        result["error"] = "Invalid token"
    except Exception as e:
        result["error"] = str(e)
    
    return result

@app.route('/join', methods=['POST'])
def handle_join():
    print(f"[JOIN] Received join request")
    data = request.json
    
    if not data or 'token' not in data or 'invite' not in data:
        return jsonify({"success": False, "error": "Missing token or invite"}), 400
    
    token = data['token']
    invite = data['invite']
    proxy = data.get('proxy')
    
    print(f"[JOIN] Joining invite {invite} with token {token[:10]}...{' (with proxy)' if proxy else ''}")
    
    try:
        result = asyncio.run(join_guild(token, invite, proxy))
        print(f"[JOIN] Result: {result.get('success')} - {result.get('error', 'OK')}")
        return jsonify(result)
    except Exception as e:
        print(f"[JOIN] Server exception: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/scrape', methods=['POST'])
def handle_scrape():
    print(f"Received scrape request")
    data = request.json
    
    # Accept either single token or multiple tokens
    tokens = data.get('tokens', [])
    if not tokens:
        token = data.get('token')
        if token:
            tokens = [token]
    
    if not data or not tokens or 'invite' not in data:
        return jsonify({"success": False, "error": "Missing tokens or invite"}), 400
        
    invite = data['invite']
    channel_id = data.get('channel_id')
    proxies = data.get('proxies', [])
    print(f"Scraping invite {invite} with {len(tokens)} token(s), {len(proxies)} proxies{' (channel: ' + str(channel_id) + ')' if channel_id else ''}")
    
    # Run the async scrape in a new event loop for this request
    # Since Flask is synchronous by default, we use asyncio.run
    try:
        result = asyncio.run(run_scrape_multi(tokens, invite, channel_id, proxies))
        print(f"Scrape result: {result.get('success')} - {result.get('count', 0)} members")
        return jsonify(result)
    except Exception as e:
        print(f"Server exception: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8600))
    print(f"Starting scraper service on port {port}")
    app.run(host='0.0.0.0', port=port)

