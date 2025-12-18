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
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.scrape_result = None
        self.scrape_error = None
        self.target_invite = None

    async def on_ready(self):
        # We handle the logic in the scrape task, but need on_ready to fire
        pass

async def run_scrape(token, invite_code):
    client = ScraperClient()
    result = {"success": False}
    
    try:
        # We need to run the client in a way that allows us to execute our logic
        # Since client.start() blocks, we'll wrap the logic in a task that waits for ready
        
        async def scrape_logic():
            await client.wait_until_ready()
            
            try:
                invite = await client.fetch_invite(invite_code)
            except discord.NotFound:
                result["error"] = "Invite not found"
                await client.close()
                return

            guild = invite.guild
            if isinstance(guild, discord.Object):
                try:
                    await invite.accept()
                    await asyncio.sleep(2)
                    guild = client.get_guild(invite.guild.id)
                except Exception as e:
                    result["error"] = f"Failed to join guild: {str(e)}"
                    await client.close()
                    return

            if not guild:
                guild = client.get_guild(invite.guild.id)
            
            if not guild:
                result["error"] = "Could not resolve guild after join"
                await client.close()
                return

            members_data = []
            try:
                if not guild.chunked:
                    await guild.chunk()
                
                for member in guild.members:
                    members_data.append(member.id)
                    
                result["success"] = True
                result["guild_id"] = str(guild.id)
                result["members"] = members_data
                result["count"] = len(members_data)
                
            except Exception as e:
                result["error"] = f"Member scrape failed: {str(e)}"
            
            await client.close()

        # Create the logic task
        client.loop.create_task(scrape_logic())
        
        # Start the client (blocks until closed)
        await client.start(token)
        
    except Exception as e:
        if not result.get("error"):
            result["error"] = str(e)
            
    return result

@app.route('/scrape', methods=['POST'])
def handle_scrape():
    data = request.json
    if not data or 'token' not in data or 'invite' not in data:
        return jsonify({"success": False, "error": "Missing token or invite"}), 400
        
    token = data['token']
    invite = data['invite']
    
    # Run the async scrape in a new event loop for this request
    # Since Flask is synchronous by default, we use asyncio.run
    try:
        result = asyncio.run(run_scrape(token, invite))
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8600))
    print(f"Starting scraper service on port {port}")
    app.run(host='0.0.0.0', port=port)

