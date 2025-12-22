import os
import sys
import json
import asyncio
import time
import requests
from flask import Flask, request, jsonify
from threading import Thread
import discord

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
    def __init__(self, invite_code, result_dict, channel_id=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.invite_code = invite_code
        self.result = result_dict
        self.target_channel_id = channel_id

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
                    site_key = "4c672d35-0701-42b2-88c3-78380b0db560"  # Discord's hcaptcha site key
                    rqdata = None
                    sitekey_from_response = None
                    
                    # discord.py HTTPException has a .json attribute with the error data
                    error_json = None
                    
                    # The exception has a .json attribute!
                    if hasattr(e, 'json') and e.json:
                        error_json = e.json
                        print(f"Error JSON: {error_json}")
                    else:
                        print(f"No JSON data in exception")
                    
                    if error_json:
                        rqdata = error_json.get("captcha_rqdata")
                        rqtoken = error_json.get("captcha_rqtoken")
                        sitekey_from_response = error_json.get("captcha_sitekey")
                        if sitekey_from_response:
                            site_key = sitekey_from_response
                    else:
                        print(f"Could not extract captcha data")
                        rqdata = None
                        rqtoken = None
                    
                    print(f"📋 Extracted rqdata: {rqdata[:50] if rqdata else None}...")
                    print(f"📋 Extracted rqtoken: {rqtoken[:50] if rqtoken else None}...")
                    print(f"🔑 Using site_key: {site_key}")
                    print("⏳ Sending to captcha solver...")
                    
                    # Solve the captcha using our service (blocking call)
                    captcha_token = await asyncio.to_thread(solve_captcha, site_key, rqdata)
                    
                    if not captcha_token:
                        print("❌ CAPTCHA SOLVING FAILED")
                        print("="*60 + "\n")
                        self.result["error"] = "Failed to solve captcha"
                        await self.close()
                        return
                    
                    print("✅ CAPTCHA SOLVED!")
                    print("="*60 + "\n")
                    
                    # Retry with captcha token - make direct HTTP request
                    try:
                        from discord.http import Route
                        
                        payload = {"captcha_key": captcha_token}
                        if rqtoken:
                            payload["captcha_rqtoken"] = rqtoken
                        
                        print(f"Submitting captcha with payload keys: {list(payload.keys())}")
                        route = Route("POST", f"/invites/{self.invite_code}")
                        await self.http.request(route, json=payload)
                        
                        print("Successfully joined with captcha!")
                        await asyncio.sleep(3)
                        guild = self.get_guild(guild_id)
                    except discord.HTTPException as retry_e:
                        print(f"Captcha retry failed: {retry_e.status} - {retry_e.text if hasattr(retry_e, 'text') else str(retry_e)}")
                        self.result["error"] = f"Failed to join after captcha: {str(retry_e)}"
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

async def run_scrape(token, invite_code, channel_id=None):
    result = {"success": False}
    
    try:
        client = ScraperClient(invite_code, result, channel_id)
        await client.start(token)
    except Exception as e:
        if not result.get("error"):
            result["error"] = f"Client exception: {str(e)}"
            
    return result

@app.route('/scrape', methods=['POST'])
def handle_scrape():
    print(f"Received scrape request")
    data = request.json
    if not data or 'token' not in data or 'invite' not in data:
        return jsonify({"success": False, "error": "Missing token or invite"}), 400
        
    token = data['token']
    invite = data['invite']
    channel_id = data.get('channel_id')
    print(f"Scraping invite {invite} with token {token[:10]}...{' (channel: ' + str(channel_id) + ')' if channel_id else ''}")
    
    # Run the async scrape in a new event loop for this request
    # Since Flask is synchronous by default, we use asyncio.run
    try:
        result = asyncio.run(run_scrape(token, invite, channel_id))
        print(f"Scrape result: {result.get('success')} {result.get('error')}")
        return jsonify(result)
    except Exception as e:
        print(f"Server exception: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8600))
    print(f"Starting scraper service on port {port}")
    app.run(host='0.0.0.0', port=port)

