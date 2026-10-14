# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient


async def _preflight(client: AsyncClient, origin: str):
    return await client.options("/api/projects", headers={
        "Origin": origin, "Access-Control-Request-Method": "GET",
    })


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [
    "http://localhost:5173",
    "http://192.168.2.13:5173",
    "http://10.0.0.5",
    "http://172.20.1.4:5173",
    "http://server-hiway:5173",
    "http://hiplan.local",
])
async def test_cors_allows_local_network(client: AsyncClient, origin: str):
    res = await _preflight(client, origin)
    assert res.headers.get("access-control-allow-origin") == origin


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [
    "https://evil.example.com",
    "http://192.168.1.10.evil.com",
    "http://172.32.0.1",
    "http://localhost.attacker.io",
])
async def test_cors_rejects_external_sites(client: AsyncClient, origin: str):
    res = await _preflight(client, origin)
    assert res.headers.get("access-control-allow-origin") != origin
