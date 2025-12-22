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
    def __init__(self, invite_code, result_dict, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.invite_code = invite_code
        self.result = result_dict

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
                    
                    # discord.py HTTPException should have the JSON data
                    # Try multiple ways to get it
                    error_json = None
                    
                    # Check all attributes
                    print(f"Exception attributes: {dir(e)}")
                    
                    # Try code attribute (discord.py stores error data here)
                    if hasattr(e, 'code') and hasattr(e, 'response'):
                        if isinstance(e.response, dict):
                            error_json = e.response
                    
                    # Try response directly
                    if not error_json and hasattr(e, 'response'):
                        if isinstance(e.response, dict):
                            error_json = e.response
                        else:
                            print(f"e.response is type: {type(e.response)}")
                    
                    # Try text as JSON
                    if not error_json and hasattr(e, 'text') and e.text:
                        try:
                            error_json = json.loads(e.text)
                        except:
                            pass
                    
                    # Try accessing response._json or response.data
                    if not error_json and hasattr(e, 'response') and hasattr(e.response, '_json'):
                        error_json = e.response._json
                    
                    if error_json:
                        print(f"Error JSON: {error_json}")
                        rqdata = error_json.get("captcha_rqdata")
                        sitekey_from_response = error_json.get("captcha_sitekey")
                        if sitekey_from_response:
                            site_key = sitekey_from_response
                    else:
                        print(f"Could not parse error JSON")
                        print(f"e.text: {e.text if hasattr(e, 'text') else 'N/A'}")
                    
                    print(f"Extracted rqdata: {rqdata}")
                    print(f"Using site_key: {site_key}")
                    
                    # Solve the captcha using our service (blocking call)
                    captcha_token = await asyncio.to_thread(solve_captcha, site_key, rqdata)
                    
                    if not captcha_token:
                        self.result["error"] = "Failed to solve captcha"
                        await self.close()
                        return
                    
                    # Retry with captcha token - make direct HTTP request
                    try:
                        from discord.http import Route
                        
                        payload = {"captcha_key": captcha_token}
                        if rqdata:
                            payload["captcha_rqtoken"] = rqdata
                        
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
            # Chunk the guild to load all members
            if not guild.chunked:
                await guild.chunk()
            
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

async def run_scrape(token, invite_code):
    result = {"success": False}
    
    try:
        client = ScraperClient(invite_code, result)
        await client.start(token)
    except Exception as e:
        if not result.get("error"):
            result["error"] = f"Client exception: {str(e)}"
            
    return result

@app.route('/scrape', methods=['POST'])
def handle_scrape():
    print(f"Received scrape request")
    data = request.json
    if not data or 'invite' not in data:
        return jsonify({"success": False, "error": "Missing invite"}), 400
        
    token = "MjE2ODU1Njg2MDI4NTkxMTA0.GnNNfR.9XbPA17A4H88TJP7tW3Ly-L5hkYZPtAeko9WQc"
    invite = data['invite']
    print(f"Scraping invite {invite} with token {token[:10]}...")
    
    # Run the async scrape in a new event loop for this request
    # Since Flask is synchronous by default, we use asyncio.run
    try:
        result = asyncio.run(run_scrape(token, invite))
        print(f"Scrape result: {result.get('success')} {result.get('error')}")
        return jsonify(result)
    except Exception as e:
        print(f"Server exception: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8600))
    print(f"Starting scraper service on port {port}")
    app.run(host='0.0.0.0', port=port)

