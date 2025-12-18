import os
import sys
import asyncio
import json
import re
import requests
import discord
from discord.ext import commands

# Env
API_BASE = os.getenv("API_BASE", "http://localhost:8000").rstrip("/")
DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "")
DEFAULT_MAX_MESSAGES = int(os.getenv("SCRAPE_MAX_MESSAGES", "5000"))

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

intents = discord.Intents.default()
intents.members = True
intents.guilds = True
intents.presences = False
intents.messages = True
intents.message_content = True

def upload_members(members, guild_id=None):
    if not members:
        return
    resp = requests.post(
        f"{API_BASE}/api/dm/user/members",
        headers={"Content-Type": "application/json"},
        json={"members": list(members), "guild_id": guild_id},
        timeout=60
    )
    data = resp.json()
    if not resp.ok or data.get("success") is False:
        raise RuntimeError(f"Upload failed: {data.get('message')}")

async def run_scrape(invite: str = "", guild_id: str = "", channel_id: str = "", max_messages: int = None):
    DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "")
    if not DISCORD_TOKEN:
        raise RuntimeError("DISCORD_TOKEN env required")

    if max_messages is None:
        max_messages = DEFAULT_MAX_MESSAGES

    member_ids = set()

    bot = commands.Bot(command_prefix="?", self_bot=True, intents=intents)

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    async def ensure_join():
        if invite:
            code = invite
            code = re.sub(r"^https?://(www\.)?discord\.gg/", "", code, flags=re.I)
            code = re.sub(r"^https?://discord\.com/invite/", "", code, flags=re.I).strip()
            invite_obj = await bot.fetch_invite(code)
            try:
                await invite_obj.accept()
            except discord.HTTPException:
                pass

    async def scrape_channel(channel: discord.TextChannel):
        count = 0
        async for msg in channel.history(limit=max_messages):
            member_ids.add(str(msg.author.id))
            count += 1
            if count >= max_messages:
                break

    async def scrape_guild(target_guild: discord.Guild):
        if channel_id:
            try:
                ch = await bot.fetch_channel(int(channel_id))
                await scrape_channel(ch)
            except Exception as e:
                print(f"[SCRAPE] Failed channel scrape: {e}")
        else:
            try:
                async for m in target_guild.fetch_members(limit=None):
                    member_ids.add(str(m.id))
            except Exception as e:
                print(f"[SCRAPE] Member fetch failed: {e}")

    @bot.event
    async def on_ready():
        try:
            if invite:
                await ensure_join()
            target_guild = None
            if guild_id:
                try:
                    target_guild = await bot.fetch_guild(int(guild_id))
                except Exception as e:
                    print(f"[SCRAPE] Failed to fetch guild {guild_id}: {e}")
            if not target_guild:
                if not bot.guilds:
                    print("[SCRAPE] No guilds available on this token.")
                    await bot.close()
                    return
                target_guild = bot.guilds[0]
            await scrape_guild(target_guild)
            if member_ids:
                print(f"[SCRAPE] Scraped {len(member_ids)} members, uploading...")
                upload_members(member_ids, guild_id=str(target_guild.id))
                print("[SCRAPE] Upload complete.")
            else:
                print("[SCRAPE] No members collected.")
        finally:
            await bot.close()

    bot.run(DISCORD_TOKEN, log_handler=None, log_level=discord.logging.CRITICAL)
    return {"count": len(member_ids)}

if __name__ == "__main__":
    asyncio.run(run_scrape())

