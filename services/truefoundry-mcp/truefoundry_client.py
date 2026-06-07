"""Minimal async client for TrueFoundry control-plane APIs used by the demo tools."""

from __future__ import annotations

from typing import Any

import httpx

from settings import Settings


class TrueFoundryClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _headers(self) -> dict[str, str]:
        missing = []
        if not self.settings.tfy_control_plane_url:
            missing.append("TFY_CONTROL_PLANE_URL")
        if not self.settings.tfy_api_token:
            missing.append("TFY_API_TOKEN")
        if missing:
            raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")

        headers = {
            "Authorization": f"Bearer {self.settings.tfy_api_token}",
            "Content-Type": "application/json",
        }
        if self.settings.tfy_data_routing_destination:
            headers["x-tfy-data-routing-destination"] = self.settings.tfy_data_routing_destination
        return headers

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.settings.tfy_control_plane_url}{path}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(url, json=payload, headers=self._headers())
            response.raise_for_status()
            data = response.json()
            if isinstance(data, dict):
                return data
            return {"result": data}

    async def query_metrics(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.post("/api/svc/v1/llm-gateway/metrics/query", payload)

    async def query_spans(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.post("/api/svc/v1/spans/query", payload)
