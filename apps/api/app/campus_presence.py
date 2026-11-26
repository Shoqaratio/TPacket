"""Redis presence leases and short-lived campus messages."""
import json
from uuid import uuid4

from redis import Redis as SyncRedis
from redis.asyncio import Redis


# Resolve races between a reconnect and the older connection's next write or disconnect.
LEASE = """
local old = redis.call('HGET', KEYS[1], ARGV[1])
local mode, uid, token, row = ARGV[2], ARGV[1], ARGV[3], ARGV[4]
local second = tonumber(redis.call('TIME')[1])
if mode ~= 'join' and (not old or cjson.decode(old).token ~= token) then return false end
redis.call('HSET', KEYS[1], uid, cjson.encode({
    token=token, player=cjson.decode(row), expires=second + 12, active=mode ~= 'leave'
}))
redis.call('ZADD', KEYS[2], second + 12, uid)
redis.call('EXPIRE', KEYS[1], 30)
redis.call('EXPIRE', KEYS[2], 30)
if mode == 'join' then
    if old and cjson.decode(old).expires > second then return old end
    return ''
end
return 'ok'
"""
SNAPSHOT = """
local second = tonumber(redis.call('TIME')[1])
for _, uid in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', second)) do
    redis.call('HDEL', KEYS[1], uid)
    redis.call('ZREM', KEYS[2], uid)
end
return redis.call('HVALS', KEYS[1])
"""


def remote_player(url: str, cid: str, uid: str) -> dict | None:
    with SyncRedis.from_url(url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2) as redis:
        raw = redis.hget(f"tpacket:campus:{{{cid}}}:rows", uid)
        if raw:
            row = json.loads(raw)
            if row["active"] and row["expires"] > redis.time()[0]:
                return row["player"]
    return None


class SharedPresence:
    def __init__(self, url: str, cid: str, uid: str):
        self.redis = Redis.from_url(url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2)
        room = f"tpacket:campus:{{{cid}}}"
        self.rows, self.expiry, self.channel = f"{room}:rows", f"{room}:expiry", f"{room}:events"
        self.uid, self.token = uid, uuid4().hex
        self.subscription = self.redis.pubsub()

    async def write(self, mode: str, player: dict):
        return await self.redis.eval(LEASE, 2, self.rows, self.expiry, self.uid, mode, self.token, json.dumps(player))

    async def snapshot(self) -> list[dict]:
        records = await self.redis.eval(SNAPSHOT, 2, self.rows, self.expiry)
        rows = [json.loads(record) for record in records]
        return [row["player"] for row in rows if row["active"]]

    async def publish(self, event: dict):
        await self.redis.publish(self.channel, json.dumps(event))

    async def events(self) -> list[dict]:
        events = []
        for _ in range(32):
            record = await self.subscription.get_message(timeout=0)
            if record is None:
                break
            if record["type"] == "message":
                events.append(json.loads(record["data"]))
        return events

    async def close(self):
        await self.subscription.aclose()
        await self.redis.aclose()
