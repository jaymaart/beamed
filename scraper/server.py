import os
import sys
import json
import asyncio
from flask import Flask, request, jsonify
from threading import Thread
import discord

# Ensure unbuffered output
sys.stdout.reconfigure(encoding='utf-8')

app = Flask(__name__)

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

        guild = invite.guild
        if isinstance(guild, discord.Object):
            try:
                await invite.accept()
                await asyncio.sleep(2)
                guild = self.get_guild(invite.guild.id)
            except Exception as e:
                self.result["error"] = f"Failed to join guild: {str(e)}"
                await self.close()
                return

        if not guild:
            guild = self.get_guild(invite.guild.id)
        
        if not guild:
            self.result["error"] = f"Could not resolve guild {invite.guild.id} after join attempt"
            await self.close()
            return

        members_data = []
        try:
            for member in guild.members:
                if not member.bot:
                    members_data.append(member.id)
            
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

