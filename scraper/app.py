import os
import re
import asyncio
from flask import Flask, request, jsonify
from functools import wraps
from scrape_members import run_scrape

app = Flask(__name__)

API_KEY = os.getenv("SCRAPER_API_KEY", None)

def require_api_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if API_KEY:
            key = request.headers.get("x-api-key")
            if key != API_KEY:
                return jsonify({"success": False, "message": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated

@app.route("/scrape", methods=["POST"])
@require_api_key
def scrape():
    data = request.json or {}
    invite = data.get("invite", "").strip()
    channel_id = data.get("channel_id", "").strip() or None
    max_messages = data.get("max_messages")
    guild_id = data.get("guild_id", "").strip() or None

    if not invite and not guild_id:
        return jsonify({"success": False, "message": "invite or guild_id required"}), 400

    try:
        result = asyncio.run(run_scrape(
            invite=invite,
            guild_id=guild_id,
            channel_id=channel_id,
            max_messages=int(max_messages) if max_messages is not None else None,
        ))
        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("SCRAPER_PORT", "8600")))

