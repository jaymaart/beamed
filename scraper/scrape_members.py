import discord
import asyncio
import json
import sys
import os

# Set up stdout to be unbuffered
sys.stdout.reconfigure(encoding='utf-8')

class ScraperClient(discord.Client):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.scraped_data = []
        self.target_guild = None
        
async def scrape(token, invite_code):
    client = ScraperClient()
    
    try:
        await client.login(token)
        
        # Start connection in background
        connect_task = asyncio.create_task(client.connect())
        
        # Wait for ready
        await client.wait_until_ready()
        
        # Resolve invite
        try:
            invite = await client.fetch_invite(invite_code)
        except discord.NotFound:
            print(json.dumps({"error": "Invite not found"}))
            await client.close()
            return
            
        guild = invite.guild
        if isinstance(guild, discord.Object):
            # We are not in the guild, or it's a partial object
            # Try to join
            try:
                await invite.accept()
                # Wait a bit for guild to become available in cache
                await asyncio.sleep(2)
                guild = client.get_guild(invite.guild.id)
            except Exception as e:
                print(json.dumps({"error": f"Failed to join guild: {str(e)}"}))
                await client.close()
                return

        if not guild:
            # Try to find it in cache if we were already in it
            guild = client.get_guild(invite.guild.id)
            
        if not guild:
            print(json.dumps({"error": "Could not resolve guild after join"}))
            await client.close()
            return

        members_data = []
        
        # Scrape guild members
        # discord.py-self allows fetching members
        try:
            # This might take a while for large servers
            if not guild.chunked:
                await guild.chunk()
            
            for member in guild.members:
                members_data.append(member.id)
                
        except Exception as e:
                print(json.dumps({"error": f"Member scrape failed: {str(e)}"}))
                await client.close()
                return

        # Output result
        print(json.dumps({
            "success": True,
            "guild_id": str(guild.id),
            "members": members_data,
            "count": len(members_data)
        }))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))
    finally:
        await client.close()
        # Ensure the loop stops
        if not connect_task.done():
            connect_task.cancel()

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python scrape_members.py <token> <invite_code>"}), file=sys.stderr)
        sys.exit(1)
        
    token = sys.argv[1]
    invite_code = sys.argv[2]
    
    asyncio.run(scrape(token, invite_code))
